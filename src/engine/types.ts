import type { ChainId } from "../chains.ts";

/**
 * Units (all integers, `bigint`, never floats):
 * - `quantity`: asset base units (the mint's / token's smallest unit). Always a multiple
 *   of the market's `lotSize`.
 * - `price` / `limitPrice`: USDT base units per `lotSize` asset base units.
 * - `paymentAmount = quantity / lotSize * price`: USDT base units, exact (no rounding).
 * - times: unix seconds (`number`).
 */

export type Side = "buy" | "sell";

/** Spec §1 asset classes. Only `equity` trades on the order book. */
export type AssetClass = "equity" | "fixed_income" | "credit" | "currency";

/** Spec §3.2 listing status. */
export type ListingStatus = "pending" | "quoted" | "approved" | "suspended" | "delisted";

/** A listing as the matching engine sees it: one book per (chain, asset). */
export interface Market {
  chain: ChainId;
  asset: string;
  assetClass: AssetClass;
  status: ListingStatus;
  /** USDT of this chain (spec §3.4: the order book pays only in the fee mint). */
  quoteAsset: string;
  /** Asset base units per lot; quantities are whole lots and prices are per lot. */
  lotSize: bigint;
  /** Minimum order notional in USDT base units (spec §9.12 item 1); 0n disables it. */
  minOrderNotional: bigint;
}

/** An order as submitted to the engine (after its signed intent was verified). */
export interface OrderInput {
  /** Off-chain order id (UUID); unique. */
  id: string;
  chain: ChainId;
  asset: string;
  /** Must equal the market's `quoteAsset`. */
  paymentAsset: string;
  wallet: string;
  side: Side;
  quantity: bigint;
  limitPrice: bigint;
  /** Lot size the intent was signed with; must equal the market's. */
  lotSize: bigint;
  /** Unix seconds; required (spec §9.12 item 2). */
  expiresAt: number;
}

export interface Match {
  /** UUID v4: the `matches.id` primary key and the on-chain `match_id` (spec §3.4). */
  id: string;
  /** Position of this match in the engine's output, from 1. */
  sequence: number;
  chain: ChainId;
  asset: string;
  /** USDT of this chain. */
  paymentAsset: string;
  buyOrderId: string;
  sellOrderId: string;
  buyer: string;
  seller: string;
  /** The resting order, whose limit price is the trade price. */
  makerOrderId: string;
  takerSide: Side;
  /** Asset base units, a multiple of `lotSize`. */
  quantity: bigint;
  lotSize: bigint;
  /** USDT base units per lot. */
  price: bigint;
  /** USDT base units the buyer pays: `quantity / lotSize * price`. */
  paymentAmount: bigint;
  /** The earlier expiry of the two orders: the match cannot settle from then on. */
  expiresAt: number;
}
