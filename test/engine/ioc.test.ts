import { describe, expect, it } from "vitest";
import { EngineInvariantError, MatchingEngine, type RestoredOrder } from "../../src/engine/engine.ts";
import { LOT, NOW, market, order, seededUuidV4 } from "./helpers.ts";

/** Immediate-or-cancel orders: match at once up to the limit, cancel the rest, never rest. */

function engine(min = 0n): MatchingEngine {
  const e = new MatchingEngine({ newMatchId: seededUuidV4(7), settlementMarginSecs: 60 });
  e.upsertMarket(market({ minOrderNotional: min }));
  return e;
}
const lots = (n: number) => BigInt(n) * LOT;

describe("IOC orders", () => {
  it("sweep the book up to the limit price, cancel the rest as ioc_unfilled, and never rest", () => {
    const e = engine();
    e.place(order({ id: "ask-100", side: "sell", wallet: "s1", quantity: lots(2), limitPrice: 100n }), NOW);
    e.place(order({ id: "ask-101", side: "sell", wallet: "s2", quantity: lots(3), limitPrice: 101n }), NOW);
    e.place(order({ id: "ask-105", side: "sell", wallet: "s3", quantity: lots(4), limitPrice: 105n }), NOW);
    const r = e.place(order({ id: "mkt-buy", side: "buy", wallet: "b", quantity: lots(10), limitPrice: 102n, timeInForce: "IOC" }), NOW);
    if (!r.accepted) throw new Error("refused");
    expect(r.matches.map((m) => [m.price, m.quantity])).toEqual([
      [100n, lots(2)],
      [101n, lots(3)],
    ]);
    expect(r.order).toMatchObject({ status: "cancelled", filledQuantity: lots(5), remaining: lots(5), timeInForce: "IOC" });
    expect(r.events.at(-1)).toEqual({ type: "order_cancelled", orderId: "mkt-buy", reason: "ioc_unfilled", remaining: lots(5) });
    expect(r.events.some((ev) => ev.type === "order_rested")).toBe(false);
    const b = e.book(market().chain, market().asset);
    expect(b.bids).toEqual([]); // nothing rested
    expect(b.asks).toEqual([{ price: 105n, quantity: lots(4), orders: 1 }]); // beyond the cap: untouched
  });

  it("fills completely when the book holds enough within the limit", () => {
    const e = engine();
    e.place(order({ id: "bid", side: "buy", wallet: "b", quantity: lots(5), limitPrice: 50n }), NOW);
    const r = e.place(order({ id: "mkt-sell", side: "sell", wallet: "s", quantity: lots(5), limitPrice: 49n, timeInForce: "IOC" }), NOW);
    if (!r.accepted) throw new Error("refused");
    expect(r.order.status).toBe("filled");
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0]!.price).toBe(50n); // the maker's price, better than the cap
    expect(r.events.some((ev) => ev.type === "order_cancelled")).toBe(false);
  });

  it("with nothing to match, is cancelled whole and leaves the book unchanged", () => {
    const e = engine();
    e.place(order({ id: "ask", side: "sell", wallet: "s", quantity: lots(2), limitPrice: 110n }), NOW);
    const before = e.book(market().chain, market().asset);
    const r = e.place(order({ id: "ioc", side: "buy", wallet: "b", quantity: lots(2), limitPrice: 100n, timeInForce: "IOC" }), NOW);
    if (!r.accepted) throw new Error("refused");
    expect(r.order).toMatchObject({ status: "cancelled", filledQuantity: 0n, remaining: lots(2) });
    expect(r.matches).toEqual([]);
    expect(e.book(market().chain, market().asset)).toEqual(before);
  });

  it("self-trade prevention still applies (reason self_trade_prevention)", () => {
    const e = engine();
    e.place(order({ id: "own-ask", side: "sell", wallet: "w", quantity: lots(2), limitPrice: 100n }), NOW);
    const r = e.place(order({ id: "ioc", side: "buy", wallet: "w", quantity: lots(2), limitPrice: 100n, timeInForce: "IOC" }), NOW);
    if (!r.accepted) throw new Error("refused");
    expect(r.events.filter((ev) => ev.type === "order_cancelled").map((ev) => ev.type === "order_cancelled" && ev.reason)).toEqual(["self_trade_prevention"]);
  });

  it("a remainder below the minimum notional is still cancelled as ioc_unfilled (it was never going to rest)", () => {
    const e = engine(300n);
    e.place(order({ id: "ask", side: "sell", wallet: "s", quantity: lots(3), limitPrice: 100n }), NOW);
    const r = e.place(order({ id: "ioc", side: "buy", wallet: "b", quantity: lots(4), limitPrice: 100n, timeInForce: "IOC" }), NOW);
    if (!r.accepted) throw new Error("refused");
    expect(r.order).toMatchObject({ status: "cancelled", remaining: lots(1) });
    expect(r.events.at(-1)).toMatchObject({ type: "order_cancelled", reason: "ioc_unfilled" });
  });

  it("GTC stays the default; an unknown time in force is refused", () => {
    const e = engine();
    const r = e.place(order({ id: "gtc", side: "buy", wallet: "b", quantity: lots(1), limitPrice: 10n }), NOW);
    if (!r.accepted) throw new Error("refused");
    expect(r.order).toMatchObject({ status: "open", timeInForce: "GTC" });
    const bad = e.place(order({ id: "fok", side: "buy", wallet: "b", timeInForce: "FOK" as never }), NOW);
    expect(bad).toMatchObject({ accepted: false, reason: "invalid_time_in_force" });
  });
});

