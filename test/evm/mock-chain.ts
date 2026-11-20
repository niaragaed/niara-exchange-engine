import {
  custom,
  decodeFunctionData,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  encodeFunctionResult,
  getAddress,
  isAddressEqual,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  toHex,
  zeroAddress,
  zeroHash,
  type Address,
  type Hex,
  type Transport,
} from "viem";
import { Transaction as TempoTransaction } from "viem/tempo";
import { LISTING_REGISTRY_ABI } from "../../src/evm/abi/ListingRegistry.ts";
import { NATIVE_ASSET_TOKEN_ABI } from "../../src/evm/abi/NativeAssetToken.ts";
import { NIARA_SETTLEMENT_ABI } from "../../src/evm/abi/NiaraSettlement.ts";
import { SETTLE_ABI } from "../../src/evm/errors.ts";

/**
 * TEST ONLY: an in-memory EVM testnet behind a viem `custom` transport, answering the
 * JSON-RPC methods the adapter, the coverage check and the listing sync use. It models
 * NiaraSettlement.settle (role, pause, replay guard, fee token, listing checks, ceil fee,
 * transferFrom with OpenZeppelin errors), ListingRegistry.getListing and its events, and
 * ERC-20 balances/allowances. Transactions are real signed transactions: the sender is
 * recovered from the signature, and Tempo (0x76) transactions are deserialized. Every
 * address is a patterned test value, not a deployment.
 */

export const T = {
  settlement: "0x5e771e0000000000000000000000000000000001",
  registry: "0x5e771e0000000000000000000000000000000002",
  distributor: "0x5e771e0000000000000000000000000000000003",
  usdt: "0x7e57000000000000000000000000000000000d01",
  equity: "0x7e57000000000000000000000000000000000e01",
  bond: "0x7e57000000000000000000000000000000000b01",
  brl: "0x7e57000000000000000000000000000000000d02",
  pathUsd: "0x20c0000000000000000000000000000000000000",
  issuer: "0x1550000000000000000000000000000000000001",
  seller: "0x5e11000000000000000000000000000000000001",
  buyer: "0xb000000000000000000000000000000000000001",
} as const satisfies Record<string, Address>;

const ROLE = keccak256(toHex("SETTLEMENT_OPERATOR_ROLE"));
const ABI = [...SETTLE_ABI, ...LISTING_REGISTRY_ABI, ...NATIVE_ASSET_TOKEN_ABI] as const;

interface Listing {
  issuer: Address;
  assetClass: number;
  status: number;
  cashbackEligible: boolean;
  docHash: Hex;
  approvedAt: bigint;
  cashbackFrozen: boolean;
}

interface Token {
  decimals: number;
  balances: Map<string, bigint>;
  allowances: Map<string, bigint>;
}

interface MinedTx {
  hash: Hex;
  from: Address;
  to: Address;
  nonce: number;
  type: string;
  gas: bigint;
  feeToken: Address | null;
  maxFeePerGas: bigint | null;
  gasPrice: bigint | null;
  status: "success" | "reverted";
  revert: string | null;
  blockNumber: bigint | null;
  logs: RawLog[];
}

interface RawLog {
  address: Address;
  topics: Hex[];
  data: Hex;
  blockNumber: bigint;
  transactionHash: Hex;
  logIndex: number;
}

class Revert extends Error {
  readonly data: Hex;
  constructor(errorName: string, args: readonly unknown[]) {
    super(`execution reverted: ${errorName}`);
    this.data = encodeErrorResult({ abi: ABI, errorName: errorName as never, args: args as never });
  }
}

const key = (...parts: string[]) => parts.map((p) => p.toLowerCase()).join(":");
const hexNum = (n: bigint | number) => toHex(n);

