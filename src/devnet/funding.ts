import { PublicKey, SystemProgram, type TransactionInstruction } from "@solana/web3.js";
import { associatedTokenAddress } from "../solana/accounts.ts";
import { createAssociatedTokenAccountIdempotent, transferChecked } from "../solana/token-instructions.ts";

/**
 * Funding a browser tester's wallet on Solana DEVNET with test tokens from the demo
 * wallets (scripts/fund-tester.ts). Pure: builds and checks the instructions; the
 * script reads the chain, simulates and sends. TESTNET ONLY: devnet SOL and test mints.
 */

/** Upper bounds per run, so a typo cannot drain the demo wallets. */
export const FUNDING_CAPS = { lamports: 1_000_000_000n, usdtWhole: 10_000n, assetWhole: 100n } as const;

/** Rent of a token account plus fees, kept back in the funder on top of the SOL sent. */
export const FUNDER_RESERVE_LAMPORTS = 20_000_000n; // 0.02 SOL

export interface MintInfo {
  mint: PublicKey;
  tokenProgram: PublicKey;
  decimals: number;
}

export interface FundingRequest {
  tester: PublicKey;
  /** Pays the fees, the rent of the new token accounts, and the SOL. */
  funder: PublicKey;
  /** The demo wallet the tokens come from. */
  source: PublicKey;
  usdt: MintInfo;
  asset: MintInfo;
  lamports: bigint;
  usdtAmount: bigint;
  assetAmount: bigint;
  /** Addresses that must never be the tester (the demo and operator keys). */
  forbidden: readonly PublicKey[];
}

export class FundingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FundingError";
  }
}

/** Refuses a tester that is off the ed25519 curve (a PDA: nobody could sign for it) or one of our own keys, and amounts out of bounds. */
export function checkFundingRequest(r: FundingRequest): void {
  if (!PublicKey.isOnCurve(r.tester.toBytes())) throw new FundingError(`${r.tester.toBase58()} is not a wallet address (off curve)`);
  if (r.forbidden.some((k) => k.equals(r.tester))) throw new FundingError("the tester address is one of the demo or operator keys");
  const cap = (whole: bigint, decimals: number) => whole * 10n ** BigInt(decimals);
  if (r.lamports <= 0n || r.lamports > FUNDING_CAPS.lamports) throw new FundingError("SOL must be more than 0 and at most 1");
  if (r.usdtAmount <= 0n || r.usdtAmount > cap(FUNDING_CAPS.usdtWhole, r.usdt.decimals)) {
    throw new FundingError(`mockUSDT must be more than 0 and at most ${FUNDING_CAPS.usdtWhole}`);
  }
  if (r.assetAmount <= 0n || r.assetAmount > cap(FUNDING_CAPS.assetWhole, r.asset.decimals)) {
    throw new FundingError(`tEQTY must be more than 0 and at most ${FUNDING_CAPS.assetWhole}`);
  }
}

/** The source's token accounts, the tester's (created if needed), and the funding instructions in order. */
export function fundingInstructions(r: FundingRequest): {
  instructions: TransactionInstruction[];
  accounts: { sourceUsdt: PublicKey; sourceAsset: PublicKey; testerUsdt: PublicKey; testerAsset: PublicKey };
} {
  checkFundingRequest(r);
  const usdtAta = createAssociatedTokenAccountIdempotent({ payer: r.funder, owner: r.tester, mint: r.usdt.mint, tokenProgram: r.usdt.tokenProgram });
  const assetAta = createAssociatedTokenAccountIdempotent({ payer: r.funder, owner: r.tester, mint: r.asset.mint, tokenProgram: r.asset.tokenProgram });
  const sourceUsdt = associatedTokenAddress(r.usdt.mint, r.source, r.usdt.tokenProgram);
  const sourceAsset = associatedTokenAddress(r.asset.mint, r.source, r.asset.tokenProgram);
  return {
    accounts: { sourceUsdt, sourceAsset, testerUsdt: usdtAta.address, testerAsset: assetAta.address },
    instructions: [
      SystemProgram.transfer({ fromPubkey: r.funder, toPubkey: r.tester, lamports: r.lamports }),
      usdtAta.instruction,
      assetAta.instruction,
      transferChecked({
        tokenProgram: r.usdt.tokenProgram,
        source: sourceUsdt,
        mint: r.usdt.mint,
        destination: usdtAta.address,
        owner: r.source,
        amount: r.usdtAmount,
        decimals: r.usdt.decimals,
      }),
      transferChecked({
        tokenProgram: r.asset.tokenProgram,
        source: sourceAsset,
        mint: r.asset.mint,
        destination: assetAta.address,
        owner: r.source,
        amount: r.assetAmount,
        decimals: r.asset.decimals,
      }),
    ],
  };
}

/** Refuses when the funder or the source cannot cover the request (balances read on-chain). */
export function checkFundingBalances(
  r: FundingRequest,
  balances: { funderLamports: bigint; sourceUsdt: bigint | null; sourceAsset: bigint | null },
): void {
  if (balances.funderLamports < r.lamports + FUNDER_RESERVE_LAMPORTS) {
    throw new FundingError(`the demo funder holds ${balances.funderLamports} lamports; it needs ${r.lamports + FUNDER_RESERVE_LAMPORTS} (SOL sent + 0.02 reserve)`);
  }
  if (balances.sourceUsdt === null || balances.sourceUsdt < r.usdtAmount) {
    throw new FundingError(`the source wallet holds ${balances.sourceUsdt ?? "no"} mockUSDT base units; ${r.usdtAmount} needed`);
  }
  if (balances.sourceAsset === null || balances.sourceAsset < r.assetAmount) {
    throw new FundingError(`the source wallet holds ${balances.sourceAsset ?? "no"} tEQTY base units; ${r.assetAmount} needed`);
  }
}
