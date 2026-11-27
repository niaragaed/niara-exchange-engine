import { describe, expect, it } from "vitest";
import { EngineInvariantError, MatchingEngine, type EngineEvent, type RestoredOrder } from "../../src/engine/engine.ts";
import type { OrderInput } from "../../src/engine/types.ts";
import { ASSET, CHAIN, LOT, NOW, market, order, seededUuidV4 } from "./helpers.ts";

/**
 * Iceberg orders (intent v3, `displayQuantity`): only the visible slice rests; a used-up
 * slice is refreshed at the same price with a new time priority. Labeled test wallets
 * and assets only.
 */

const lots = (n: number) => BigInt(n) * LOT;

function engine(min = 0n): MatchingEngine {
  const e = new MatchingEngine({ newMatchId: seededUuidV4(11), settlementMarginSecs: 60 });
  e.upsertMarket(market({ minOrderNotional: min }));
  return e;
}

function place(e: MatchingEngine, input: OrderInput) {
  const r = e.place(input, NOW);
  if (!r.accepted) throw new Error(`refused: ${r.reason}`);
  return r;
}

const iceberg = (id: string, side: "buy" | "sell", total: number, display: number, price: bigint, wallet = `w-${id}`): OrderInput =>
  order({ id, side, wallet, quantity: lots(total), displayQuantity: lots(display), limitPrice: price });

const asks = (e: MatchingEngine) => e.exportState().books.find((b) => b.asset === ASSET)!.asks;
const refreshed = (events: readonly EngineEvent[]) => events.filter((ev) => ev.type === "order_refreshed");

describe("iceberg: what rests and what the book shows", () => {
  it("rests only the visible slice; the book shows the slice, never the hidden quantity", () => {
    const e = engine();
    const r = place(e, iceberg("ice", "sell", 10, 3, 100n));
    expect(r.order).toMatchObject({ status: "open", remaining: lots(10), displayQuantity: lots(3), visibleQuantity: lots(3), prioritySeq: 1 });
    expect(e.book(CHAIN, ASSET).asks).toEqual([{ price: 100n, quantity: lots(3), orders: 1 }]);
  });

  it("an order shown whole (v1/v2) is unchanged: no slice, its priority is its seq, the book shows its remainder", () => {
    const e = engine();
    const r = place(e, order({ id: "plain", side: "sell", wallet: "s", quantity: lots(10), limitPrice: 100n }));
    expect(r.order.visibleQuantity).toBeUndefined();
    expect(r.order.displayQuantity).toBeUndefined();
    expect(r.order.prioritySeq).toBe(r.order.seq);
    expect(e.book(CHAIN, ASSET).asks).toEqual([{ price: 100n, quantity: lots(10), orders: 1 }]);
  });

  it("an incoming iceberg matches its whole remainder (hidden included), then rests one slice", () => {
    const e = engine();
    place(e, order({ id: "ask", side: "sell", wallet: "s", quantity: lots(5), limitPrice: 100n }));
    const r = place(e, iceberg("ice-buy", "buy", 10, 2, 100n));
    expect(r.matches.map((m) => m.quantity)).toEqual([lots(5)]);
    expect(r.order).toMatchObject({ status: "partially_filled", remaining: lots(5), visibleQuantity: lots(2) });
    expect(e.book(CHAIN, ASSET).bids).toEqual([{ price: 100n, quantity: lots(2), orders: 1 }]);
  });
});

