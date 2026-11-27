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
 * - Time in force: a GTC order's unmatched remainder rests. An IOC order matches at once
 *   up to its limit price and its unmatched remainder is cancelled (`ioc_unfilled`): it
 *   never rests, and never re-enters the book later (a failed match releases its
 *   quantity, which is then cancelled too).
 * - Iceberg (`displayQuantity`, GTC only): as a taker it matches its whole remainder;
 *   resting, only its visible slice, min(display, remaining), is in the book and can be
 *   matched. When a slice is fully filled, a new slice of min(display, remaining) is
 *   shown at the same price with a new time priority (the next arrival sequence, so
 *   behind every order already resting). One taker can fill several slices in one pass
 *   while it is still marketable. A slice is never left below the minimum notional
 *   while hidden quantity remains: a partly filled slice worth less than the minimum is
 *   refreshed the same way. The display quantity must itself meet the minimum at entry;
 *   the last slice is the remainder, which follows the remainder rule.
 * - Priority is the order's `priority`: its seq at arrival, a later sequence after each
 *   slice refresh. The public book shows visible slices only.
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
  | "expired"
  | "invalid_time_in_force"
  | "invalid_display_quantity"
  | "iceberg_requires_gtc"
  | "display_below_min_notional";

export type CancelRejectReason = "unknown_order" | "not_owner" | "not_live";

export type OrderStatus = "open" | "partially_filled" | "filled" | "cancelled" | "expired" | "stale";

export type CancelReason = "by_wallet" | "self_trade_prevention" | "below_min_notional" | "ioc_unfilled";

export interface OrderView extends OrderInput {
  /** Arrival position in the engine, from 1: the time in price-time priority. */
  seq: number;
  /** Total ever matched; never decreases. */
  filledQuantity: bigint;
  /** Of failed matches, returned to this order (it was not at fault). */
  releasedQuantity: bigint;
  /** Of failed matches, lost by this order (it defaulted). */
  voidedQuantity: bigint;
  /** quantity - (filled - released - voided). */
  remaining: bigint;
  status: OrderStatus;
  /** Time priority: `seq` at arrival; a later sequence after each iceberg slice refresh. */
  prioritySeq: number;
  /**
   * Icebergs only: the current visible slice (what the book shows and a taker can match
   * while it rests). Absent for an order shown whole.
   */
  visibleQuantity?: bigint;
}

/**
 * Why a match failed after both orders were filled (`reverse`):
 * - seller / buyer: that side's delegation or balance no longer covered it
 * - both: both sides'
 * - expired: it could not settle before its expires_at
 * - none: the chain refused it for another reason, or retries ran out
 */
export type MatchFault = "seller" | "buyer" | "both" | "expired" | "none";

export interface Reversal {
  orderId: string;
  kind: "released" | "voided";
  quantity: bigint;
}

export type EngineEvent =
  | { type: "order_rejected"; orderId: string; reason: RejectReason }
  | { type: "order_accepted"; orderId: string }
  | { type: "match"; match: Match }
  | { type: "order_filled"; orderId: string }
  | { type: "order_rested"; orderId: string; remaining: bigint }
  /** An iceberg showed a new slice with a new time priority (back of its price level). */
  | { type: "order_refreshed"; orderId: string; visible: bigint; prioritySeq: number }
  | { type: "order_cancelled"; orderId: string; reason: CancelReason; remaining: bigint }
  | { type: "order_expired"; orderId: string; remaining: bigint }
  | { type: "order_stale"; orderId: string; remaining: bigint }
  | { type: "order_reversed"; orderId: string; kind: Reversal["kind"]; quantity: bigint; matchId: string };

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

/**
 * An order as persisted, to rebuild the books after a restart: every non-terminal one,
 * and the `filled` ones with quantity still in flight (a failed match may return it).
 */
export interface RestoredOrder extends OrderInput {
  /** Its original arrival position (`orders.seq`). */
  seq: number;
  filledQuantity: bigint;
  releasedQuantity?: bigint;
  voidedQuantity?: bigint;
  status: "open" | "partially_filled" | "stale" | "filled";
  /** Its time priority (`orders.priority_seq`); absent = its seq (never refreshed). */
  prioritySeq?: number;
  /** Icebergs: the visible slice (`orders.visible_quantity`). */
  visibleQuantity?: bigint;
}