export class MockEvmChain {
  chainId: number;
  block = 1_000n;
  baseFee = 1_000_000n;
  priorityFee = 1_000n;
  gasPrice = 2_000_000n;
  estimate = 204_428n;
  feeBps = 50n;
  paused = false;
  operators = new Set<string>();
  settled = new Set<string>();
  feeToken: Address = T.usdt;
  listingRegistryLink: Address = T.registry;
  distributorLink: Address = T.distributor;
  nativeBalances = new Map<string, bigint>();
  tokens = new Map<string, Token>();
  listings = new Map<string, Listing>();
  logs: RawLog[] = [];
  txs = new Map<string, MinedTx>();
  nonces = new Map<string, number>();
  /** Calls per JSON-RPC method, and the eth_call function names. */
  calls: { method: string; fn?: string }[] = [];
  /** While true, sent transactions stay pending (no receipt). */
  holdReceipts = false;
  /** Largest eth_getLogs block range accepted (larger: "block range too large"). */
  maxLogRange = 1_000_000n;
  /** Errors to throw once for the next call of a method. */
  failNext = new Map<string, Error | object>();

  constructor(chainId: number) {
    this.chainId = chainId;
    for (const t of [T.usdt, T.brl, T.pathUsd]) this.addToken(t, 6);
    for (const t of [T.equity, T.bond]) this.addToken(t, 18);
    this.setListing(T.usdt, { assetClass: 3, status: 2 });
    this.setListing(T.brl, { assetClass: 3, status: 2 });
    this.setListing(T.equity, { assetClass: 0, status: 2, issuer: T.issuer, cashbackEligible: true, docHash: `0x${"ab".repeat(32)}` });
    this.setListing(T.bond, { assetClass: 1, status: 2, issuer: T.issuer, cashbackEligible: true, docHash: `0x${"cd".repeat(32)}` });
  }

  transport(): Transport {
    // No transport retries: the adapter maps RPC errors and the worker retries.
    return custom({ request: ({ method, params }) => this.request(method, (params ?? []) as unknown[]) }, { retryCount: 0 });
  }

  addToken(address: Address, decimals: number): void {
    this.tokens.set(address.toLowerCase(), { decimals, balances: new Map(), allowances: new Map() });
  }

  token(address: string): Token {
    const t = this.tokens.get(address.toLowerCase());
    if (!t) throw new Error(`no token ${address}`);
    return t;
  }

  balanceOf(token: Address, owner: Address): bigint {
    return this.token(token).balances.get(owner.toLowerCase()) ?? 0n;
  }

  fund(token: Address, owner: Address, amount: bigint): void {
    this.token(token).balances.set(owner.toLowerCase(), amount);
  }

  approve(token: Address, owner: Address, spender: Address, amount: bigint): void {
    this.token(token).allowances.set(key(owner, spender), amount);
  }

  /** Sets a listing and emits the event the registry would have (in a new block). */
  setListing(token: Address, l: Partial<Listing> & { assetClass: number; status: number }): void {
    const full: Listing = {
      issuer: zeroAddress,
      cashbackEligible: false,
      docHash: zeroHash,
      approvedAt: 1_800_000_000n,
      cashbackFrozen: false,
      ...l,
    };
    this.listings.set(token.toLowerCase(), full);
    this.block += 1n;
    const tx = keccak256(toHex(`listing:${token}:${l.status}:${this.block}`));
    const event =
      l.status === 2
        ? { eventName: "ListingApproved", args: { token, issuer: full.issuer } }
        : l.status === 3
          ? { eventName: "ListingSuspended", args: { token } }
          : l.status === 4
            ? { eventName: "ListingDelisted", args: { token } }
            : { eventName: "ListingSubmitted", args: { token, issuer: full.issuer } };
    const topics = encodeEventTopics({ abi: LISTING_REGISTRY_ABI, ...(event as object) } as never) as Hex[];
    const data =
      event.eventName === "ListingApproved"
        ? encodeAbiParameters(
            [{ type: "uint8" }, { type: "bool" }, { type: "bytes32" }, { type: "uint64" }],
            [l.assetClass, full.cashbackEligible, full.docHash, full.approvedAt],
          )
        : event.eventName === "ListingDelisted"
          ? encodeAbiParameters([{ type: "uint8" }], [2])
          : event.eventName === "ListingSubmitted"
            ? encodeAbiParameters([{ type: "uint8" }, { type: "bytes32" }], [l.assetClass, full.docHash])
            : "0x";
    this.logs.push({ address: T.registry, topics, data, blockNumber: this.block, transactionHash: tx, logIndex: 0 });
  }