describe("IOC and failed matches", () => {
  const setup = () => {
    const e = engine();
    e.place(order({ id: "ask", side: "sell", wallet: "s", quantity: lots(2), limitPrice: 100n }), NOW);
    const r = e.place(order({ id: "ioc", side: "buy", wallet: "b", quantity: lots(2), limitPrice: 100n, timeInForce: "IOC" }), NOW);
    if (!r.accepted) throw new Error("refused");
    return { e, match: r.matches[0]! };
  };

  it("an innocent IOC's released quantity is cancelled (ioc_unfilled), never put in the book", () => {
    const { e, match } = setup();
    // A new ask that the released IOC would cross if it re-entered.
    e.place(order({ id: "ask-2", side: "sell", wallet: "s2", quantity: lots(2), limitPrice: 90n }), NOW + 1);
    const r = e.reverse(match, "seller", NOW + 2);
    expect(r.matches).toEqual([]); // the IOC did not trade again later
    expect(e.getOrder("ioc")).toMatchObject({ status: "cancelled", releasedQuantity: lots(2), remaining: lots(2) });
    expect(r.events).toContainEqual({ type: "order_cancelled", orderId: "ioc", reason: "ioc_unfilled", remaining: lots(2) });
    expect(e.book(market().chain, market().asset).bids).toEqual([]);
    expect(e.getOrder("ask")!.status).toBe("stale"); // the seller defaulted
  });

  it("an IOC at fault becomes stale, out of the book, as any order", () => {
    const { e, match } = setup();
    e.reverse(match, "buyer", NOW + 2);
    expect(e.getOrder("ioc")!.status).toBe("stale");
    expect(e.book(market().chain, market().asset).bids).toEqual([]);
  });
});

describe("restore", () => {
  const base = (o: Partial<RestoredOrder>): RestoredOrder => ({
    ...order({ side: "buy", wallet: "b" }),
    seq: 1,
    filledQuantity: 0n,
    status: "open",
    ...o,
  });
  it("refuses an IOC order that would rest, and keeps a filled IOC (a failed match may still release it)", () => {
    const fresh = () => {
      const e = new MatchingEngine({ newMatchId: seededUuidV4(1) });
      e.upsertMarket(market());
      return e;
    };
    expect(() => fresh().restore({ orders: [base({ timeInForce: "IOC" })], lastOrderSeq: 1, lastMatchSeq: 0 })).toThrow(EngineInvariantError);
    const e = fresh();
    e.restore({ orders: [base({ id: "f", timeInForce: "IOC", status: "filled", filledQuantity: lots(10) })], lastOrderSeq: 1, lastMatchSeq: 0 });
    expect(e.getOrder("f")).toMatchObject({ status: "filled", timeInForce: "IOC" });
    expect(e.book(market().chain, market().asset).bids).toEqual([]);
  });
});
