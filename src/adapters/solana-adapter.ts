import {
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type AccountMeta,
  type Keypair,
} from "@solana/web3.js";
import { isUuidV4, uuidToBytes } from "../engine/ids.ts";
import type { Match } from "../engine/types.ts";
import {
  SYSTEM_PROGRAM_ID,
  associatedTokenAddress,
  decodeConfig,
  decodeListing,
  isTokenProgram,
  pdas,
} from "../solana/accounts.ts";
import { concat, encodeFields } from "../solana/borsh.ts";
import { SettlementFailure, isTransientRpcError, mapTransactionError } from "../solana/errors.ts";
import { PROGRAM_ID, idlInstruction } from "../solana/idl.ts";
import { assertDevnet, type SolanaRpc } from "../solana/rpc.ts";
import type { SettleOutcome, SettlementAdapter } from "./settlement-adapter.ts";

/**
 * Solana DEVNET settlement adapter: `niara_exchange::settle`, built from the IDL.
 * TESTNET ONLY.
 *
 * For each match:
 * 1. If the replay guard `["settled", match_id]` already exists, the match is settled:
 *    nothing is sent, and the transaction that created the record is returned.
 * 2. The settle transaction is built (instruction data and account order from the IDL;
 *    `match_id` = the 16 bytes of the match UUID), signed by the settlement operator,
 *    and SIMULATED. A failed simulation is never sent.
 * 3. It is sent once (no RPC-side retries) and confirmed. A retry after an ambiguous
 *    failure starts again at step 1, so the same match is never settled twice (and the
 *    program's `init` of the record would refuse it anyway).
 *
 * Token accounts: the parties' associated token accounts for each mint's token program.
 */

export interface SolanaAdapterOptions {
  rpc: SolanaRpc;
  /** The settlement operator (Config.settlement_operator); pays fee and record rent. */
  operator: Keypair;
  programId?: PublicKey;
}

