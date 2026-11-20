import {
  decodeEventLog,
  encodeFunctionData,
  getAddress,
  isAddressEqual,
  toEventSelector,
  type Address,
  type Hex,
  type LocalAccount,
  type Log,
} from "viem";
import { isUuidV4 } from "../engine/ids.ts";
import type { Match } from "../engine/types.ts";
import { LISTING_REGISTRY_ABI } from "../evm/abi/ListingRegistry.ts";
import { NATIVE_ASSET_TOKEN_ABI } from "../evm/abi/NativeAssetToken.ts";
import { NIARA_SETTLEMENT_ABI } from "../evm/abi/NiaraSettlement.ts";
import type { EvmClient } from "../evm/client.ts";
import { SETTLE_ABI, mapEvmError } from "../evm/errors.ts";
import { findLogBackward } from "../evm/logs.ts";
import type { DeployedEvmChain } from "../evm/settings.ts";
import { SettlementFailure } from "./failure.ts";
import type { SettleOutcome, SettlementAdapter } from "./settlement-adapter.ts";

/**
 * EVM TESTNET settlement adapter: `NiaraSettlement.settle` on Base Sepolia, Robinhood
 * Chain testnet and Tempo testnet (HyperEVM once deployed). TESTNET ONLY.
 *
 * For each match:
 * 1. Replay guard first: if `settledMatches(matchId)` is true the match is settled;
 *    nothing is sent, and the transaction that emitted its `Settled` event is returned.
 *    A transaction this adapter sent earlier for the match and that is still pending is
 *    waited for, never sent again.
 * 2. `settle` is SIMULATED (`eth_call` from the operator). A failed simulation is never
 *    sent; its custom error is decoded (contract or token).
 * 3. Gas: the node's estimate x the chain's multiplier, refused above the chain's
 *    per-transaction cap; fees per the chain's pricing (EIP-1559, Tempo with its fee
 *    token, or legacy); the operator must be able to pay gas limit x max fee.
 * 4. The transaction is signed locally (the operator's key never leaves the process),
 *    sent once, and its receipt awaited. A timeout is transient; the next try starts at 1.
 *
 * `matchId` is the match UUID's 16 bytes (`bytes16`, as NiaraSettlement declares it).
 */

export interface EvmAdapterOptions {
  client: EvmClient;
  settings: DeployedEvmChain;
  /** The settlement operator (SETTLEMENT_OPERATOR_ROLE), decrypted from its keystore. */
  operator: LocalAccount;
  receiptTimeoutMs?: number;
  receiptPollMs?: number;
  /** Blocks per eth_getLogs query when looking for a Settled event. */
  logChunk?: bigint;
}

/** Tempo prices gas in attodollars (1e-18 USD); its fee tokens have 6 decimals. */
const ATTODOLLARS_PER_FEE_UNIT = 10n ** 12n;

const LISTING_APPROVED = 2;
const EQUITY = 0;

const SETTLED_TOPIC = toEventSelector(
  "Settled(bytes16,address,address,address,address,uint256,uint256,uint256)",
);

export function matchIdBytes16(id: string): Hex {
  if (!isUuidV4(id)) throw new SettlementFailure("precondition", `match id is not a UUID v4: ${id}`);
  return `0x${id.replaceAll("-", "").toLowerCase()}`;
}

const pad32 = (a: Address): Hex => `0x${a.slice(2).toLowerCase().padStart(64, "0")}`;

export class EvmSettlementAdapter implements SettlementAdapter {
  readonly chain: DeployedEvmChain["chain"];
  private readonly client: EvmClient;
  private readonly s: DeployedEvmChain;
  private readonly operator: LocalAccount;
  private readonly receiptTimeoutMs: number;
  private readonly receiptPollMs: number;
  private readonly logChunk: bigint;
  /** Transactions sent for a match whose outcome is not known yet. */
  private readonly inflight = new Map<string, Hex>();

  private constructor(o: EvmAdapterOptions) {
    this.client = o.client;
    this.s = o.settings;
    this.chain = o.settings.chain;
    this.operator = o.operator;
    this.receiptTimeoutMs = o.receiptTimeoutMs ?? 120_000;
    this.receiptPollMs = o.receiptPollMs ?? 2_000;
    this.logChunk = o.logChunk ?? 10_000n;
  }

