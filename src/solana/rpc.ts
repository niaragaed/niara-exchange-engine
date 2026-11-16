import {
  Connection,
  PublicKey,
  type VersionedTransaction,
  type TransactionError,
} from "@solana/web3.js";
import { base58 } from "@scure/base";
import { SOLANA_DEVNET_GENESIS } from "../chains.ts";

/**
 * The narrow Solana RPC surface the adapter, the delegate check, the listing sync and
 * the worker use. Production: `connectionRpc` over @solana/web3.js; tests: a mock.
 * DEVNET ONLY: `connectDevnet` refuses any cluster whose genesis hash is not devnet's.
 */

export interface AccountData {
  owner: PublicKey;
  lamports: number;
  data: Uint8Array;
}

export interface SimulationResult {
  err: TransactionError | null;
  logs: string[];
}

export interface InnerInstruction {
  programId: PublicKey;
  data: Uint8Array;
}

export interface TransactionDetails {
  err: TransactionError | null;
  slot: number;
  blockTime: number | null;
  logs: string[];
  innerInstructions: InnerInstruction[];
}

export interface SolanaRpc {
  getGenesisHash(): Promise<string>;
  getAccounts(keys: readonly PublicKey[]): Promise<(AccountData | null)[]>;
  /** Accounts of `programId` whose data starts with `prefix` (an Anchor discriminator). */
  getProgramAccounts(programId: PublicKey, prefix: Uint8Array): Promise<{ pubkey: PublicKey; account: AccountData }[]>;
  getLatestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }>;
  simulate(tx: VersionedTransaction): Promise<SimulationResult>;
  /** Sends an already simulated transaction; returns its signature. */
  send(tx: VersionedTransaction): Promise<string>;
  /** Waits for `confirmed`; throws a transient error if the blockhash expired first. */
  confirm(signature: string, blockhash: string, lastValidBlockHeight: number): Promise<{ err: TransactionError | null }>;
  /** Newest first. */
  getSignaturesForAddress(address: PublicKey, limit: number): Promise<{ signature: string; err: TransactionError | null }[]>;
  getTransaction(signature: string): Promise<TransactionDetails | null>;
}

export class NotDevnetError extends Error {
  constructor(genesis: string) {
    super(`the Solana RPC is not devnet (genesis ${genesis}): refusing to continue`);
    this.name = "NotDevnetError";
  }
}

export async function assertDevnet(rpc: SolanaRpc): Promise<void> {
  const genesis = await rpc.getGenesisHash();
  if (genesis !== SOLANA_DEVNET_GENESIS) throw new NotDevnetError(genesis);
}

export const DEFAULT_DEVNET_RPC = "https://api.devnet.solana.com";

/** Connects and checks the cluster is devnet. The URL may hold an API key: never log it. */
export async function connectDevnet(url: string = DEFAULT_DEVNET_RPC): Promise<SolanaRpc> {
  const rpc = connectionRpc(new Connection(url, "confirmed"));
  await assertDevnet(rpc);
  return rpc;
}

const toData = (a: { owner: PublicKey; lamports: number; data: Buffer | Uint8Array }): AccountData => ({
  owner: a.owner,
  lamports: a.lamports,
  data: Uint8Array.from(a.data),
});

export function connectionRpc(connection: Connection): SolanaRpc {
  return {
    getGenesisHash: () => connection.getGenesisHash(),
    getAccounts: async (keys) => {
      const out: (AccountData | null)[] = [];
      // getMultipleAccounts takes at most 100 keys.
      for (let i = 0; i < keys.length; i += 100) {
        const chunk = await connection.getMultipleAccountsInfo([...keys.slice(i, i + 100)], "confirmed");
        out.push(...chunk.map((a) => (a ? toData(a) : null)));
      }
      return out;
    },
    getProgramAccounts: async (programId, prefix) => {
      const r = await connection.getProgramAccounts(programId, {
        commitment: "confirmed",
        filters: [{ memcmp: { offset: 0, bytes: base58.encode(prefix) } }],
      });
      return r.map((x) => ({ pubkey: x.pubkey, account: toData(x.account) }));
    },
    getLatestBlockhash: () => connection.getLatestBlockhash("confirmed"),
    simulate: async (tx) => {
      const r = await connection.simulateTransaction(tx, { sigVerify: true, commitment: "confirmed" });
      return { err: r.value.err, logs: r.value.logs ?? [] };
    },
    send: (tx) => connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 0 }),
    confirm: async (signature, blockhash, lastValidBlockHeight) => {
      const r = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
      return { err: r.value.err };
    },
    getSignaturesForAddress: async (address, limit) =>
      (await connection.getSignaturesForAddress(address, { limit }, "confirmed")).map((s) => ({
        signature: s.signature,
        err: s.err,
      })),
    getTransaction: async (signature) => {
      const t = await connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      if (!t) return null;
      const keys = t.transaction.message.getAccountKeys({ accountKeysFromLookups: t.meta?.loadedAddresses ?? null });
      const inner: InnerInstruction[] = [];
      for (const group of t.meta?.innerInstructions ?? []) {
        for (const ix of group.instructions) {
          const programId = keys.get(ix.programIdIndex);
          if (programId) inner.push({ programId, data: base58.decode(ix.data) });
        }
      }
      return {
        err: t.meta?.err ?? null,
        slot: t.slot,
        blockTime: t.blockTime ?? null,
        logs: t.meta?.logMessages ?? [],
        innerInstructions: inner,
      };
    },
  };
}
