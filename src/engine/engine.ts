import type { ChainId } from "../chains.ts";
import { isUuidV4 } from "./ids.ts";
import type { Market, Match, OrderInput, Side } from "./types.ts";

/**
 * Matching engine: one limit order book per (chain, asset), price-time priority,
 * partial fills, cancellations, self-trade prevention.
 *
 * Deterministic: no clock, no randomness, no I/O. The caller passes `now` (unix
 * seconds) and a match id generator; the same sequence of calls with the same ids
 * produces the same matches and events.
 *
 * Rules:
 * - Only `equity` markets (order-book mode, spec §1) take orders; `fixed_income`,
 *   `credit` and `currency` trade by P2P escrow and are refused.
 * - The market must be `approved`, and the order must pay in the market's quote asset
 *   (USDT, spec §3.4).
 * - Quantities are whole lots; prices are USDT base units per lot. A match trades at
 *   the resting (maker) order's limit price, so it is within both limits.
 * - Self-trade prevention: an incoming order that would cross a resting order of the
 *   same wallet has its remaining quantity cancelled (cancel-newest). The resting
 *   order stays. A wallet therefore never matches itself and the book never crosses.
 * - An order is matchable only while `expiresAt - now > settlementMarginSecs`: a match
 *   must leave time to settle before the earlier of its two expiries.
 * - Minimum notional (spec §9.12 item 1), per market: an order below it is refused at
 *   entry; a match below it is never made; a remainder below it (valued at its own
 *   limit price) is cancelled instead of resting. When the next match would fall below
 *   the minimum, the order whose remainder limits that match is cancelled: the resting
 *   order (then matching continues with the next one) or the incoming order (then
 *   matching stops). Skipping to a worse price is never done.
 */

export type RejectReason =
  | "duplicate_order_id"
  | "unknown_market"
  | "not_order_book_asset"
  | "market_not_approved"
  | "wrong_payment_asset"
  | "lot_size_mismatch"
  | "invalid_quantity"
  | "invalid_price"
  | "not_whole_lots"
  | "below_min_notional"
  | "expired";

export type CancelRejectReason = "unknown_order" | "not_owner" | "not_live";

export type OrderStatus = "open" | "partially_filled" | "filled" | "cancelled" | "expired" | "stale";

export type CancelReason = "by_wallet" | "self_trade_prevention" | "below_min_notional";

export interface OrderView extends OrderInput {
  /** Arrival position in the engine, from 1: the time in price-time priority. */
  seq: number;
  filledQuantity: bigint;
  remaining: bigint;
  status: OrderStatus;
}

export type EngineEvent =
  | { type: "order_rejected"; orderId: string; reason: RejectReason }
  | { type: "order_accepted"; orderId: string }
  | { type: "match"; match: Match }
  | { type: "order_filled"; orderId: string }
  | { type: "order_rested"; orderId: string; remaining: bigint }
  | { type: "order_cancelled"; orderId: string; reason: CancelReason; remaining: bigint }
  | { type: "order_expired"; orderId: string; remaining: bigint }
  | { type: "order_stale"; orderId: string; remaining: bigint };

export type PlaceResult =
  | { accepted: false; reason: RejectReason; events: EngineEvent[] }
  | { accepted: true; order: OrderView; matches: Match[]; events: EngineEvent[] };

export type CancelResult =
  | { cancelled: false; reason: CancelRejectReason }
  | { cancelled: true; order: OrderView; events: EngineEvent[] };

export interface PriceLevel {
  price: bigint;
  quantity: bigint;
  orders: number;
}

export interface BookSnapshot {
  chain: ChainId;
  asset: string;
  /** Best (highest) first. */
  bids: PriceLevel[];
  /** Best (lowest) first. */
  asks: PriceLevel[];
}

export interface EngineOptions {
  /** Returns a fresh UUID v4 for each match (production: `randomMatchId`). */
  newMatchId: () => string;
  /** Minimum time to expiry for an order to be matched or accepted. Default 60. */
  settlementMarginSecs?: number;
}