describe("iceberg: refresh and priority", () => {
  it("a fully filled slice is refreshed at the same price with a new priority, behind orders already resting", () => {
    const e = engine();
    place(e, iceberg("ice", "sell", 6, 2, 100n)); // seq 1
    place(e, order({ id: "plain", side: "sell", wallet: "p", quantity: lots(2), limitPrice: 100n })); // seq 2
    expect(asks(e)).toEqual(["ice", "plain"]);

    const first = place(e, order({ id: "b1", side: "buy", wallet: "b", quantity: lots(2), limitPrice: 100n })); // seq 3
    expect(first.matches.map((m) => [m.makerOrderId, m.quantity])).toEqual([["ice", lots(2)]]);
    expect(refreshed(first.events)).toEqual([{ type: "order_refreshed", orderId: "ice", visible: lots(2), prioritySeq: 4 }]);
    expect(asks(e)).toEqual(["plain", "ice"]); // lost its place
    expect(e.getOrder("ice")).toMatchObject({ seq: 1, prioritySeq: 4, visibleQuantity: lots(2), remaining: lots(4) });

    // The next buyer meets the plain order first; a later arrival rests behind the slice.
    const second = place(e, order({ id: "b2", side: "buy", wallet: "b", quantity: lots(2), limitPrice: 100n })); // seq 5
    expect(second.matches.map((m) => m.makerOrderId)).toEqual(["plain"]);
    place(e, order({ id: "late", side: "sell", wallet: "l", quantity: lots(1), limitPrice: 100n })); // seq 6
    expect(asks(e)).toEqual(["ice", "late"]);
    expect(e.book(CHAIN, ASSET).asks).toEqual([{ price: 100n, quantity: lots(3), orders: 2 }]);
  });

  it("one taker fills several refreshed slices in one pass, in price-time order with the orders between them", () => {
    const e = engine();
    place(e, iceberg("ice", "sell", 7, 2, 100n));
    place(e, order({ id: "plain", side: "sell", wallet: "p", quantity: lots(1), limitPrice: 100n }));
    place(e, order({ id: "worse", side: "sell", wallet: "x", quantity: lots(5), limitPrice: 101n }));
    const r = place(e, order({ id: "sweep", side: "buy", wallet: "b", quantity: lots(9), limitPrice: 101n }));
    expect(r.matches.map((m) => [m.makerOrderId, m.quantity, m.price])).toEqual([
      ["ice", lots(2), 100n],
      ["plain", lots(1), 100n], // rested before the first refresh
      ["ice", lots(2), 100n],
      ["ice", lots(2), 100n],
      ["ice", lots(1), 100n], // the last slice is the remainder
      ["worse", lots(1), 101n], // only then the next price
    ]);
    expect(refreshed(r.events).map((ev) => ev.type === "order_refreshed" && ev.visible)).toEqual([lots(2), lots(2), lots(1)]);
    expect(e.getOrder("ice")).toMatchObject({ status: "filled", remaining: 0n });
    expect(e.book(CHAIN, ASSET).asks).toEqual([{ price: 101n, quantity: lots(4), orders: 1 }]);
  });

  it("a partial slice fill keeps the slice and its priority; the book shows what is left of it", () => {
    const e = engine();
    place(e, iceberg("ice", "sell", 10, 4, 100n));
    place(e, order({ id: "plain", side: "sell", wallet: "p", quantity: lots(1), limitPrice: 100n }));
    const r = place(e, order({ id: "b", side: "buy", wallet: "b", quantity: lots(1), limitPrice: 100n }));
    expect(refreshed(r.events)).toEqual([]);
    expect(e.getOrder("ice")).toMatchObject({ prioritySeq: 1, visibleQuantity: lots(3), remaining: lots(9), status: "partially_filled" });
    expect(asks(e)).toEqual(["ice", "plain"]);
    expect(e.book(CHAIN, ASSET).asks).toEqual([{ price: 100n, quantity: lots(4), orders: 2 }]);
  });

  it("a partly filled slice worth less than the minimum is refreshed (never left below it while hidden quantity remains)", () => {
    const e = engine(300n); // 3 lots at 100
    place(e, iceberg("ice", "sell", 10, 4, 100n));
    const r = place(e, order({ id: "b", side: "buy", wallet: "b", quantity: lots(3), limitPrice: 100n }));
    expect(r.matches.map((m) => m.quantity)).toEqual([lots(3)]);
    expect(refreshed(r.events)).toHaveLength(1);
    expect(e.getOrder("ice")).toMatchObject({ visibleQuantity: lots(4), remaining: lots(7), status: "partially_filled" });
    expect(e.getOrder("ice")!.prioritySeq).toBeGreaterThan(1);
  });

  it("the last slice is the remainder, and a remainder below the minimum is cancelled as for any order", () => {
    const e = engine(300n);
    place(e, iceberg("ice", "sell", 8, 3, 100n));
    const r = place(e, order({ id: "b", side: "buy", wallet: "b", quantity: lots(6), limitPrice: 100n }));
    expect(r.matches.map((m) => m.quantity)).toEqual([lots(3), lots(3)]);
    expect(e.getOrder("ice")).toMatchObject({ status: "cancelled", remaining: lots(2) });
    expect(r.events).toContainEqual({ type: "order_cancelled", orderId: "ice", reason: "below_min_notional", remaining: lots(2) });
  });

  it("after the minimum was raised above a full slice, matching cancels the iceberg instead of showing more than its display", () => {
    const e = engine(0n);
    place(e, iceberg("ice", "sell", 10, 2, 100n));
    e.upsertMarket(market({ minOrderNotional: 300n }));
    const r = place(e, order({ id: "b", side: "buy", wallet: "b", quantity: lots(5), limitPrice: 100n }));
    expect(r.matches).toEqual([]);
    expect(e.getOrder("ice")).toMatchObject({ status: "cancelled", remaining: lots(10) });
    expect(r.events).toContainEqual({ type: "order_cancelled", orderId: "ice", reason: "below_min_notional", remaining: lots(10) });
    expect(e.book(CHAIN, ASSET).bids).toEqual([{ price: 100n, quantity: lots(5), orders: 1 }]);
  });

  it("self-trade prevention is unchanged: the wallet's incoming order is cancelled, its resting iceberg stays", () => {
    const e = engine();
    place(e, iceberg("ice", "sell", 10, 2, 100n, "same"));
    const r = place(e, order({ id: "own", side: "buy", wallet: "same", quantity: lots(3), limitPrice: 100n }));
    expect(r.order).toMatchObject({ status: "cancelled" });
    expect(r.events).toContainEqual({ type: "order_cancelled", orderId: "own", reason: "self_trade_prevention", remaining: lots(3) });
    expect(e.getOrder("ice")).toMatchObject({ status: "open", visibleQuantity: lots(2), remaining: lots(10) });
  });
});

