import type { ChainId } from "../chains.ts";
import type { Side } from "../engine/types.ts";

/**
 * The current order intent version. v2 adds `timeInForce` to the signed fields; v1 is
 * still accepted and means GTC. The cancellation format has its own version
 * (`CANCEL_VERSION`, cancel.ts): it names an order by nonce, whatever the order's version.
 */
export const INTENT_VERSION = 2;
export const SUPPORTED_INTENT_VERSIONS = [1, 2] as const;
export type IntentVersion = (typeof SUPPORTED_INTENT_VERSIONS)[number];

/**
 * - GTC (good till cancelled): what is not matched at once rests in the book until
 *   filled, cancelled or expired.
 * - IOC (immediate or cancel): matched at once against the book up to the signed limit
 *   price; whatever is not matched is cancelled (`ioc_unfilled`), never rests. A market
 *   order is an IOC whose limit price is a price cap (docs/decisions.md).
 */
export type TimeInForce = "GTC" | "IOC";
export const TIME_IN_FORCE: readonly TimeInForce[] = ["GTC", "IOC"];

/**
 * What a wallet signs to place an order (spec §3.6). Units as in the engine:
 * `quantity` and `lotSize` in asset base units, `limitPrice` in USDT base units per
 * lot.
 *
 * Solana: the UTF-8 text of `solanaIntentMessage`, signed with `signMessage` (ed25519).
 * EVM: the EIP-712 typed data of `evmIntentTypedData`.
 */
export interface OrderIntent {
  version: IntentVersion;
  /** Selects the CAIP-2 chain id that is signed (`CHAINS[chain].caip2`). */
  chain: ChainId;
  /** Solana: the `niara_exchange` program id. EVM: the `NiaraSettlement` address. */
  settlement: string;
  /** The signer. Solana base58 public key, or EVM address (checksummed). */
  wallet: string;
  side: Side;
  /** Asset mint / token address. */
  asset: string;
  quantity: bigint;
  lotSize: bigint;
  limitPrice: bigint;
  /** USDT mint / token address of this chain. */
  paymentAsset: string;
  /** 16 random bytes, lowercase hex (32 chars). Unique per (chain, wallet). */
  nonce: string;
  /**
   * Unix seconds. Required: the order cannot be matched or settled from then on, and
   * the server refuses an expiry further than the chain's maximum validity window
   * (spec §9.12 item 2).
   */
  expiresAt: number;
  /** v2: required and signed. v1: absent (a v1 intent is GTC). */
  timeInForce?: TimeInForce;
}

/** The time in force an intent was signed with: a v1 intent is GTC. */
export function timeInForceOf(intent: Pick<OrderIntent, "version" | "timeInForce">): TimeInForce {
  return intent.version === 1 ? "GTC" : intent.timeInForce!;
}

export class IntentError extends Error {
  readonly code: IntentErrorCode;
  constructor(code: IntentErrorCode, message: string) {
    super(message);
    this.name = "IntentError";
    this.code = code;
  }
}

export type IntentErrorCode =
  | "malformed"
  | "unsupported_version"
  | "unknown_chain"
  | "invalid_address"
  | "invalid_side"
  | "invalid_amount"
  | "amount_overflow"
  | "not_whole_lots"
  | "invalid_nonce"
  | "invalid_expiry"
  | "invalid_time_in_force"
  | "invalid_signature_format";