export class EngineInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EngineInvariantError";
  }
}

interface OrderState {
  input: OrderInput;
  seq: number;
  filled: bigint;
  status: OrderStatus;
}

interface Book {
  /** Sorted by price desc, then seq asc. */
  bids: OrderState[];
  /** Sorted by price asc, then seq asc. */
  asks: OrderState[];
}

const DEFAULT_MARGIN_SECS = 60;

export function marketKey(chain: ChainId, asset: string): string {
  return `${chain}\u0000${asset}`;
}

function remainingOf(o: OrderState): bigint {
  return o.input.quantity - o.filled;
}

/** True when `a` has priority over `b` on the same side of the book. */
function before(side: Side, a: OrderState, b: OrderState): boolean {
  if (a.input.limitPrice !== b.input.limitPrice) {
    return side === "buy" ? a.input.limitPrice > b.input.limitPrice : a.input.limitPrice < b.input.limitPrice;
  }
  return a.seq < b.seq;
}

function insertSorted(side: Side, list: OrderState[], o: OrderState): void {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (before(side, list[mid]!, o)) lo = mid + 1;
    else hi = mid;
  }
  list.splice(lo, 0, o);
}

function crosses(taker: OrderInput, maker: OrderInput): boolean {
  return taker.side === "buy" ? maker.limitPrice <= taker.limitPrice : maker.limitPrice >= taker.limitPrice;
}

function levels(list: readonly OrderState[]): PriceLevel[] {
  const out: PriceLevel[] = [];
  for (const o of list) {
    const last = out[out.length - 1];
    if (last && last.price === o.input.limitPrice) {
      last.quantity += remainingOf(o);
      last.orders += 1;
    } else {
      out.push({ price: o.input.limitPrice, quantity: remainingOf(o), orders: 1 });
    }
  }
  return out;
}

export class MatchingEngine {
  private readonly markets = new Map<string, Market>();
  private readonly books = new Map<string, Book>();
  private readonly orders = new Map<string, OrderState>();
  private readonly matchIds = new Set<string>();
  private readonly newMatchId: () => string;
  private readonly margin: number;
  private nextSeq = 1;
  private nextMatchSeq = 1;

  constructor(options: EngineOptions) {
    this.newMatchId = options.newMatchId;
    this.margin = options.settlementMarginSecs ?? DEFAULT_MARGIN_SECS;
    if (!Number.isSafeInteger(this.margin) || this.margin < 0) {
      throw new RangeError("settlementMarginSecs must be a non-negative integer");
    }
  }

  /**
   * Adds or updates a market (from the listings mirror). A suspended, delisted or
   * pending market keeps its resting orders but takes and matches no new order. The
   * lot size of a market with resting orders cannot change: their prices are per lot.
   */
  upsertMarket(market: Market): void {
    if (market.lotSize <= 0n) throw new RangeError("lotSize must be positive");
    if (market.minOrderNotional < 0n) throw new RangeError("minOrderNotional must be non-negative");
    const key = marketKey(market.chain, market.asset);
    const previous = this.markets.get(key);
    const book = this.books.get(key);
    if (previous && book && previous.lotSize !== market.lotSize && book.bids.length + book.asks.length > 0) {
      throw new RangeError("cannot change the lot size of a market with resting orders");
    }
    this.markets.set(key, { ...market });
    if (!book) this.books.set(key, { bids: [], asks: [] });
  }