describe("iceberg: cancel, failed match, restart", () => {
  it("cancel mid-iceberg takes the whole remainder (visible and hidden) out of the book", () => {
    const e = engine();
    place(e, iceberg("ice", "sell", 10, 3, 100n));
    place(e, order({ id: "b", side: "buy", wallet: "b", quantity: lots(4), limitPrice: 100n }));
    expect(e.getOrder("ice")).toMatchObject({ remaining: lots(6), visibleQuantity: lots(2) });
    const c = e.cancel("ice", "w-ice");
    expect(c).toMatchObject({ cancelled: true, order: { status: "cancelled", remaining: lots(6) } });
    expect(c.cancelled && c.events).toEqual([{ type: "order_cancelled", orderId: "ice", reason: "by_wallet", remaining: lots(6) }]);
    expect(e.book(CHAIN, ASSET).asks).toEqual([]);
  });

  it("an innocent iceberg re-enters after a failed match at the priority it had, showing a full slice", () => {
    const e = engine();
    place(e, iceberg("ice", "sell", 6, 2, 100n));
    const m = place(e, order({ id: "b", side: "buy", wallet: "b", quantity: lots(2), limitPrice: 100n })).matches[0]!;
    const priority = e.getOrder("ice")!.prioritySeq;
    place(e, order({ id: "behind", side: "sell", wallet: "p", quantity: lots(1), limitPrice: 100n }));
    const r = e.reverse(m, "buyer", NOW);
    expect(r.reversals).toContainEqual({ orderId: "ice", kind: "released", quantity: lots(2) });
    expect(e.getOrder("ice")).toMatchObject({ status: "open", prioritySeq: priority, visibleQuantity: lots(2), remaining: lots(6) });
    expect(asks(e)).toEqual(["ice", "behind"]);
  });

  it("restore keeps each slice and its priority; the restored engine behaves the same", () => {
    const build = () => {
      const e = engine();
      place(e, iceberg("ice", "sell", 6, 2, 100n));
      place(e, order({ id: "plain", side: "sell", wallet: "p", quantity: lots(2), limitPrice: 100n }));
      place(e, order({ id: "b", side: "buy", wallet: "b", quantity: lots(3), limitPrice: 100n }));
      return e;
    };
    const before = build();
    const s = before.exportState();
    const after = new MatchingEngine({ newMatchId: seededUuidV4(11), settlementMarginSecs: 60 });
    after.upsertMarket(market());
    after.restore({
      orders: s.orders.map((o): RestoredOrder => ({
        ...o,
        status: o.status as RestoredOrder["status"],
        ...(o.displayQuantity !== undefined && { prioritySeq: o.prioritySeq }),
      })),
      lastOrderSeq: s.nextOrderSeq - 1,
      lastMatchSeq: s.nextMatchSeq - 1,
    });
    expect(after.exportState()).toEqual(s);
    // Advance the original's match ids to the same point, then compare a sweep.
    const sweep = order({ id: "sweep", side: "buy", wallet: "z", quantity: lots(5), limitPrice: 100n });
    const strip = (r: ReturnType<typeof place>) => r.matches.map((m) => [m.makerOrderId, m.quantity, m.sequence]);
    expect(strip(place(after, sweep))).toEqual(strip(place(before, sweep)));
  });

  it("restore refuses a resting iceberg without a valid slice, and a priority on an order shown whole", () => {
    const base: RestoredOrder = {
      ...iceberg("ice", "sell", 6, 2, 100n),
      seq: 1,
      filledQuantity: 0n,
      status: "open",
      visibleQuantity: lots(2),
    };
    const restoreWith = (o: RestoredOrder, last = 5) => {
      const e = new MatchingEngine({ newMatchId: seededUuidV4(1) });
      e.upsertMarket(market());
      e.restore({ orders: [o], lastOrderSeq: last, lastMatchSeq: 0 });
    };
    expect(() => restoreWith(base)).not.toThrow();
    expect(() => restoreWith({ ...base, visibleQuantity: 0n })).toThrow(EngineInvariantError);
    expect(() => restoreWith({ ...base, visibleQuantity: lots(3) })).toThrow(/visible slice/);
    expect(() => restoreWith({ ...base, prioritySeq: 9 })).toThrow(/priority/);
    expect(() => restoreWith({ ...base, timeInForce: "IOC", status: "stale" })).toThrow(/an iceberg is GTC only/);
    const { displayQuantity: _d, visibleQuantity: _v, ...plain } = base;
    expect(() => restoreWith({ ...plain, prioritySeq: 3 })).toThrow(/only an iceberg/);
  });
});