  /**
   * Checks, read-only, that the configured contracts are the deployed ones and the key
   * is the operator: NiaraSettlement's fee token, registry and distributor equal the
   * config, and the key holds SETTLEMENT_OPERATOR_ROLE and is the configured operator.
   */
  static async create(o: EvmAdapterOptions): Promise<EvmSettlementAdapter> {
    const a = new EvmSettlementAdapter(o);
    const s = o.settings;
    if (!isAddressEqual(o.operator.address, s.operator)) {
      throw new SettlementFailure("precondition", `the operator key is ${o.operator.address}, not the configured operator ${s.operator}`);
    }
    const settlement = s.contracts.settlement;
    const read = <F extends "feeToken" | "listingRegistry" | "cashbackDistributor" | "SETTLEMENT_OPERATOR_ROLE">(functionName: F) =>
      a.call(() => o.client.readContract({ address: settlement, abi: NIARA_SETTLEMENT_ABI, functionName }));
    const [feeToken, registry, distributor, role] = await Promise.all([
      read("feeToken"),
      read("listingRegistry"),
      read("cashbackDistributor"),
      read("SETTLEMENT_OPERATOR_ROLE"),
    ]);
    const mismatch = (what: string, onChain: string, configured: string) =>
      new SettlementFailure("precondition", `${s.chain}: NiaraSettlement.${what} is ${onChain}, the config says ${configured}`);
    if (!isAddressEqual(feeToken as Address, s.quoteAsset)) throw mismatch("feeToken", feeToken as string, s.quoteAsset);
    if (!isAddressEqual(registry as Address, s.contracts.listingRegistry)) throw mismatch("listingRegistry", registry as string, s.contracts.listingRegistry);
    if (!isAddressEqual(distributor as Address, s.contracts.cashbackDistributor)) {
      throw mismatch("cashbackDistributor", distributor as string, s.contracts.cashbackDistributor);
    }
    const hasRole = await a.call(() =>
      o.client.readContract({ address: settlement, abi: NIARA_SETTLEMENT_ABI, functionName: "hasRole", args: [role as Hex, o.operator.address] }),
    );
    if (!hasRole) throw new SettlementFailure("precondition", `${o.operator.address} does not hold SETTLEMENT_OPERATOR_ROLE on ${s.chain}`);
    return a;
  }

  get operatorAddress(): Address {
    return this.operator.address;
  }

  async isListed(asset: string): Promise<boolean> {
    const l = await this.call(() =>
      this.client.readContract({
        address: this.s.contracts.listingRegistry,
        abi: LISTING_REGISTRY_ABI,
        functionName: "getListing",
        args: [getAddress(asset)],
      }),
    );
    return l.status === LISTING_APPROVED && l.assetClass === EQUITY;
  }

  async findSettlement(match: Match): Promise<string | null> {
    const id = matchIdBytes16(match.id);
    return (await this.isSettled(id)) ? this.settleTransactionOf(match, id) : null;
  }

  async settle(match: Match): Promise<SettleOutcome> {
    if (match.chain !== this.chain) throw new SettlementFailure("precondition", `match is on ${match.chain}, not ${this.chain}`);
    const id = matchIdBytes16(match.id);
    if (!isAddressEqual(getAddress(match.paymentAsset), this.s.quoteAsset)) {
      throw new SettlementFailure("precondition", `payment asset ${match.paymentAsset} is not NiaraSettlement.feeToken (mock USDT)`);
    }

    // 1. A transaction already sent for this match: its outcome first.
    const pending = await this.resolveInflight(match);
    if (pending) return pending;
    if (await this.isSettled(id)) return { txHash: await this.settleTransactionOf(match, id), alreadySettled: true };

    // 2. Simulate.
    const args = [
      id,
      getAddress(match.asset),
      this.s.quoteAsset,
      getAddress(match.buyer),
      getAddress(match.seller),
      match.quantity,
      match.paymentAmount,
    ] as const;
    const call = { address: this.s.contracts.settlement, abi: SETTLE_ABI, functionName: "settle", args, account: this.operator.address } as const;
    try {
      await this.client.simulateContract(call);
    } catch (e) {
      const f = mapEvmError(e);
      if (f === "already_settled") return { txHash: await this.settleTransactionOf(match, id), alreadySettled: true };
      throw f;
    }

    // 3. Gas, fees, funds.
    const tx = await this.prepare(call, args);

    // 4. Sign, send once, await the receipt.
    const serializer = this.client.chain.serializers?.transaction;
    const raw = await this.operator.signTransaction(tx as never, serializer ? { serializer: serializer as never } : undefined);
    const hash = await this.call(() => this.client.sendRawTransaction({ serializedTransaction: raw }));
    this.inflight.set(match.id, hash);
    return this.outcome(match, id, hash);
  }