  sent(): MinedTx[] {
    return [...this.txs.values()];
  }

  count(method: string): number {
    return this.calls.filter((c) => c.method === method).length;
  }

  /** Mines every held transaction. */
  release(): void {
    this.holdReceipts = false;
    for (const tx of this.txs.values()) if (tx.blockNumber === null) this.mine(tx);
  }

  // ---------------------------------------------------------------------------

  private async request(method: string, params: unknown[]): Promise<unknown> {
    const failure = this.failNext.get(method);
    if (failure) {
      this.failNext.delete(method);
      throw failure;
    }
    switch (method) {
      case "eth_chainId":
        return hexNum(this.chainId);
      case "eth_blockNumber":
        return hexNum(this.block);
      case "eth_getBlockByNumber":
        return this.blockJson();
      case "eth_maxPriorityFeePerGas":
        return hexNum(this.priorityFee);
      case "eth_gasPrice":
        return hexNum(this.gasPrice);
      case "eth_getBalance":
        return hexNum(this.nativeBalances.get(String(params[0]).toLowerCase()) ?? 0n);
      case "eth_getCode":
        return this.tokens.has(String(params[0]).toLowerCase()) || this.isContract(String(params[0])) ? "0x6080" : "0x";
      case "eth_getTransactionCount":
        return hexNum(this.nonces.get(String(params[0]).toLowerCase()) ?? 0);
      case "eth_call": {
        const p = params[0] as { to: Address; data: Hex; from?: Address };
        this.calls.push({ method, fn: this.fnName(p.data) });
        return this.ethCall(p.from ?? zeroAddress, p.to, p.data, false);
      }
      case "eth_estimateGas": {
        const p = params[0] as { to: Address; data: Hex; from?: Address };
        this.calls.push({ method });
        this.ethCall(p.from ?? zeroAddress, p.to, p.data, false);
        return hexNum(this.estimate);
      }
      case "eth_sendRawTransaction":
        this.calls.push({ method });
        return this.sendRaw(params[0] as Hex);
      case "eth_getTransactionReceipt":
        return this.receiptJson(params[0] as Hex);
      case "eth_getTransactionByHash":
        return this.txJson(params[0] as Hex);
      case "eth_getLogs":
        this.calls.push({ method });
        return this.getLogs(params[0] as { address: Address; topics: (Hex | Hex[] | null)[]; fromBlock: Hex; toBlock: Hex });
      default:
        throw new Error(`mock chain: unsupported method ${method}`);
    }
  }

  private isContract(a: string): boolean {
    return [T.settlement, T.registry, T.distributor].some((c) => isAddressEqual(c, a as Address));
  }

  private fnName(data: Hex): string {
    try {
      return decodeFunctionData({ abi: ABI, data }).functionName;
    } catch {
      return "?";
    }
  }

  private ethCall(from: Address, to: Address, data: Hex, execute: boolean): Hex {
    try {
      const { functionName, args } = decodeFunctionData({ abi: ABI, data });
      const result = this.dispatch(from, to, functionName, (args ?? []) as readonly unknown[], execute);
      if (result === undefined) return "0x";
      return encodeFunctionResult({ abi: ABI, functionName: functionName as never, result: result as never });
    } catch (e) {
      if (e instanceof Revert) throw { code: 3, message: e.message, data: e.data };
      throw e;
    }
  }