  place(input: OrderInput, now: number): PlaceResult {
    assertTime(now);
    const reason = this.validate(input, now);
    if (reason) {
      return { accepted: false, reason, events: [{ type: "order_rejected", orderId: input.id, reason }] };
    }
    const key = marketKey(input.chain, input.asset);
    const book = this.books.get(key)!;
    const taker: OrderState = { input: { ...input }, seq: this.nextSeq++, filled: 0n, status: "open" };
    this.orders.set(input.id, taker);

    const events: EngineEvent[] = [{ type: "order_accepted", orderId: input.id }];
    const matches: Match[] = [];
    const opposite = input.side === "buy" ? book.asks : book.bids;

    const market = this.markets.get(key)!;
    while (remainingOf(taker) > 0n) {
      const maker = opposite[0];
      if (!maker) break;
      if (!this.live(maker, now)) {
        opposite.shift();
        maker.status = "expired";
        events.push({ type: "order_expired", orderId: maker.input.id, remaining: remainingOf(maker) });
        continue;
      }
      if (!crosses(taker.input, maker.input)) break;
      if (maker.input.wallet === taker.input.wallet) {
        taker.status = "cancelled";
        events.push({
          type: "order_cancelled",
          orderId: taker.input.id,
          reason: "self_trade_prevention",
          remaining: remainingOf(taker),
        });
        break;
      }
      const quantity = minBig(remainingOf(taker), remainingOf(maker));
      if (notional(quantity, maker.input.lotSize, maker.input.limitPrice) < market.minOrderNotional) {
        // The order whose remainder limits this match is below the minimum.
        if (remainingOf(maker) === quantity) {
          opposite.shift();
          this.cancelBelowMin(maker, events);
          continue;
        }
        this.cancelBelowMin(taker, events);
        break;
      }
      const match = this.makeMatch(taker, maker, quantity);
      matches.push(match);
      events.push({ type: "match", match });
      maker.filled += quantity;
      taker.filled += quantity;
      if (remainingOf(maker) === 0n) {
        opposite.shift();
        maker.status = "filled";
        events.push({ type: "order_filled", orderId: maker.input.id });
      } else {
        maker.status = "partially_filled";
        if (this.belowMin(maker, market)) {
          opposite.shift();
          this.cancelBelowMin(maker, events);
        }
      }
    }

    if (taker.status !== "cancelled") {
      if (remainingOf(taker) === 0n) {
        taker.status = "filled";
        events.push({ type: "order_filled", orderId: taker.input.id });
      } else if (this.belowMin(taker, market)) {
        this.cancelBelowMin(taker, events);
      } else {
        taker.status = taker.filled > 0n ? "partially_filled" : "open";
        insertSorted(input.side, input.side === "buy" ? book.bids : book.asks, taker);
        events.push({ type: "order_rested", orderId: taker.input.id, remaining: remainingOf(taker) });
      }
    }
    return { accepted: true, order: view(taker), matches, events };
  }

  /** Cancels a live or stale order of `wallet` (the caller authenticated the wallet). */
  cancel(orderId: string, wallet: string): CancelResult {
    const o = this.orders.get(orderId);
    if (!o) return { cancelled: false, reason: "unknown_order" };
    if (o.input.wallet !== wallet) return { cancelled: false, reason: "not_owner" };
    if (o.status !== "open" && o.status !== "partially_filled" && o.status !== "stale") {
      return { cancelled: false, reason: "not_live" };
    }
    this.removeFromBook(o);
    o.status = "cancelled";
    return {
      cancelled: true,
      order: view(o),
      events: [{ type: "order_cancelled", orderId, reason: "by_wallet", remaining: remainingOf(o) }],
    };
  }

  /**
   * Takes a resting order out of the book because its on-chain delegate/allowance no
   * longer covers it (spec §3.5). The check itself happens outside the engine.
   */
  markStale(orderId: string): EngineEvent[] {
    const o = this.orders.get(orderId);
    if (!o || (o.status !== "open" && o.status !== "partially_filled")) return [];
    this.removeFromBook(o);
    o.status = "stale";
    return [{ type: "order_stale", orderId, remaining: remainingOf(o) }];
  }

  /** Removes every resting order that is no longer matchable at `now`. */
  expire(now: number): EngineEvent[] {
    assertTime(now);
    const events: EngineEvent[] = [];
    for (const book of this.books.values()) {
      for (const side of [book.bids, book.asks]) {
        for (let i = 0; i < side.length; ) {
          const o = side[i]!;
          if (this.live(o, now)) {
            i++;
          } else {
            side.splice(i, 1);
            o.status = "expired";
            events.push({ type: "order_expired", orderId: o.input.id, remaining: remainingOf(o) });
          }
        }
      }
    }
    return events;
  }

