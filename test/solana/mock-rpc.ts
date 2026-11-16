/**
 * TEST ONLY: an in-memory SolanaRpc (no network) and encoders for the accounts the
 * code reads. Keys are generated per run; addresses are not devnet accounts.
 */
import { Keypair, PublicKey, type TransactionError, type VersionedTransaction } from "@solana/web3.js";
import { SOLANA_DEVNET_GENESIS } from "../../src/chains.ts";
import { concat, encodeFields, type BorshValue } from "../../src/solana/borsh.ts";
import { idlTypeDef, accountDiscriminator, eventDiscriminator } from "../../src/solana/idl.ts";
import type { AccountData, SimulationResult, SolanaRpc, TransactionDetails } from "../../src/solana/rpc.ts";
import { TOKEN_2022_PROGRAM_ID } from "../../src/solana/accounts.ts";

export interface MockRpc extends SolanaRpc {
  accounts: Map<string, AccountData>;
  genesis: string;
  /** Next results; each call consumes one (the last one repeats). Errors are thrown. */
  simulateResults: (SimulationResult | Error)[];
  sendResults: (string | Error)[];
  confirmResults: ({ err: TransactionError | null } | Error)[];
  /** Applied when a send succeeds (e.g. create the settlement record). */
  onSend?: (tx: VersionedTransaction) => void;
  /** Throws this on the next getAccounts (once). */
  failNextRead?: Error;
  transactions: Map<string, TransactionDetails>;
  signaturesFor: Map<string, string[]>;
  calls: string[];
  sent: VersionedTransaction[];
  simulated: VersionedTransaction[];
  set(key: PublicKey, account: AccountData): void;
}

function next<T>(queue: T[]): T {
  if (queue.length === 0) throw new Error("mock: no scripted result");
  return queue.length > 1 ? queue.shift()! : queue[0]!;
}

export function mockRpc(): MockRpc {
  const rpc: MockRpc = {
    accounts: new Map(),
    genesis: SOLANA_DEVNET_GENESIS,
    simulateResults: [{ err: null, logs: ["Program log: Instruction: Settle"] }],
    sendResults: [],
    confirmResults: [{ err: null }],
    transactions: new Map(),
    signaturesFor: new Map(),
    calls: [],
    sent: [],
    simulated: [],
    set(key, account) {
      rpc.accounts.set(key.toBase58(), account);
    },
    getGenesisHash: async () => {
      rpc.calls.push("getGenesisHash");
      return rpc.genesis;
    },
    getAccounts: async (keys) => {
      rpc.calls.push("getAccounts");
      if (rpc.failNextRead) {
        const e = rpc.failNextRead;
        delete rpc.failNextRead;
        throw e;
      }
      return keys.map((k) => rpc.accounts.get(k.toBase58()) ?? null);
    },
    getProgramAccounts: async (programId, prefix) => {
      rpc.calls.push("getProgramAccounts");
      return [...rpc.accounts.entries()]
        .filter(([, a]) => a.owner.equals(programId) && prefix.every((b, i) => a.data[i] === b))
        .map(([k, a]) => ({ pubkey: new PublicKey(k), account: a }));
    },
    getLatestBlockhash: async () => {
      rpc.calls.push("getLatestBlockhash");
      return { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1000 };
    },
    simulate: async (tx) => {
      rpc.calls.push("simulate");
      rpc.simulated.push(tx);
      const r = next(rpc.simulateResults);
      if (r instanceof Error) throw r;
      return r;
    },
    send: async (tx) => {
      rpc.calls.push("send");
      const r = rpc.sendResults.length ? next(rpc.sendResults) : `TEST-SIG-${rpc.sent.length + 1}`;
      if (r instanceof Error) throw r;
      rpc.sent.push(tx);
      rpc.onSend?.(tx);
      return r;
    },
    confirm: async () => {
      rpc.calls.push("confirm");
      const r = next(rpc.confirmResults);
      if (r instanceof Error) throw r;
      return r;
    },
    getSignaturesForAddress: async (address) => {
      rpc.calls.push("getSignaturesForAddress");
      return (rpc.signaturesFor.get(address.toBase58()) ?? []).map((signature) => ({ signature, err: null }));
    },
    getTransaction: async (signature) => {
      rpc.calls.push("getTransaction");
      return rpc.transactions.get(signature) ?? null;
    },
  };
  return rpc;
}