  private dispatch(from: Address, to: Address, fn: string, args: readonly unknown[], execute: boolean): unknown {
    if (isAddressEqual(to, T.settlement)) {
      switch (fn) {
        case "feeToken":
          return this.feeToken;
        case "listingRegistry":
          return this.listingRegistryLink;
        case "cashbackDistributor":
          return this.distributorLink;
        case "SETTLEMENT_OPERATOR_ROLE":
          return ROLE;
        case "hasRole":
          return args[0] === ROLE && this.operators.has(String(args[1]).toLowerCase());
        case "settledMatches":
          return this.settled.has(String(args[0]).toLowerCase());
        case "paused":
          return this.paused;
        case "settle":
          return this.settle(from, args, execute);
      }
    }
    if (isAddressEqual(to, T.registry) && fn === "getListing") {
      const l = this.listings.get(String(args[0]).toLowerCase());
      return l ?? { issuer: zeroAddress, assetClass: 0, status: 0, cashbackEligible: false, docHash: zeroHash, approvedAt: 0n, cashbackFrozen: false };
    }
    const token = this.tokens.get(to.toLowerCase());
    if (token) {
      if (fn === "decimals") return token.decimals;
      if (fn === "balanceOf") return token.balances.get(String(args[0]).toLowerCase()) ?? 0n;
      if (fn === "allowance") return token.allowances.get(key(String(args[0]), String(args[1]))) ?? 0n;
    }
    throw new Error(`mock chain: no ${fn} on ${to}`);
  }

