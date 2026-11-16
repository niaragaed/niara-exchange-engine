import type { ChainId } from "../chains.ts";
import type { Side } from "../engine/types.ts";

export const INTENT_VERSION = 1;

/**
 * What a wallet signs to place an order (spec §3.6). Units as in the engine:
 * `quantity` and `lotSize` in asset base units, `limitPrice` in USDT base units per
 * lot.
 *
 * Solana: the UTF-8 text of `solanaIntentMessage`, signed with `signMessage` (ed25519).
 * EVM: the EIP-712 typed data of `evmIntentTypedData`.
 */
export interface OrderIntent {
  version: typeof INTENT_VERSION;
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
  | "invalid_signature_format";