// ---------------------------------------------------------------------------
// Encoders
// ---------------------------------------------------------------------------

function anchorAccount(name: string, values: Record<string, BorshValue>): Uint8Array {
  const def = idlTypeDef(name);
  if (def.type.kind !== "struct") throw new Error("struct expected");
  return concat([accountDiscriminator(name), encodeFields(def.type.fields, values)]);
}

export function configData(v: {
  settlementOperator: PublicKey;
  feeMint: PublicKey;
  feeBps?: number;
  cashbackBps?: number;
  paused?: boolean;
}): Uint8Array {
  const k = Keypair.generate().publicKey;
  return anchorAccount("Config", {
    admin: k,
    listing_authority: k,
    settlement_operator: v.settlementOperator,
    treasury: k,
    fee_mint: v.feeMint,
    fee_bps: v.feeBps ?? 50,
    cashback_bps: v.cashbackBps ?? 2000,
    paused: v.paused ?? false,
    timelock_secs: 60n,
    bump: 255,
  });
}

export function listingData(v: {
  mint: PublicKey;
  issuer?: PublicKey;
  assetClass: "Equity" | "FixedIncome" | "Credit" | "Currency";
  status: "Pending" | "Approved" | "Suspended" | "Delisted" | "Quoted";
  cashbackEligible?: boolean;
  docHash?: Uint8Array;
}): Uint8Array {
  const currency = v.assetClass === "Currency";
  return anchorAccount("Listing", {
    asset_mint: v.mint,
    issuer: v.issuer ?? (currency ? PublicKey.default : Keypair.generate().publicKey),
    asset_class: v.assetClass,
    status: v.status,
    cashback_eligible: v.cashbackEligible ?? !currency,
    doc_hash: v.docHash ?? (currency ? new Uint8Array(32) : new Uint8Array(32).fill(0xab)),
    approved_at: 1n,
    next_batch_no: 1n,
    issued: 0n,
    burned: 0n,
    cashback_frozen: false,
    valuation: 0n,
    listing_fee_bps: 0,
    listing_fee: 0n,
    listing_fee_mint: PublicKey.default,
    quote_expires_at: 0n,
    listing_fee_paid: 0n,
    bump: 254,
  });
}

export function mintData(decimals: number): Uint8Array {
  const d = new Uint8Array(82);
  d[44] = decimals;
  d[45] = 1;
  return d;
}

export function tokenAccountData(v: {
  mint: PublicKey;
  owner: PublicKey;
  amount: bigint;
  delegate?: PublicKey | null;
  delegatedAmount?: bigint;
}): Uint8Array {
  const d = new Uint8Array(165);
  const dv = new DataView(d.buffer);
  d.set(v.mint.toBytes(), 0);
  d.set(v.owner.toBytes(), 32);
  dv.setBigUint64(64, v.amount, true);
  if (v.delegate) {
    dv.setUint32(72, 1, true);
    d.set(v.delegate.toBytes(), 76);
  }
  d[108] = 1;
  dv.setBigUint64(121, v.delegatedAmount ?? 0n, true);
  return d;
}

export const tokenAccount = (data: Uint8Array): AccountData => ({ owner: TOKEN_2022_PROGRAM_ID, lamports: 2_039_280, data });

/** The inner-instruction data Anchor's emit_cpi! writes for a Settled event. */
export function settledEventData(values: Record<string, BorshValue>): Uint8Array {
  const def = idlTypeDef("Settled");
  if (def.type.kind !== "struct") throw new Error("struct expected");
  const EVENT_IX_TAG = Uint8Array.from([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]);
  return concat([EVENT_IX_TAG, eventDiscriminator("Settled"), encodeFields(def.type.fields, values)]);
}