  /** The gas limit, fees and nonce of the settle transaction; refuses what the operator cannot pay. */
  private async prepare(call: { address: Address; abi: typeof SETTLE_ABI; functionName: "settle"; args: readonly unknown[]; account: Address }, args: readonly unknown[]) {
    const g = this.s.gas;
    const estimate = await this.call(() => this.client.estimateContractGas(call as never));
    const gas = (estimate * BigInt(g.multiplierPct) + 99n) / 100n;
    if (g.maxGasPerTx !== null && gas > g.maxGasPerTx) {
      throw new SettlementFailure("precondition", `settle needs ${gas} gas, above ${this.chain}'s per-transaction cap ${g.maxGasPerTx}`);
    }
    const nonce = await this.call(() => this.client.getTransactionCount({ address: this.operator.address, blockTag: "pending" }));
    const data = encodeFunctionData({ abi: SETTLE_ABI, functionName: "settle", args: args as never });
    const base = { chainId: this.s.evmChainId, to: this.s.contracts.settlement, data, gas, nonce, value: 0n };

    let maxFee: bigint;
    let tx: Record<string, unknown>;
    if (g.pricing === "legacy") {
      const gasPrice = await this.call(() => this.client.getGasPrice());
      maxFee = gasPrice;
      tx = { ...base, type: "legacy", gasPrice };
    } else {
      const fees = await this.call(() => this.client.estimateFeesPerGas());
      maxFee = fees.maxFeePerGas;
      tx = { ...base, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas };
      tx = g.pricing === "tempo" ? { ...tx, feeToken: g.feeToken } : { ...tx, type: "eip1559" };
    }

    const cost = gas * maxFee;
    if (g.pricing === "tempo") {
      const balance = await this.call(() =>
        this.client.readContract({ address: g.feeToken!, abi: NATIVE_ASSET_TOKEN_ABI, functionName: "balanceOf", args: [this.operator.address] }),
      );
      const needed = (cost + ATTODOLLARS_PER_FEE_UNIT - 1n) / ATTODOLLARS_PER_FEE_UNIT;
      if (balance < needed) {
        throw new SettlementFailure("operator_funds", `the operator holds ${balance} of fee token ${g.feeToken} base units; settle may cost up to ${needed}`);
      }
    } else {
      const balance = await this.call(() => this.client.getBalance({ address: this.operator.address }));
      if (balance < cost) {
        throw new SettlementFailure("operator_funds", `the operator holds ${balance} wei; settle may cost up to ${cost} (gas ${gas} x max fee ${maxFee})`);
      }
    }
    return tx;
  }

  /** Waits for a sent transaction. Unknown after the timeout: transient (it stays in flight). */
  private async outcome(match: Match, id: Hex, hash: Hex): Promise<SettleOutcome> {
    let receipt;
    try {
      receipt = await this.client.waitForTransactionReceipt({ hash, timeout: this.receiptTimeoutMs, pollingInterval: this.receiptPollMs, retryCount: 0 });
    } catch (e) {
      throw new SettlementFailure("transient", `settle transaction ${hash} not confirmed yet (${e instanceof Error ? e.name : "error"})`);
    }
    this.inflight.delete(match.id);
    if (receipt.status === "success") return { txHash: hash, alreadySettled: false };
    // Reverted on-chain after a passing simulation: another settlement may have landed first.
    if (await this.isSettled(id)) return { txHash: await this.settleTransactionOf(match, id), alreadySettled: true };
    throw new SettlementFailure("program", `settle transaction ${hash} reverted on-chain`);
  }

  /** A transaction sent earlier for `match`: its outcome if known; throws transient while pending. */
  private async resolveInflight(match: Match): Promise<SettleOutcome | null> {
    const hash = this.inflight.get(match.id);
    if (!hash) return null;
    const receipt = await this.call(() => this.client.getTransactionReceipt({ hash }).catch(() => null));
    if (receipt) {
      this.inflight.delete(match.id);
      if (receipt.status === "success") return { txHash: hash, alreadySettled: false };
      return null; // reverted: decide again from the replay guard and a fresh simulation
    }
    const tx = await this.call(() => this.client.getTransaction({ hash }).catch(() => null));
    if (tx) throw new SettlementFailure("transient", `settle transaction ${hash} is still pending`);
    this.inflight.delete(match.id); // dropped by the node: never mined
    return null;
  }

  private async isSettled(id: Hex): Promise<boolean> {
    return this.call(() =>
      this.client.readContract({ address: this.s.contracts.settlement, abi: NIARA_SETTLEMENT_ABI, functionName: "settledMatches", args: [id] }),
    );
  }

  /** The transaction that emitted the match's `Settled` event (matchId is not indexed: filtered by asset, payment and buyer). */
  private async settleTransactionOf(match: Match, id: Hex): Promise<string> {
    const latest = await this.call(() => this.client.getBlockNumber());
    const log = await this.call(() =>
      findLogBackward(
        this.client,
        {
          address: this.s.contracts.settlement,
          topics: [SETTLED_TOPIC],
          indexed: [pad32(getAddress(match.asset)), pad32(this.s.quoteAsset), pad32(getAddress(match.buyer))],
          fromBlock: this.s.fromBlock,
          toBlock: latest,
          chunk: this.logChunk,
        },
        (l: Log) => decodeSettled(l)?.matchId.toLowerCase() === id,
      ),
    );
    if (!log?.transactionHash) {
      throw new SettlementFailure("transient", "settledMatches is true but the Settled event is not found yet");
    }
    return log.transactionHash;
  }

  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      const f = mapEvmError(e);
      if (f === "already_settled") throw new SettlementFailure("transient", "unexpected MatchAlreadySettled outside settle");
      throw f;
    }
  }
}

export interface SettledEvent {
  matchId: Hex;
  assetToken: Address;
  paymentToken: Address;
  buyer: Address;
  seller: Address;
  assetAmount: bigint;
  paymentAmount: bigint;
  feeCharged: bigint;
}

export function decodeSettled(log: Pick<Log, "data" | "topics">): SettledEvent | null {
  try {
    const d = decodeEventLog({ abi: NIARA_SETTLEMENT_ABI, eventName: "Settled", data: log.data, topics: log.topics as never });
    return d.args as unknown as SettledEvent;
  } catch {
    return null;
  }
}