export interface RestoreInput {
  /** Every non-terminal order, in increasing `seq`. */
  orders: readonly RestoredOrder[];
  /**
   * Highest sequence ever given to an order or to an iceberg slice (0 if none): the
   * next order gets the one after.
   */
  lastOrderSeq: number;
  /** Highest match `sequence` ever made (0 if none). */
  lastMatchSeq: number;
}

/** Everything that decides the engine's future behavior, for comparing two engines. */
export interface EngineState {
  nextOrderSeq: number;
  nextMatchSeq: number;
  /** Sorted by (chain, asset). */
  markets: Market[];
  /** Order ids of each book in priority order, sorted by (chain, asset). */
  books: { chain: ChainId; asset: string; bids: string[]; asks: string[] }[];
  /** Non-terminal orders (open, partially filled, stale), by seq. */
  orders: OrderView[];
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
  /** Time priority: seq at arrival, the next sequence after each slice refresh. */
  priority: number;
  /** Icebergs: the visible slice while it rests (0 otherwise). Unused for other orders. */
  visible: bigint;
  filled: bigint;
  released: bigint;
  voided: bigint;
  status: OrderStatus;
}

interface Book {
  /** Sorted by price desc, then priority asc. */
  bids: OrderState[];
  /** Sorted by price asc, then priority asc. */
  asks: OrderState[];
}

const DEFAULT_MARGIN_SECS = 60;

export function marketKey(chain: ChainId, asset: string): string {
  return `${chain}\u0000${asset}`;
}

/** Matched and still standing: total matched minus what failed matches gave back or voided. */
function netOf(o: OrderState): bigint {
  return o.filled - o.released - o.voided;
}

function remainingOf(o: OrderState): bigint {
  return o.input.quantity - netOf(o);
}

function isIceberg(o: OrderState): boolean {
  return o.input.displayQuantity !== undefined;
}

/** What a resting order shows in the book, and what a taker can match of it now. */
function shownOf(o: OrderState): bigint {
  return isIceberg(o) ? o.visible : remainingOf(o);
}

/** The slice an iceberg shows when it rests or refreshes: min(display, remaining). */
function fullSliceOf(o: OrderState): bigint {
  return minBig(o.input.displayQuantity!, remainingOf(o));
}