const SETTLE = idlInstruction("settle");

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class SolanaSettlementAdapter implements SettlementAdapter {
  readonly chain = "solana-devnet" as const;
  private readonly rpc: SolanaRpc;
  private readonly operator: Keypair;
  private readonly programId: PublicKey;
  private readonly pda: ReturnType<typeof pdas>;

  private constructor(options: SolanaAdapterOptions) {
    this.rpc = options.rpc;
    this.operator = options.operator;
    this.programId = options.programId ?? PROGRAM_ID;
    this.pda = pdas(this.programId);
  }

  /** Checks the cluster is devnet and the operator is the program's settlement operator. */
  static async create(options: SolanaAdapterOptions): Promise<SolanaSettlementAdapter> {
    await assertDevnet(options.rpc);
    const adapter = new SolanaSettlementAdapter(options);
    const config = await adapter.readConfig();
    if (!config.settlementOperator.equals(options.operator.publicKey)) {
      throw new SettlementFailure(
        "precondition",
        `the operator key is not the program's settlement operator (${config.settlementOperator.toBase58()})`,
      );
    }
    return adapter;
  }

  get operatorPublicKey(): PublicKey {
    return this.operator.publicKey;
  }

  async isListed(asset: string): Promise<boolean> {
    const [account] = await this.rpc.getAccounts([this.pda.listing(new PublicKey(asset))]);
    if (!account || !account.owner.equals(this.programId)) return false;
    const listing = decodeListing(account.data);
    return listing.status === "Approved" && listing.assetClass === "Equity";
  }

  async settle(match: Match): Promise<SettleOutcome> {
    if (match.chain !== this.chain) throw new SettlementFailure("precondition", `match is on ${match.chain}, not solana-devnet`);
    if (!isUuidV4(match.id)) throw new SettlementFailure("precondition", `match id is not a UUID v4: ${match.id}`);
    const matchId = uuidToBytes(match.id);
    const record = this.pda.settlementRecord(matchId);

    // 1. Replay guard first: an existing record means settled; send nothing.
    if (await this.rpcCall(async () => (await this.rpc.getAccounts([record]))[0] !== null)) {
      return { txHash: await this.settleTransactionOf(record), alreadySettled: true };
    }

    // 2. Build, sign, simulate.
    const tx = await this.buildSettle(match, matchId, record);
    const sim = await this.rpcCall(() => this.rpc.simulate(tx.transaction));
    if (sim.err) {
      const failure = mapTransactionError(sim.err, sim.logs);
      if (failure === "already_settled") return { txHash: await this.settleTransactionOf(record), alreadySettled: true };
      throw failure;
    }

    // 3. Send once, confirm.
    const signature = await this.rpcCall(() => this.rpc.send(tx.transaction));
    const confirmation = await this.rpcCall(() => this.rpc.confirm(signature, tx.blockhash, tx.lastValidBlockHeight));
    if (confirmation.err) {
      const failure = mapTransactionError(confirmation.err, []);
      if (failure === "already_settled") return { txHash: await this.settleTransactionOf(record), alreadySettled: true };
      throw failure;
    }
    return { txHash: signature, alreadySettled: false };
  }

  private async readConfig() {
    const [account] = await this.rpcCall(() => this.rpc.getAccounts([this.pda.config()]));
    if (!account || !account.owner.equals(this.programId)) {
      throw new SettlementFailure("precondition", "the program has no Config account");
    }
    return decodeConfig(account.data);
  }

  /** The transaction that created a settlement record: its oldest successful signature. */
  private async settleTransactionOf(record: PublicKey): Promise<string> {
    const signatures = await this.rpcCall(() => this.rpc.getSignaturesForAddress(record, 1000));
    const ok = signatures.filter((s) => s.err === null);
    const oldest = ok[ok.length - 1];
    if (!oldest) {
      throw new SettlementFailure("transient", "the settlement record exists but its transaction is not indexed yet");
    }
    return oldest.signature;
  }

  private async buildSettle(match: Match, matchId: Uint8Array, record: PublicKey) {
    const config = await this.readConfig();
    if (config.paused) throw new SettlementFailure("transient", "the protocol is paused (Config.paused)");
    if (!config.settlementOperator.equals(this.operator.publicKey)) {
      throw new SettlementFailure("precondition", "the operator key is no longer the program's settlement operator");
    }
    const assetMint = new PublicKey(match.asset);
    const paymentMint = new PublicKey(match.paymentAsset);
    if (!config.feeMint.equals(paymentMint)) {
      throw new SettlementFailure("precondition", `payment asset ${match.paymentAsset} is not the fee mint (USDT)`);
    }
    const [assetMintAccount, paymentMintAccount] = await this.rpcCall(() => this.rpc.getAccounts([assetMint, paymentMint]));
    if (!assetMintAccount || !isTokenProgram(assetMintAccount.owner)) {
      throw new SettlementFailure("precondition", `asset mint ${match.asset} not found`);
    }
    if (!paymentMintAccount || !isTokenProgram(paymentMintAccount.owner)) {
      throw new SettlementFailure("precondition", `payment mint ${match.paymentAsset} not found`);
    }
    const assetTokenProgram = assetMintAccount.owner;
    const paymentTokenProgram = paymentMintAccount.owner;
    const seller = new PublicKey(match.seller);
    const buyer = new PublicKey(match.buyer);
    const assetListing = this.pda.listing(assetMint);

    const accounts: Record<string, PublicKey> = {
      settlement_operator: this.operator.publicKey,
      config: this.pda.config(),
      asset_listing: assetListing,
      payment_listing: this.pda.listing(paymentMint),
      asset_mint: assetMint,
      payment_mint: paymentMint,
      seller,
      buyer,
      seller_asset_account: associatedTokenAddress(assetMint, seller, assetTokenProgram),
      buyer_asset_account: associatedTokenAddress(assetMint, buyer, assetTokenProgram),
      buyer_payment_account: associatedTokenAddress(paymentMint, buyer, paymentTokenProgram),
      seller_payment_account: associatedTokenAddress(paymentMint, seller, paymentTokenProgram),
      vault_authority: this.pda.vaultAuthority(),
      fee_ledger: this.pda.feeLedger(paymentMint),
      fee_vault: this.pda.feeVault(paymentMint),
      cashback_ledger: this.pda.cashbackLedger(assetListing, paymentMint),
      settlement_record: record,
      asset_token_program: assetTokenProgram,
      payment_token_program: paymentTokenProgram,
      system_program: SYSTEM_PROGRAM_ID,
      event_authority: this.pda.eventAuthority(),
      program: this.programId,
    };
    const keys: AccountMeta[] = SETTLE.accounts.map((a) => {
      const pubkey = accounts[a.name];
      if (!pubkey) throw new Error(`settle: no value for IDL account ${a.name}`);
      if (a.address && a.address !== pubkey.toBase58()) throw new Error(`settle: ${a.name} must be ${a.address}`);
      return { pubkey, isSigner: a.signer === true, isWritable: a.writable === true };
    });
    let data: Uint8Array;
    try {
      data = concat([
        Uint8Array.from(SETTLE.discriminator),
        encodeFields(SETTLE.args, { match_id: matchId, asset_amount: match.quantity, payment_amount: match.paymentAmount }),
      ]);
    } catch (e) {
      throw new SettlementFailure("precondition", `settle arguments out of range: ${errorText(e)}`);
    }
    const instruction = new TransactionInstruction({ programId: this.programId, keys, data: Buffer.from(data) });
    const { blockhash, lastValidBlockHeight } = await this.rpcCall(() => this.rpc.getLatestBlockhash());
    const message = new TransactionMessage({
      payerKey: this.operator.publicKey,
      recentBlockhash: blockhash,
      instructions: [instruction],
    }).compileToV0Message();
    const transaction = new VersionedTransaction(message);
    transaction.sign([this.operator]);
    return { transaction, blockhash, lastValidBlockHeight };
  }

  /**
   * RPC exceptions become transient SettlementFailures: the worker retries them with a
   * bounded backoff (known rate limits and timeouts, and unknown RPC errors alike).
   * Only the chain's own refusals and setup problems are permanent.
   */
  private async rpcCall<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof SettlementFailure) throw e;
      const label = isTransientRpcError(e) ? "RPC" : "RPC (unclassified)";
      throw new SettlementFailure("transient", `${label}: ${errorText(e)}`);
    }
  }
}