  private settle(from: Address, args: readonly unknown[], execute: boolean): bigint {
    const [matchId, asset, payment, buyer, seller, assetAmount, paymentAmount] = args as [Hex, Address, Address, Address, Address, bigint, bigint];
    if (!this.operators.has(from.toLowerCase())) throw new Revert("AccessControlUnauthorizedAccount", [from, ROLE]);
    if (this.paused) throw new Revert("EnforcedPause", []);
    if (/^0x0+$/.test(matchId)) throw new Revert("ZeroMatchId", []);
    if (this.settled.has(matchId.toLowerCase())) throw new Revert("MatchAlreadySettled", [matchId]);
    if (isAddressEqual(buyer, seller)) throw new Revert("BuyerEqualsSeller", []);
    if (!isAddressEqual(payment, this.feeToken)) throw new Revert("NotFeeToken", [payment]);
    const al = this.listings.get(asset.toLowerCase());
    if (!al || al.status !== 2) throw new Revert("AssetListingNotApproved", [asset]);
    if (al.assetClass !== 0) throw new Revert("AssetNotEquity", [asset]);
    const fee = (paymentAmount * this.feeBps + 9_999n) / 10_000n;
    const proceeds = paymentAmount - fee;
    if (proceeds === 0n) throw new Revert("ZeroSellerProceeds", []);
    // transferFrom checks, as OpenZeppelin ERC20 v5 raises them (allowance first).
    const legs: [Address, Address, Address, bigint][] = [
      [asset, seller, buyer, assetAmount],
      [payment, buyer, seller, proceeds],
      [payment, buyer, T.distributor, fee],
    ];
    const spent = new Map<string, bigint>();
    for (const [token, owner, , amount] of legs) {
      const t = this.token(token);
      const k = key(owner, T.settlement);
      const used = (spent.get(`${token}:${k}`) ?? 0n) + amount;
      const allowance = t.allowances.get(k) ?? 0n;
      if (allowance < used) throw new Revert("ERC20InsufficientAllowance", [T.settlement, allowance - (used - amount), amount]);
      const balance = t.balances.get(owner.toLowerCase()) ?? 0n;
      if (balance < used) throw new Revert("ERC20InsufficientBalance", [owner, balance - (used - amount), amount]);
      spent.set(`${token}:${k}`, used);
    }
    if (execute) {
      this.settled.add(matchId.toLowerCase());
      for (const [token, owner, receiver, amount] of legs) {
        const t = this.token(token);
        t.allowances.set(key(owner, T.settlement), (t.allowances.get(key(owner, T.settlement)) ?? 0n) - amount);
        t.balances.set(owner.toLowerCase(), (t.balances.get(owner.toLowerCase()) ?? 0n) - amount);
        t.balances.set(receiver.toLowerCase(), (t.balances.get(receiver.toLowerCase()) ?? 0n) + amount);
      }
      this.pendingLogs.push({
        address: T.settlement,
        topics: encodeEventTopics({ abi: NIARA_SETTLEMENT_ABI, eventName: "Settled", args: { assetToken: asset, paymentToken: payment, buyer } }) as Hex[],
        data: encodeAbiParameters(
          [{ type: "bytes16" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
          [matchId, seller, assetAmount, paymentAmount, fee],
        ),
      });
    }
    return fee;
  }

  private pendingLogs: Omit<RawLog, "blockNumber" | "transactionHash" | "logIndex">[] = [];

  private async sendRaw(raw: Hex): Promise<Hex> {
    const hash = keccak256(raw);
    let from: Address;
    let to: Address;
    let data: Hex;
    let nonce: number;
    let type: string;
    let gas: bigint;
    let feeToken: Address | null = null;
    let maxFeePerGas: bigint | null = null;
    let gasPrice: bigint | null = null;
    let chainId: number | undefined;
    if (raw.startsWith("0x76")) {
      const t = TempoTransaction.deserialize(raw as never) as unknown as {
        from: Address; calls: { to: Address; data: Hex }[]; nonce: number; gas: bigint; feeToken: Address; maxFeePerGas: bigint; chainId: number;
      };
      from = getAddress(t.from);
      to = t.calls[0]!.to;
      data = t.calls[0]!.data;
      nonce = Number(t.nonce);
      type = "tempo";
      gas = t.gas;
      feeToken = getAddress(t.feeToken);
      maxFeePerGas = t.maxFeePerGas;
      chainId = Number(t.chainId);
    } else {
      const t = parseTransaction(raw);
      from = await recoverTransactionAddress({ serializedTransaction: raw as never });
      to = t.to!;
      data = t.data ?? "0x";
      nonce = t.nonce ?? 0;
      type = t.type ?? "legacy";
      gas = t.gas ?? 0n;
      maxFeePerGas = t.maxFeePerGas ?? null;
      gasPrice = t.gasPrice ?? null;
      chainId = t.chainId;
    }
    if (chainId !== this.chainId) throw { code: -32000, message: `invalid chain id ${chainId}` };
    const expected = this.nonces.get(from.toLowerCase()) ?? 0;
    if (nonce !== expected) throw { code: -32000, message: `nonce too low: ${nonce} != ${expected}` };
    this.nonces.set(from.toLowerCase(), expected + 1);
    const tx: MinedTx = { hash, from, to, nonce, type, gas, feeToken, maxFeePerGas, gasPrice, status: "success", revert: null, blockNumber: null, logs: [] };
    this.txs.set(hash, tx);
    (tx as MinedTx & { data: Hex }).data = data;
    if (!this.holdReceipts) this.mine(tx);
    return hash;
  }

  private mine(tx: MinedTx): void {
    this.block += 1n;
    tx.blockNumber = this.block;
    this.pendingLogs = [];
    try {
      this.ethCall(tx.from, tx.to, (tx as MinedTx & { data: Hex }).data, true);
      tx.logs = this.pendingLogs.map((l, i) => ({ ...l, blockNumber: this.block, transactionHash: tx.hash, logIndex: i }));
      this.logs.push(...tx.logs);
    } catch (e) {
      tx.status = "reverted";
      tx.revert = (e as { message?: string }).message ?? "reverted";
    }
  }

  private blockJson() {
    return {
      number: hexNum(this.block),
      hash: keccak256(toHex(`block:${this.block}`)),
      parentHash: zeroHash,
      timestamp: hexNum(1_800_000_000n + this.block),
      baseFeePerGas: hexNum(this.baseFee),
      gasLimit: hexNum(30_000_000n),
      gasUsed: "0x0",
      miner: zeroAddress,
      extraData: "0x",
      logsBloom: `0x${"0".repeat(512)}`,
      nonce: "0x0000000000000000",
      difficulty: "0x0",
      totalDifficulty: "0x0",
      size: "0x0",
      stateRoot: zeroHash,
      receiptsRoot: zeroHash,
      transactionsRoot: zeroHash,
      sha3Uncles: zeroHash,
      mixHash: zeroHash,
      transactions: [],
      uncles: [],
    };
  }

  private txJson(hash: Hex) {
    const tx = this.txs.get(hash);
    if (!tx) return null;
    return {
      hash,
      from: tx.from,
      to: tx.to,
      nonce: hexNum(tx.nonce),
      gas: hexNum(tx.gas),
      input: (tx as MinedTx & { data: Hex }).data,
      value: "0x0",
      type: tx.type === "eip1559" ? "0x2" : tx.type === "tempo" ? "0x76" : "0x0",
      chainId: hexNum(this.chainId),
      blockHash: tx.blockNumber === null ? null : keccak256(toHex(`block:${tx.blockNumber}`)),
      blockNumber: tx.blockNumber === null ? null : hexNum(tx.blockNumber),
      transactionIndex: tx.blockNumber === null ? null : "0x0",
      ...(tx.gasPrice !== null ? { gasPrice: hexNum(tx.gasPrice) } : {}),
      ...(tx.maxFeePerGas !== null ? { maxFeePerGas: hexNum(tx.maxFeePerGas), maxPriorityFeePerGas: hexNum(this.priorityFee), gasPrice: hexNum(tx.maxFeePerGas) } : {}),
      v: "0x0",
      r: "0x1",
      s: "0x1",
    };
  }

  private receiptJson(hash: Hex) {
    const tx = this.txs.get(hash);
    if (!tx || tx.blockNumber === null) return null;
    return {
      transactionHash: hash,
      transactionIndex: "0x0",
      blockHash: keccak256(toHex(`block:${tx.blockNumber}`)),
      blockNumber: hexNum(tx.blockNumber),
      from: tx.from,
      to: tx.to,
      contractAddress: null,
      cumulativeGasUsed: hexNum(this.estimate),
      gasUsed: hexNum(this.estimate),
      effectiveGasPrice: hexNum(tx.gasPrice ?? this.baseFee + this.priorityFee),
      logs: tx.logs.map((l) => this.logJson(l)),
      logsBloom: `0x${"0".repeat(512)}`,
      status: tx.status === "success" ? "0x1" : "0x0",
      type: tx.type === "eip1559" ? "0x2" : tx.type === "tempo" ? "0x76" : "0x0",
      ...(tx.feeToken ? { feeToken: tx.feeToken, feePayer: tx.from } : {}),
    };
  }

  private logJson(l: RawLog) {
    return {
      address: l.address,
      topics: l.topics,
      data: l.data,
      blockNumber: hexNum(l.blockNumber),
      blockHash: keccak256(toHex(`block:${l.blockNumber}`)),
      transactionHash: l.transactionHash,
      transactionIndex: "0x0",
      logIndex: hexNum(l.logIndex),
      removed: false,
    };
  }

  private getLogs(f: { address: Address; topics: (Hex | Hex[] | null)[]; fromBlock: Hex; toBlock: Hex }) {
    const from = BigInt(f.fromBlock);
    const to = BigInt(f.toBlock);
    if (to - from + 1n > this.maxLogRange) throw { code: -32602, message: `block range too large: max ${this.maxLogRange}` };
    return this.logs
      .filter((l) => isAddressEqual(l.address, f.address) && l.blockNumber >= from && l.blockNumber <= to)
      .filter((l) =>
        f.topics.every((want, i) => want === null || (Array.isArray(want) ? want.map((w) => w.toLowerCase()) : [want.toLowerCase()]).includes(l.topics[i]?.toLowerCase() ?? "")),
      )
      .map((l) => this.logJson(l));
  }
}