/** True when `a` has priority over `b` on the same side of the book. */
function before(side: Side, a: OrderState, b: OrderState): boolean {
  if (a.input.limitPrice !== b.input.limitPrice) {
    return side === "buy" ? a.input.limitPrice > b.input.limitPrice : a.input.limitPrice < b.input.limitPrice;
  }
  return a.priority < b.priority;
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
    // Visible slices only: an iceberg's hidden quantity is never in a price level.
    if (last && last.price === o.input.limitPrice) {
      last.quantity += shownOf(o);
      last.orders += 1;
    } else {
      out.push({ price: o.input.limitPrice, quantity: shownOf(o), orders: 1 });
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
    const seq = this.nextSeq++;
    const taker: OrderState = {
      input: { ...input, timeInForce: input.timeInForce ?? "GTC" },
      seq,
      priority: seq,
      visible: 0n,
      filled: 0n,
      released: 0n,
      voided: 0n,
      status: "open",
    };
    this.orders.set(input.id, taker);

    const events: EngineEvent[] = [{ type: "order_accepted", orderId: input.id }];
    const matches: Match[] = [];
    this.matchAndRest(taker, now, events, matches);
    return { accepted: true, order: view(taker), matches, events };
  }

  /**
   * Matches `taker` against the opposite side (price-time priority, maker's price,
   * self-trade prevention, minimum notional), then rests its remainder at its own seq,
   * or cancels it if below the minimum. Used for new orders and for released ones.
   */
  private matchAndRest(taker: OrderState, now: number, events: EngineEvent[], matches: Match[]): void {
    const key = marketKey(taker.input.chain, taker.input.asset);
    const book = this.books.get(key)!;
    const market = this.markets.get(key)!;
    const opposite = taker.input.side === "buy" ? book.asks : book.bids;
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
      // A resting iceberg is matched up to its visible slice only.
      const shown = shownOf(maker);
      const quantity = minBig(remainingOf(taker), shown);
      if (notional(quantity, maker.input.lotSize, maker.input.limitPrice) < market.minOrderNotional) {
        // The order whose remainder (or visible slice) limits this match is below the minimum.
        if (shown === quantity) {
          opposite.shift();
          // An iceberg with hidden quantity shows a full slice instead, if that meets the
          // minimum (a minimum raised since it rested); otherwise it is cancelled.
          if (isIceberg(maker) && shown < remainingOf(maker)) this.refreshSlice(maker, opposite, market, events);
          else this.cancelBelowMin(maker, events);
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
      if (isIceberg(maker)) maker.visible -= quantity;
      if (remainingOf(maker) === 0n) {
        opposite.shift();
        maker.status = "filled";
        events.push({ type: "order_filled", orderId: maker.input.id });
      } else {
        maker.status = "partially_filled";
        if (this.belowMin(maker, market)) {
          opposite.shift();
          this.cancelBelowMin(maker, events);
        } else if (isIceberg(maker) && (maker.visible === 0n || this.belowMinQuantity(maker, maker.visible, market))) {
          // The slice is used up (or left below the minimum): a new slice, back of the queue.
          // If the taker is still marketable, the loop may reach it again in this pass.
          opposite.shift();
          this.refreshSlice(maker, opposite, market, events);
        }
      }
    }

    if (taker.status !== "cancelled") {
      if (remainingOf(taker) === 0n) {
        taker.status = "filled";
        events.push({ type: "order_filled", orderId: taker.input.id });
      } else if (isIoc(taker)) {
        this.cancelIocRemainder(taker, events);
      } else if (this.belowMin(taker, market)) {
        this.cancelBelowMin(taker, events);
      } else if (isIceberg(taker) && this.belowMinQuantity(taker, fullSliceOf(taker), market)) {
        // Only after a raised minimum: the signed display quantity met it at entry.
        this.cancelBelowMin(taker, events);
      } else {
        taker.status = netOf(taker) > 0n ? "partially_filled" : "open";
        // An iceberg rests its first slice (or, re-entering after a release, a full slice
        // at the priority it had).
        if (isIceberg(taker)) taker.visible = fullSliceOf(taker);
        insertSorted(taker.input.side, taker.input.side === "buy" ? book.bids : book.asks, taker);
        events.push({ type: "order_rested", orderId: taker.input.id, remaining: remainingOf(taker) });
      }
    }
  }

  /**
   * A match failed after both orders were filled. Each order gives back the match's
   * quantity: `voided` for a side at fault, `released` otherwise; nothing decreases
   * (`filled` stays, the quantity goes to `released` or `voided`).
   *
   * - a defaulting side becomes stale (out of the book; its wallet can cancel it);
   * - an innocent side re-enters the market with its original priority (seq), through
   *   the matching loop, so the book never crosses; if it is no longer live it expires;
   *   if it was cancelled, expired or stale, the release is accounting only;
   * - `expired`: both are released; an order whose expiry is at or before the match's
   *   expires, the other re-enters;
   * - `none` (refused for another reason, or retries ran out): both are released and
   *   become stale rather than re-enter, since they would match each other again.
   */
  reverse(
    m: Pick<Match, "id" | "buyOrderId" | "sellOrderId" | "quantity" | "expiresAt">,
    fault: MatchFault,
    now: number,
  ): { reversals: Reversal[]; events: EngineEvent[]; matches: Match[] } {
    assertTime(now);
    const buy = this.orders.get(m.buyOrderId);
    const sell = this.orders.get(m.sellOrderId);
    if (!buy || !sell) throw new EngineInvariantError(`reverse ${m.id}: the engine does not hold both orders`);
    for (const o of [buy, sell]) {
      if (netOf(o) < m.quantity) throw new EngineInvariantError(`reverse ${m.id}: ${o.input.id} has less matched than the match`);
    }
    const events: EngineEvent[] = [];
    const matches: Match[] = [];
    const reversals: Reversal[] = [];
    const atFault = (o: OrderState) =>
      fault === "both" || (fault === "seller" && o === sell) || (fault === "buyer" && o === buy);
    const terminalOrStale = (o: OrderState) => o.status === "cancelled" || o.status === "expired" || o.status === "stale";
    const rebook: OrderState[] = [];

    for (const o of [buy, sell]) {
      const kind: Reversal["kind"] = atFault(o) ? "voided" : "released";
      if (kind === "voided") o.voided += m.quantity;
      else o.released += m.quantity;
      reversals.push({ orderId: o.input.id, kind, quantity: m.quantity });
      events.push({ type: "order_reversed", orderId: o.input.id, kind, quantity: m.quantity, matchId: m.id });
      if (terminalOrStale(o)) continue; // accounting only
      this.removeFromBook(o);
      if (kind === "voided" || fault === "none") {
        o.status = "stale";
        events.push({ type: "order_stale", orderId: o.input.id, remaining: remainingOf(o) });
      } else if ((fault === "expired" && o.input.expiresAt <= m.expiresAt) || !this.live(o, now)) {
        o.status = "expired";
        events.push({ type: "order_expired", orderId: o.input.id, remaining: remainingOf(o) });
      } else if (isIoc(o)) {
        // An IOC was immediate: its released quantity does not wait for a later match.
        this.cancelIocRemainder(o, events);
      } else {
        o.status = netOf(o) > 0n ? "partially_filled" : "open";
        rebook.push(o);
      }
    }
    // Re-enter in priority order: the earlier order first. An iceberg keeps the priority
    // of its last slice and shows a full slice again.
    for (const o of rebook.sort((a, b) => a.priority - b.priority)) this.matchAndRest(o, now, events, matches);
    return { reversals, events, matches };
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

  /**
   * Rebuilds the books after a restart from the persisted non-terminal orders, in their
   * original sequence, keeping each order's seq (its time priority) and fill. Only on a
   * fresh engine, after its markets were upserted. Orders are restored as they were,
   * whatever the market's status or the clock: expiry is swept afterwards as usual.
   */
  restore(input: RestoreInput): void {
    if (this.orders.size > 0 || this.nextSeq !== 1 || this.nextMatchSeq !== 1) {
      throw new EngineInvariantError("restore needs a fresh engine");
    }
    for (const v of [input.lastOrderSeq, input.lastMatchSeq]) {
      if (!Number.isSafeInteger(v) || v < 0) throw new EngineInvariantError("last sequences must be non-negative integers");
    }
    let previousSeq = 0;
    const restored: OrderState[] = [];
    const priorities = new Set<number>();
    for (const r of input.orders) {
      const fail = (why: string) => new EngineInvariantError(`cannot restore order ${r.id}: ${why}`);
      if (this.orders.has(r.id) || restored.some((o) => o.input.id === r.id)) throw fail("duplicate id");
      if (!Number.isSafeInteger(r.seq) || r.seq <= previousSeq || r.seq > input.lastOrderSeq) {
        throw fail("seq out of order or above the last order seq");
      }
      previousSeq = r.seq;
      const market = this.markets.get(marketKey(r.chain, r.asset));
      if (!market) throw fail("unknown market");
      if (r.lotSize !== market.lotSize) throw fail("lot size differs from the market's");
      if (r.quantity <= 0n || r.quantity % r.lotSize !== 0n || r.limitPrice <= 0n) throw fail("invalid amounts");
      const released = r.releasedQuantity ?? 0n;
      const voided = r.voidedQuantity ?? 0n;
      const net = r.filledQuantity - released - voided;
      for (const v of [r.filledQuantity, released, voided]) {
        if (v < 0n || v % r.lotSize !== 0n) throw fail("quantities must be non-negative whole lots");
      }
      if (net < 0n || net > r.quantity) throw fail("net matched quantity out of range");
      const consistent =
        r.status === "stale" ||
        (r.status === "open" && net === 0n) ||
        (r.status === "partially_filled" && net > 0n && net < r.quantity) ||
        (r.status === "filled" && net === r.quantity);
      if (!consistent) throw fail("status does not match the net matched quantity");
      const timeInForce = r.timeInForce ?? "GTC";
      if (timeInForce !== "GTC" && timeInForce !== "IOC") throw fail("unknown time in force");
      if (timeInForce === "IOC" && (r.status === "open" || r.status === "partially_filled")) {
        throw fail("an IOC order never rests in the book");
      }
      const priority = r.prioritySeq ?? r.seq;
      if (!Number.isSafeInteger(priority) || priority < r.seq || priority > input.lastOrderSeq) {
        throw fail("priority out of range (from its seq to the last order seq)");
      }
      let visible = 0n;
      const display = r.displayQuantity;
      if (display === undefined) {
        if (r.prioritySeq !== undefined && r.prioritySeq !== r.seq) throw fail("only an iceberg gets a new priority");
        if (r.visibleQuantity !== undefined) throw fail("only an iceberg has a visible slice");
      } else {
        if (timeInForce !== "GTC") throw fail("an iceberg is GTC only");
        if (display <= 0n || display % r.lotSize !== 0n || display >= r.quantity) throw fail("invalid display quantity");
        visible = r.visibleQuantity ?? -1n;
        const remaining = r.quantity - net;
        if (visible < 0n || visible > display) throw fail("visible slice out of range");
        if ((r.status === "open" || r.status === "partially_filled") && (visible === 0n || visible > remaining)) {
          throw fail("a resting iceberg shows a slice of its remainder");
        }
      }
      // Priorities come from the arrival sequence: two orders never share one.
      for (const p of new Set([r.seq, priority])) {
        if (priorities.has(p)) throw fail("sequence or priority used twice");
        priorities.add(p);
      }
      const order: OrderInput = {
        id: r.id,
        chain: r.chain,
        asset: r.asset,
        paymentAsset: r.paymentAsset,
        wallet: r.wallet,
        side: r.side,
        quantity: r.quantity,
        limitPrice: r.limitPrice,
        lotSize: r.lotSize,
        expiresAt: r.expiresAt,
        timeInForce,
        ...(display !== undefined && { displayQuantity: display }),
      };
      restored.push({ input: order, seq: r.seq, priority, visible, filled: r.filledQuantity, released, voided, status: r.status });
    }
    for (const o of restored) {
      this.orders.set(o.input.id, o);
      if (o.status === "open" || o.status === "partially_filled") {
        const book = this.books.get(marketKey(o.input.chain, o.input.asset))!;
        insertSorted(o.input.side, o.input.side === "buy" ? book.bids : book.asks, o);
      }
    }
    this.nextSeq = input.lastOrderSeq + 1;
    this.nextMatchSeq = input.lastMatchSeq + 1;
  }

  exportState(): EngineState {
    const byKey = <T extends { chain: ChainId; asset: string }>(a: T, b: T) =>
      marketKey(a.chain, a.asset) < marketKey(b.chain, b.asset) ? -1 : 1;
    const books: EngineState["books"] = [];
    for (const [key, b] of this.books) {
      const m = this.markets.get(key)!;
      books.push({
        chain: m.chain,
        asset: m.asset,
        bids: b.bids.map((o) => o.input.id),
        asks: b.asks.map((o) => o.input.id),
      });
    }
    const orders = [...this.orders.values()]
      .filter((o) => o.status === "open" || o.status === "partially_filled" || o.status === "stale")
      .sort((a, b) => a.seq - b.seq)
      .map(view);
    return {
      nextOrderSeq: this.nextSeq,
      nextMatchSeq: this.nextMatchSeq,
      markets: [...this.markets.values()].map((m) => ({ ...m })).sort(byKey),
      books: books.sort(byKey),
      orders,
    };
  }

  /**
   * The resting orders an incoming order could trade with, best first: live (outside the
   * settlement margin), on the opposite side, crossing its limit price, and not in
   * `skip`. An iceberg can trade its whole remainder through refreshed slices, but only
   * its visible slice before the orders behind it. Read-only: lets the caller check them (e.g. on-chain delegations) before
   * `place`.
   */
  crossingOrders(
    incoming: Pick<OrderInput, "chain" | "asset" | "side" | "limitPrice">,
    now: number,
    limit: number,
    skip: ReadonlySet<string> = new Set(),
  ): OrderView[] {
    const book = this.books.get(marketKey(incoming.chain, incoming.asset));
    if (!book) return [];
    const out: OrderView[] = [];
    for (const o of incoming.side === "buy" ? book.asks : book.bids) {
      if (out.length >= limit) break;
      if (!crosses(incoming as OrderInput, o.input)) break;
      if (!this.live(o, now) || skip.has(o.input.id)) continue;
      out.push(view(o));
    }
    return out;
  }

  getOrder(orderId: string): OrderView | undefined {
    const o = this.orders.get(orderId);
    return o ? view(o) : undefined;
  }

  /**
   * Price levels of a book. With `now`, orders that are no longer matchable (within the
   * settlement margin of their expiry) are left out even before `expire` sweeps them.
   */
  book(chain: ChainId, asset: string, now?: number): BookSnapshot {
    const b = this.books.get(marketKey(chain, asset)) ?? { bids: [], asks: [] };
    const keep = (list: OrderState[]) => (now === undefined ? list : list.filter((o) => this.live(o, now)));
    return { chain, asset, bids: levels(keep(b.bids)), asks: levels(keep(b.asks)) };
  }

  private validate(input: OrderInput, now: number): RejectReason | null {
    if (this.orders.has(input.id)) return "duplicate_order_id";
    const market = this.markets.get(marketKey(input.chain, input.asset));
    if (!market) return "unknown_market";
    if (market.assetClass !== "equity") return "not_order_book_asset";
    if (market.status !== "approved") return "market_not_approved";
    if (input.paymentAsset !== market.quoteAsset) return "wrong_payment_asset";
    if (input.lotSize !== market.lotSize) return "lot_size_mismatch";
    if (input.timeInForce !== undefined && input.timeInForce !== "GTC" && input.timeInForce !== "IOC") return "invalid_time_in_force";
    if (input.quantity <= 0n) return "invalid_quantity";
    if (input.limitPrice <= 0n) return "invalid_price";
    if (input.quantity % market.lotSize !== 0n) return "not_whole_lots";
    if (notional(input.quantity, market.lotSize, input.limitPrice) < market.minOrderNotional) return "below_min_notional";
    const display = input.displayQuantity;
    if (display !== undefined) {
      if (input.timeInForce === "IOC") return "iceberg_requires_gtc";
      if (typeof display !== "bigint" || display <= 0n || display % market.lotSize !== 0n || display >= input.quantity) {
        return "invalid_display_quantity";
      }
      // Each full slice must meet the minimum; the last slice is the remainder (remainder rule).
      if (notional(display, market.lotSize, input.limitPrice) < market.minOrderNotional) return "display_below_min_notional";
    }
    if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt - now <= this.margin) return "expired";
    return null;
  }

  /** True when the order's remainder, valued at its own limit price, is below the minimum. */
  private belowMin(o: OrderState, market: Market): boolean {
    return this.belowMinQuantity(o, remainingOf(o), market);
  }

  /** True when `quantity` of the order, valued at its own limit price, is below the minimum. */
  private belowMinQuantity(o: OrderState, quantity: bigint, market: Market): boolean {
    return notional(quantity, o.input.lotSize, o.input.limitPrice) < market.minOrderNotional;
  }

  /**
   * An iceberg (already out of `list`, with hidden quantity) shows a new slice of
   * min(display, remaining) at the same price, with the next sequence as its priority:
   * behind every order already resting. If that slice is below the minimum (only after
   * the minimum was raised), the order is cancelled instead.
   */
  private refreshSlice(o: OrderState, list: OrderState[], market: Market, events: EngineEvent[]): void {
    const slice = fullSliceOf(o);
    if (this.belowMinQuantity(o, slice, market)) {
      this.cancelBelowMin(o, events);
      return;
    }
    o.visible = slice;
    o.priority = this.nextSeq++;
    insertSorted(o.input.side, list, o);
    events.push({ type: "order_refreshed", orderId: o.input.id, visible: slice, prioritySeq: o.priority });
  }

  /** Cancels an IOC order's unmatched remainder (it is never in the book). */
  private cancelIocRemainder(o: OrderState, events: EngineEvent[]): void {
    o.status = "cancelled";
    events.push({ type: "order_cancelled", orderId: o.input.id, reason: "ioc_unfilled", remaining: remainingOf(o) });
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

function isIoc(o: OrderState): boolean {
  return o.input.timeInForce === "IOC";
}

function view(o: OrderState): OrderView {
  return {
    ...o.input,
    seq: o.seq,
    filledQuantity: o.filled,
    releasedQuantity: o.released,
    voidedQuantity: o.voided,
    remaining: remainingOf(o),
    status: o.status,
    prioritySeq: o.priority,
    ...(isIceberg(o) && { visibleQuantity: o.visible }),
  };
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
