import type { PublicKey } from "@solana/web3.js";
import { decodeWithDiscriminator, equalBytes } from "./borsh.ts";
import { PROGRAM_ID, eventDiscriminator } from "./idl.ts";
import type { SolanaRpc } from "./rpc.ts";

/** Anchor's `emit_cpi!` tag: the first 8 bytes of every self-CPI event instruction. */
export const EVENT_IX_TAG = Uint8Array.from([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]);

export interface SettledEvent {
  matchId: Uint8Array;
  assetMint: PublicKey;
  paymentMint: PublicKey;
  buyer: PublicKey;
  seller: PublicKey;
  assetAmount: bigint;
  paymentAmount: bigint;
  fee: bigint;
  cashback: bigint;
}

/** Decodes a `Settled` event from an inner instruction's data, or null if it is not one. */
export function decodeSettledEvent(data: Uint8Array): SettledEvent | null {
  if (data.length < 16 || !equalBytes(data.subarray(0, 8), EVENT_IX_TAG)) return null;
  const body = data.subarray(8);
  if (!equalBytes(body.subarray(0, 8), eventDiscriminator("Settled"))) return null;
  const e = decodeWithDiscriminator("Settled", eventDiscriminator("Settled"), body);
  return {
    matchId: e["match_id"] as Uint8Array,
    assetMint: e["asset_mint"] as PublicKey,
    paymentMint: e["payment_mint"] as PublicKey,
    buyer: e["buyer"] as PublicKey,
    seller: e["seller"] as PublicKey,
    assetAmount: e["asset_amount"] as bigint,
    paymentAmount: e["payment_amount"] as bigint,
    fee: e["fee"] as bigint,
    cashback: e["cashback"] as bigint,
  };
}

/** The `Settled` event of a confirmed settle transaction, read from its inner instructions. */
export async function fetchSettledEvent(
  rpc: SolanaRpc,
  signature: string,
  programId: PublicKey = PROGRAM_ID,
): Promise<SettledEvent | null> {
  const tx = await rpc.getTransaction(signature);
  if (!tx || tx.err) return null;
  for (const ix of tx.innerInstructions) {
    if (!ix.programId.equals(programId)) continue;
    const event = decodeSettledEvent(ix.data);
    if (event) return event;
  }
  return null;
}