describe("iceberg: admission rules", () => {
  it("is GTC only: an IOC with a display quantity is refused (iceberg_requires_gtc)", () => {
    const r = engine().place({ ...iceberg("x", "buy", 10, 2, 100n), timeInForce: "IOC" }, NOW);
    expect(r).toMatchObject({ accepted: false, reason: "iceberg_requires_gtc" });
  });

  it("needs 1 lot <= display < quantity, in whole lots", () => {
    const e = engine();
    for (const displayQuantity of [0n, lots(10), lots(11), LOT + 1n, -LOT]) {
      expect(e.place({ ...iceberg(`x${displayQuantity}`, "buy", 10, 1, 100n), displayQuantity }, NOW)).toMatchObject({
        accepted: false,
        reason: "invalid_display_quantity",
      });
    }
    expect(e.place(iceberg("one-lot", "buy", 10, 1, 100n), NOW).accepted).toBe(true);
  });

  it("each slice must meet the minimum order value: a display below it is refused (display_below_min_notional)", () => {
    const e = engine(300n); // 3 lots at 100
    expect(e.place(iceberg("small", "sell", 10, 2, 100n), NOW)).toMatchObject({ accepted: false, reason: "display_below_min_notional" });
    expect(e.place(iceberg("ok", "sell", 10, 3, 100n), NOW).accepted).toBe(true);
  });

  it("the delegate pre-check sees an iceberg's visible slice and its whole remainder", () => {
    const e = engine();
    place(e, iceberg("ice", "sell", 10, 2, 100n));
    const [c] = e.crossingOrders({ chain: CHAIN, asset: ASSET, side: "buy", limitPrice: 100n }, NOW, 10);
    expect(c).toMatchObject({ id: "ice", visibleQuantity: lots(2), remaining: lots(10) });
  });
});
