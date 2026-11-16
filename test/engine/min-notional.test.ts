import { beforeEach, describe, expect, it } from "vitest";
import { MatchingEngine, type EngineEvent, type PlaceResult } from "../../src/engine/engine.ts";
import type { Match } from "../../src/engine/types.ts";
import { LOT, NOW, market, order, seededUuidV4 } from "./helpers.ts";

/**
 * Spec §9.12 item 1: the minimum order notional is checked when an order is admitted
 * and when a match is made; a remainder below it is cancelled. Here the minimum is
 * 10,000 USDT base units, i.e. 10 lots at a price of 1,000 per lot.
 */

const MIN = 10_000n;
let engine: MatchingEngine;

function placed(r: PlaceResult): { matches: Match[]; events: EngineEvent[] } {
  if (!r.accepted) throw new Error(`rejected: ${r.reason}`);
  return r;
}

function cancelledBelowMin(events: EngineEvent[]): string[] {
  return events.flatMap((e) => (e.type === "order_cancelled" && e.reason === "below_min_notional" ? [e.orderId] : []));
}

beforeEach(() => {
  engine = new MatchingEngine({ newMatchId: seededUuidV4(7) });
  engine.upsertMarket(market({ minOrderNotional: MIN }));
});

describe("minimum notional at admission", () => {
  it("refuses an order below the minimum and accepts one exactly at it", () => {
    const below = engine.place(order({ side: "sell", wallet: "alice", quantity: 9n * LOT, limitPrice: 1_000n }), NOW);
    expect(below.accepted ? null : below.reason).toBe("below_min_notional");
    expect(engine.place(order({ side: "sell", wallet: "alice", quantity: 10n * LOT, limitPrice: 1_000n }), NOW).accepted).toBe(
      true,
    );
  });
});

describe("minimum notional at match time", () => {
  it("cancels a resting order whose remainder falls below the minimum after a partial fill", () => {
    const maker = order({ side: "sell", wallet: "alice", quantity: 15n * LOT, limitPrice: 1_000n });
    engine.place(maker, NOW);
    const r = placed(engine.place(order({ side: "buy", wallet: "bob", quantity: 10n * LOT, limitPrice: 1_000n }), NOW));
    expect(r.matches.map((m) => m.quantity)).toEqual([10n * LOT]);
    expect(cancelledBelowMin(r.events)).toEqual([maker.id]);
    expect(engine.getOrder(maker.id)).toMatchObject({ status: "cancelled", filledQuantity: 10n * LOT, remaining: 5n * LOT });
    expect(engine.book(maker.chain, maker.asset).asks).toEqual([]);
  });

  it("cancels an incoming order's remainder below the minimum instead of resting it", () => {
    engine.place(order({ side: "sell", wallet: "alice", quantity: 10n * LOT, limitPrice: 1_000n }), NOW);
    const taker = order({ side: "buy", wallet: "bob", quantity: 15n * LOT, limitPrice: 1_000n });
    const r = placed(engine.place(taker, NOW));
    expect(r.matches).toHaveLength(1);
    expect(cancelledBelowMin(r.events)).toEqual([taker.id]);
    expect(r.events.some((e) => e.type === "order_rested")).toBe(false);
    expect(engine.getOrder(taker.id)).toMatchObject({ status: "cancelled", filledQuantity: 10n * LOT });
    expect(engine.book(taker.chain, taker.asset).bids).toEqual([]);
  });

  it("values a sell remainder at its own limit price, not at the trade price", () => {
    engine.place(order({ side: "buy", wallet: "alice", quantity: 10n * LOT, limitPrice: 1_200n }), NOW);
    const taker = order({ side: "sell", wallet: "bob", quantity: 15n * LOT, limitPrice: 1_000n });
    const r = placed(engine.place(taker, NOW));
    expect(r.matches.map((m) => m.paymentAmount)).toEqual([12_000n]);
    // 5 lots at 1,000 = 5,000 < 10,000.
    expect(cancelledBelowMin(r.events)).toEqual([taker.id]);
  });

  it("never makes a match below the minimum: the limiting incoming order is cancelled, and no worse price is tried", () => {
    // 20 lots at 900 = 18,000 and 20 lots at 1,200 = 24,000: both above the minimum.
    const cheap = order({ side: "sell", wallet: "alice", quantity: 20n * LOT, limitPrice: 900n });
    const dear = order({ side: "sell", wallet: "carol", quantity: 20n * LOT, limitPrice: 1_200n });
    engine.place(cheap, NOW);
    engine.place(dear, NOW);
    // 10 lots at up to 1,500 = 15,000 at its own limit, but 9,000 at the best ask.
    const taker = order({ side: "buy", wallet: "bob", quantity: 10n * LOT, limitPrice: 1_500n });
    const r = placed(engine.place(taker, NOW));
    expect(r.matches).toEqual([]);
    expect(cancelledBelowMin(r.events)).toEqual([taker.id]);
    expect(engine.getOrder(cheap.id)?.status).toBe("open");
    expect(engine.getOrder(dear.id)?.status).toBe("open");
    const book = engine.book(taker.chain, taker.asset);
    expect(book.bids).toEqual([]);
    expect(book.asks.map((l) => l.price)).toEqual([900n, 1_200n]);
  });

  it("cancels a resting order left below a raised minimum when it would limit a match, then keeps matching", () => {
    engine.upsertMarket(market({ minOrderNotional: 0n }));
    const small = order({ side: "sell", wallet: "alice", quantity: 5n * LOT, limitPrice: 1_000n });
    const big = order({ side: "sell", wallet: "carol", quantity: 20n * LOT, limitPrice: 1_000n });
    engine.place(small, NOW);
    engine.place(big, NOW);
    engine.upsertMarket(market({ minOrderNotional: MIN }));
    const taker = order({ side: "buy", wallet: "bob", quantity: 20n * LOT, limitPrice: 1_000n });
    const r = placed(engine.place(taker, NOW));
    expect(cancelledBelowMin(r.events)).toEqual([small.id]);
    expect(r.matches.map((m) => [m.sellOrderId, m.quantity])).toEqual([[big.id, 20n * LOT]]);
    expect(engine.getOrder(taker.id)?.status).toBe("filled");
  });

  it("lets every match through when the minimum is 0", () => {
    engine.upsertMarket(market({ minOrderNotional: 0n }));
    engine.place(order({ side: "sell", wallet: "alice", quantity: 3n * LOT, limitPrice: 1n }), NOW);
    const r = placed(engine.place(order({ side: "buy", wallet: "bob", quantity: LOT, limitPrice: 1n }), NOW));
    expect(r.matches.map((m) => m.paymentAmount)).toEqual([1n]);
    expect(cancelledBelowMin(r.events)).toEqual([]);
  });
});
