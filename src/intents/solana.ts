import { verifyAsync } from "@noble/ed25519";
import { base58 } from "@scure/base";
import { CHAINS } from "../chains.ts";
import { IntentError, type OrderIntent } from "./types.ts";
import { validateIntent } from "./validate.ts";

/**
 * The exact text a Solana wallet signs with `signMessage`: UTF-8, lines joined by
 * "\n", no trailing newline, integers in plain decimal. Wallets display it as is,
 * so every field is labeled and the testnet notice is part of what is signed.
 *
 * The verifier never parses a signed text: it rebuilds this text from the structured
 * intent and checks the signature over it, so two different intents can never share a
 * message. The on-chain check (spec §3.6, Ed25519 program + instructions sysvar) must
 * rebuild the same bytes.
 */
export function solanaIntentMessage(intent: OrderIntent): Uint8Array {
  const i = validateIntent(intent);
  const chain = CHAINS[i.chain];
  if (chain.kind !== "solana") throw new IntentError("unknown_chain", `${i.chain} is not a Solana chain`);
  const lines = [
    `Niara Exchange order intent v${i.version}`,
    "TESTNET ONLY: no real assets, no real money.",
    "",
    `Chain: ${chain.caip2}`,
    `Program: ${i.settlement}`,
    `Wallet: ${i.wallet}`,
    `Side: ${i.side}`,
    `Asset: ${i.asset}`,
    `Quantity: ${i.quantity} (asset base units)`,
    `Lot size: ${i.lotSize} (asset base units)`,
    `Limit price: ${i.limitPrice} (payment base units per lot)`,
    `Payment asset: ${i.paymentAsset}`,
    `Nonce: ${i.nonce}`,
    `Expires at: ${i.expiresAt} (unix seconds)`,
  ];
  return new TextEncoder().encode(lines.join("\n"));
}

/** Decodes a base58 ed25519 signature (64 bytes). */
export function decodeSolanaSignature(signature: string): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = base58.decode(signature);
  } catch {
    throw new IntentError("invalid_signature_format", "signature is not base58");
  }
  if (bytes.length !== 64) throw new IntentError("invalid_signature_format", "signature must be 64 bytes");
  return bytes;
}

/**
 * True when `signature` (base58) is `intent.wallet`'s ed25519 signature over
 * `solanaIntentMessage(intent)`. Strict RFC 8032 verification (`zip215: false`), as the
 * Solana Ed25519 program's `verify_strict`.
 */
export async function verifySolanaIntent(intent: OrderIntent, signature: string): Promise<boolean> {
  const message = solanaIntentMessage(intent);
  const sig = decodeSolanaSignature(signature);
  try {
    return await verifyAsync(sig, message, base58.decode(intent.wallet), { zip215: false });
  } catch {
    return false;
  }
}
