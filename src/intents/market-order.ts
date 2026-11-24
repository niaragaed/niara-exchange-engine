import type { Side } from "../engine/types.ts";

/**
 * Market orders. TESTNET ONLY.
 *
 * A market order is not a separate order type: it is an IOC order (intent v2,
 * `timeInForce: "IOC"`) whose signed limit price is a PRICE CAP that the client
 * computes from the best opposite price and a slippage tolerance:
 *
 *   buy:  limit = floor(best ask x (10_000 + slippage bps) / 10_000)
 *   sell: limit = ceil(best bid  x (10_000 - slippage bps) / 10_000), at least 1
 *
 * The engine knows nothing of slippage: it matches the IOC at once against the book at
 * the makers' prices, never beyond the signed limit, and cancels whatever is left
 * (`ioc_unfilled`). The wallet sees and signs the cap, so it is the most it can pay
 * (buy) or the least it can receive (sell), whatever the book does in between.
 *
 * Slippage: 1% by default, at most 5% (this helper refuses more; the engine would
 * accept any signed limit, so the cap is the client's to keep).
 */

export const MARKET_ORDER_DEFAULT_SLIPPAGE_BPS = 100; // 1%
export const MARKET_ORDER_MAX_SLIPPAGE_BPS = 500; // 5%

export class MarketOrderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarketOrderError";
  }
}

/**
 * The limit price (payment base units per lot) of a market order of `side`, from the
 * best opposite price of the book (best ask for a buy, best bid for a sell). Rounded so
 * the cap never exceeds the slippage: down for a buy, up for a sell.
 */
export function marketOrderLimitPrice(
  side: Side,
  bestOppositePrice: bigint | null | undefined,
  slippageBps: number = MARKET_ORDER_DEFAULT_SLIPPAGE_BPS,
): bigint {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > MARKET_ORDER_MAX_SLIPPAGE_BPS) {
    throw new MarketOrderError(`slippage must be a whole number of basis points from 0 to ${MARKET_ORDER_MAX_SLIPPAGE_BPS} (5%)`);
  }
  if (bestOppositePrice === null || bestOppositePrice === undefined) {
    throw new MarketOrderError(`no ${side === "buy" ? "ask" : "bid"} in the book: a market order would have nothing to match`);
  }
  if (bestOppositePrice <= 0n) throw new MarketOrderError("the best price must be positive");
  const bps = BigInt(slippageBps);
  if (side === "buy") return (bestOppositePrice * (10_000n + bps)) / 10_000n;
  const floor = (bestOppositePrice * (10_000n - bps) + 9_999n) / 10_000n;
  return floor < 1n ? 1n : floor;
}
