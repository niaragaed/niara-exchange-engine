import { base58 } from "@scure/base";
import { getAddress, isAddress } from "viem";
import { CHAINS, isChainId, type ChainKind } from "../chains.ts";
import { INTENT_VERSION, IntentError, type OrderIntent } from "./types.ts";

export const U64_MAX = (1n << 64n) - 1n;
export const U256_MAX = (1n << 256n) - 1n;

const DECIMAL = /^(0|[1-9][0-9]*)$/;
/** 16 bytes as 32 lowercase hex chars (order intent and cancellation nonces). */
export const NONCE_PATTERN = /^[0-9a-f]{32}$/;

/** A canonical base58 Solana public key: decodes to 32 bytes and re-encodes identically. */
export function isSolanaAddress(value: string): boolean {
  try {
    return base58.decode(value).length === 32 && base58.encode(base58.decode(value)) === value;
  } catch {
    return false;
  }
}

export function checkAddress(kind: ChainKind, field: string, value: unknown): string {
  if (typeof value !== "string") throw new IntentError("invalid_address", `${field} must be a string`);
  if (kind === "solana") {
    if (!isSolanaAddress(value)) throw new IntentError("invalid_address", `${field} is not a base58 public key`);
    return value;
  }
  if (!isAddress(value, { strict: false })) throw new IntentError("invalid_address", `${field} is not an address`);
  const checksummed = getAddress(value);
  if (BigInt(checksummed) === 0n) throw new IntentError("invalid_address", `${field} is the zero address`);
  return checksummed;
}

/**
 * Validates an intent and returns its canonical form (EVM addresses checksummed).
 * Throws `IntentError`. The signature is checked separately (`verifyIntentSignature`).
 */
export function validateIntent(intent: OrderIntent): OrderIntent {
  if (intent.version !== INTENT_VERSION) {
    throw new IntentError("unsupported_version", `intent version must be ${INTENT_VERSION}`);
  }
  if (!isChainId(intent.chain)) throw new IntentError("unknown_chain", `unknown chain: ${String(intent.chain)}`);
  const kind = CHAINS[intent.chain].kind;
  const settlement = checkAddress(kind, "settlement", intent.settlement);
  const wallet = checkAddress(kind, "wallet", intent.wallet);
  const asset = checkAddress(kind, "asset", intent.asset);
  const paymentAsset = checkAddress(kind, "paymentAsset", intent.paymentAsset);
  if (asset === paymentAsset) throw new IntentError("invalid_address", "asset and paymentAsset must differ");
  if (intent.side !== "buy" && intent.side !== "sell") throw new IntentError("invalid_side", "side must be buy or sell");

  for (const field of ["quantity", "lotSize", "limitPrice"] as const) {
    const v = intent[field];
    if (typeof v !== "bigint" || v <= 0n) throw new IntentError("invalid_amount", `${field} must be a positive integer`);
  }
  if (intent.quantity % intent.lotSize !== 0n) {
    throw new IntentError("not_whole_lots", "quantity must be a multiple of lotSize");
  }
  // On-chain widths: Solana `settle` takes u64 amounts; EVM takes uint256.
  const max = kind === "solana" ? U64_MAX : U256_MAX;
  const notional = (intent.quantity / intent.lotSize) * intent.limitPrice;
  if (intent.quantity > max || intent.lotSize > max || intent.limitPrice > max || notional > max) {
    throw new IntentError("amount_overflow", `amounts must fit in ${kind === "solana" ? "u64" : "uint256"}`);
  }

  if (typeof intent.nonce !== "string" || !NONCE_PATTERN.test(intent.nonce) || /^0+$/.test(intent.nonce)) {
    throw new IntentError("invalid_nonce", "nonce must be 16 non-zero bytes as 32 lowercase hex chars");
  }
  // Required. i64 on Solana and uint64 on EVM both hold any safe integer.
  if (typeof intent.expiresAt !== "number" || !Number.isSafeInteger(intent.expiresAt) || intent.expiresAt <= 0) {
    throw new IntentError("invalid_expiry", "expiresAt is required, in positive integer unix seconds");
  }
  return { ...intent, settlement, wallet, asset, paymentAsset };
}

/**
 * Parses an intent from JSON as a client sends it. Amounts must be decimal strings
 * (never JSON numbers, which are floats); `expiresAt` an integer number.
 */
export function parseOrderIntent(json: unknown): OrderIntent {
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new IntentError("malformed", "intent must be an object");
  }
  const o = json as Record<string, unknown>;
  const allowed = [
    "version",
    "chain",
    "settlement",
    "wallet",
    "side",
    "asset",
    "quantity",
    "lotSize",
    "limitPrice",
    "paymentAsset",
    "nonce",
    "expiresAt",
  ];
  for (const key of Object.keys(o)) {
    if (!allowed.includes(key)) throw new IntentError("malformed", `unexpected field: ${key}`);
  }
  const amount = (field: string): bigint => {
    const v = o[field];
    if (typeof v !== "string" || !DECIMAL.test(v)) {
      throw new IntentError("invalid_amount", `${field} must be a decimal integer string`);
    }
    return BigInt(v);
  };
  if (o["expiresAt"] === undefined) throw new IntentError("invalid_expiry", "expiresAt is required");
  return validateIntent({
    version: o["version"] as typeof INTENT_VERSION,
    chain: o["chain"] as OrderIntent["chain"],
    settlement: o["settlement"] as string,
    wallet: o["wallet"] as string,
    side: o["side"] as OrderIntent["side"],
    asset: o["asset"] as string,
    quantity: amount("quantity"),
    lotSize: amount("lotSize"),
    limitPrice: amount("limitPrice"),
    paymentAsset: o["paymentAsset"] as string,
    nonce: o["nonce"] as string,
    expiresAt: o["expiresAt"] as number,
  });
}
