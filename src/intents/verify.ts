import { getAddress } from "viem";
import { CHAINS, type ChainId } from "../chains.ts";
import type { OrderInput } from "../engine/types.ts";
import { verifyEvmIntent } from "./evm.ts";
import { verifySolanaIntent } from "./solana.ts";
import { IntentError, type IntentErrorCode, type OrderIntent } from "./types.ts";
import { validateIntent } from "./validate.ts";

/** Verifies `signature` over `intent` with the scheme of the intent's chain. */
export async function verifyIntentSignature(intent: OrderIntent, signature: string): Promise<boolean> {
  return CHAINS[validateIntent(intent).chain].kind === "solana"
    ? verifySolanaIntent(intent, signature)
    : verifyEvmIntent(intent, signature);
}

/** A row of the `chains` table, as the server function reads it. */
export interface ChainConfig {
  chain: ChainId;
  /** `chains.settlement_program`; null until deployed. */
  settlementProgram: string | null;
  /** `chains.quote_asset` (USDT); null until set up. */
  quoteAsset: string | null;
  /** `chains.max_intent_validity_secs`. */
  maxIntentValiditySecs: number;
}

export type AdmissionRejectReason =
  | IntentErrorCode
  | "wrong_chain"
  | "chain_not_ready"
  | "wrong_settlement"
  | "wrong_payment_asset"
  | "expired"
  | "expiry_too_far"
  | "bad_signature";

export type AdmissionResult =
  | { ok: true; intent: OrderIntent; signature: string; order: OrderInput }
  | { ok: false; reason: AdmissionRejectReason; detail: string };

/**
 * The server-side gate in front of `orders` (the only way an order enters): checks the
 * intent against the chain's configuration and its expiry window, then the wallet's
 * signature. Pure apart from the signature check; `now` is passed in (unix seconds).
 * Market checks (listing approved, equity, lot size, minimum notional) are the
 * matching engine's.
 */
export async function admitOrderIntent(args: {
  intent: OrderIntent;
  signature: string;
  orderId: string;
  now: number;
  chain: ChainConfig;
}): Promise<AdmissionResult> {
  const reject = (reason: AdmissionRejectReason, detail: string): AdmissionResult => ({ ok: false, reason, detail });
  let intent: OrderIntent;
  try {
    intent = validateIntent(args.intent);
  } catch (e) {
    if (e instanceof IntentError) return reject(e.code, e.message);
    throw e;
  }
  const { chain, now } = args;
  if (intent.chain !== chain.chain) return reject("wrong_chain", `intent is for ${intent.chain}, config for ${chain.chain}`);
  if (chain.settlementProgram === null || chain.quoteAsset === null) {
    return reject("chain_not_ready", `${chain.chain} has no settlement program or quote asset configured`);
  }
  const same = (a: string, b: string) => (CHAINS[chain.chain].kind === "evm" ? getAddress(a) === getAddress(b) : a === b);
  if (!same(intent.settlement, chain.settlementProgram)) {
    return reject("wrong_settlement", "intent is signed for another program or contract");
  }
  if (!same(intent.paymentAsset, chain.quoteAsset)) {
    return reject("wrong_payment_asset", "the order book pays only in this chain's USDT");
  }
  if (intent.expiresAt <= now) return reject("expired", "intent has expired");
  if (intent.expiresAt > now + chain.maxIntentValiditySecs) {
    return reject("expiry_too_far", `expiresAt is more than ${chain.maxIntentValiditySecs} s ahead`);
  }
  let valid: boolean;
  try {
    valid = await verifyIntentSignature(intent, args.signature);
  } catch (e) {
    if (e instanceof IntentError) return reject(e.code, e.message);
    throw e;
  }
  if (!valid) return reject("bad_signature", "signature does not match the wallet and intent");
  return {
    ok: true,
    intent,
    signature: args.signature,
    order: {
      id: args.orderId,
      chain: intent.chain,
      asset: intent.asset,
      paymentAsset: intent.paymentAsset,
      wallet: intent.wallet,
      side: intent.side,
      quantity: intent.quantity,
      limitPrice: intent.limitPrice,
      lotSize: intent.lotSize,
      expiresAt: intent.expiresAt,
    },
  };
}