  getOrder(orderId: string): OrderView | undefined {
    const o = this.orders.get(orderId);
    return o ? view(o) : undefined;
  }

  book(chain: ChainId, asset: string): BookSnapshot {
    const b = this.books.get(marketKey(chain, asset)) ?? { bids: [], asks: [] };
    return { chain, asset, bids: levels(b.bids), asks: levels(b.asks) };
  }

  private validate(input: OrderInput, now: number): RejectReason | null {
    if (this.orders.has(input.id)) return "duplicate_order_id";
    const market = this.markets.get(marketKey(input.chain, input.asset));
    if (!market) return "unknown_market";
    if (market.assetClass !== "equity") return "not_order_book_asset";
    if (market.status !== "approved") return "market_not_approved";
    if (input.paymentAsset !== market.quoteAsset) return "wrong_payment_asset";
    if (input.lotSize !== market.lotSize) return "lot_size_mismatch";
    if (input.quantity <= 0n) return "invalid_quantity";
    if (input.limitPrice <= 0n) return "invalid_price";
    if (input.quantity % market.lotSize !== 0n) return "not_whole_lots";
    if (notional(input.quantity, market.lotSize, input.limitPrice) < market.minOrderNotional) return "below_min_notional";
    if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt - now <= this.margin) return "expired";
    return null;
  }

  /** True when the order's remainder, valued at its own limit price, is below the minimum. */
  private belowMin(o: OrderState, market: Market): boolean {
    return notional(remainingOf(o), o.input.lotSize, o.input.limitPrice) < market.minOrderNotional;
  }

  /** Cancels an order's remainder (already out of the book) for being below the minimum. */
  private cancelBelowMin(o: OrderState, events: EngineEvent[]): void {
    o.status = "cancelled";
    events.push({ type: "order_cancelled", orderId: o.input.id, reason: "below_min_notional", remaining: remainingOf(o) });
  }

  private live(o: OrderState, now: number): boolean {
    return o.input.expiresAt - now > this.margin;
  }

  private makeMatch(taker: OrderState, maker: OrderState, quantity: bigint): Match {
    const id = this.newMatchId();
    if (!isUuidV4(id)) throw new EngineInvariantError(`match id is not a UUID v4: ${id}`);
    if (this.matchIds.has(id)) throw new EngineInvariantError(`duplicate match id: ${id}`);
    this.matchIds.add(id);
    const buy = taker.input.side === "buy" ? taker : maker;
    const sell = taker.input.side === "buy" ? maker : taker;
    const lotSize = maker.input.lotSize;
    const price = maker.input.limitPrice;
    return {
      id,
      sequence: this.nextMatchSeq++,
      chain: maker.input.chain,
      asset: maker.input.asset,
      paymentAsset: maker.input.paymentAsset,
      buyOrderId: buy.input.id,
      sellOrderId: sell.input.id,
      buyer: buy.input.wallet,
      seller: sell.input.wallet,
      makerOrderId: maker.input.id,
      takerSide: taker.input.side,
      quantity,
      lotSize,
      price,
      paymentAmount: (quantity / lotSize) * price,
      expiresAt: Math.min(buy.input.expiresAt, sell.input.expiresAt),
    };
  }

  private removeFromBook(o: OrderState): void {
    const book = this.books.get(marketKey(o.input.chain, o.input.asset));
    if (!book) return;
    const list = o.input.side === "buy" ? book.bids : book.asks;
    const i = list.indexOf(o);
    if (i >= 0) list.splice(i, 1);
  }
}

function view(o: OrderState): OrderView {
  return { ...o.input, seq: o.seq, filledQuantity: o.filled, remaining: remainingOf(o), status: o.status };
}

/** USDT base units of `quantity` at `price` per lot. */
function notional(quantity: bigint, lotSize: bigint, price: bigint): bigint {
  return (quantity / lotSize) * price;
}

function minBig(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

function assertTime(now: number): void {
  if (!Number.isSafeInteger(now)) throw new RangeError("now must be integer unix seconds");
}
