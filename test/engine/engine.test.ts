import { beforeEach, describe, expect, it } from "vitest";
import { EngineInvariantError, MatchingEngine, type PlaceResult } from "../../src/engine/engine.ts";
import { isUuidV4, uuidToBytes } from "../../src/engine/ids.ts";
import { randomMatchId } from "../../src/engine/random-id.ts";
import type { AssetClass, ListingStatus, Match } from "../../src/engine/types.ts";
import { ASSET, ASSET_B, CHAIN, DAY, LOT, NOW, OTHER_CHAIN, USDT, market, order, seededUuidV4 } from "./helpers.ts";

let engine: MatchingEngine;

function matchesOf(r: PlaceResult): Match[] {
  if (!r.accepted) throw new Error(`rejected: ${r.reason}`);
  return r.matches;
}

function rejection(r: PlaceResult): string | undefined {
  return r.accepted ? undefined : r.reason;
}

beforeEach(() => {
  engine = new MatchingEngine({ newMatchId: seededUuidV4(1) });
  engine.upsertMarket(market());
});

describe("books per (chain, asset)", () => {
  it("never matches orders of different assets", () => {
    engine.upsertMarket(market({ asset: ASSET_B }));
    engine.place(order({ side: "sell", wallet: "alice", asset: ASSET_B, limitPrice: 900n }), NOW);
    expect(matchesOf(engine.place(order({ side: "buy", wallet: "bob", limitPrice: 1_000n }), NOW))).toEqual([]);
  });

  it("never matches the same asset id on different chains", () => {
    engine.upsertMarket(market({ chain: OTHER_CHAIN }));
    engine.place(order({ side: "sell", wallet: "alice", chain: OTHER_CHAIN, limitPrice: 900n }), NOW);
    expect(matchesOf(engine.place(order({ side: "buy", wallet: "bob", limitPrice: 1_000n }), NOW))).toEqual([]);
    expect(engine.book(OTHER_CHAIN, ASSET).asks).toHaveLength(1);
    expect(engine.book(CHAIN, ASSET).bids).toHaveLength(1);
  });

  it("refuses an order for an unknown market", () => {
    expect(rejection(engine.place(order({ side: "buy", wallet: "bob", asset: "TEST-UNLISTED" }), NOW))).toBe(
      "unknown_market",
    );
  });
});

describe("limit orders and price-time priority", () => {
  it("does not match when the limits do not cross; both rest", () => {
    engine.place(order({ side: "sell", wallet: "alice", limitPrice: 1_100n }), NOW);
    expect(matchesOf(engine.place(order({ side: "buy", wallet: "bob", limitPrice: 1_000n }), NOW))).toEqual([]);
    const book = engine.book(CHAIN, ASSET);
    expect(book.bids).toEqual([{ price: 1_000n, quantity: 10n * LOT, orders: 1 }]);
    expect(book.asks).toEqual([{ price: 1_100n, quantity: 10n * LOT, orders: 1 }]);
  });

  it("fills the best price first", () => {
    const worse = order({ side: "sell", wallet: "alice", limitPrice: 1_000n });
    const better = order({ side: "sell", wallet: "carol", limitPrice: 950n });
    engine.place(worse, NOW);
    engine.place(better, NOW);
    const [m] = matchesOf(engine.place(order({ side: "buy", wallet: "bob", limitPrice: 1_000n, quantity: LOT }), NOW));
    expect(m?.sellOrderId).toBe(better.id);
    expect(m?.price).toBe(950n);
  });

  it("fills the earlier order first at the same price", () => {
    const first = order({ side: "buy", wallet: "alice", limitPrice: 1_000n });
    const second = order({ side: "buy", wallet: "carol", limitPrice: 1_000n });
    engine.place(first, NOW);
    engine.place(second, NOW);
    const [m] = matchesOf(engine.place(order({ side: "sell", wallet: "bob", limitPrice: 1_000n, quantity: LOT }), NOW));
    expect(m?.buyOrderId).toBe(first.id);
  });

  it("trades at the maker's limit price, within both limits", () => {
    engine.place(order({ side: "sell", wallet: "alice", limitPrice: 900n }), NOW);
    const [m] = matchesOf(engine.place(order({ side: "buy", wallet: "bob", limitPrice: 1_200n }), NOW));
    expect(m?.price).toBe(900n);
    expect(m?.takerSide).toBe("buy");

    engine.place(order({ side: "buy", wallet: "carol", limitPrice: 1_100n }), NOW);
    const [m2] = matchesOf(engine.place(order({ side: "sell", wallet: "dave", limitPrice: 800n }), NOW));
    expect(m2?.price).toBe(1_100n);
    expect(m2?.takerSide).toBe("sell");
  });

  it("walks several price levels and stops at the taker's limit", () => {
    engine.place(order({ side: "sell", wallet: "alice", limitPrice: 900n, quantity: LOT }), NOW);
    engine.place(order({ side: "sell", wallet: "carol", limitPrice: 950n, quantity: LOT }), NOW);
    engine.place(order({ side: "sell", wallet: "dave", limitPrice: 1_050n, quantity: LOT }), NOW);
    const ms = matchesOf(engine.place(order({ side: "buy", wallet: "bob", limitPrice: 1_000n, quantity: 3n * LOT }), NOW));
    expect(ms.map((m) => m.price)).toEqual([900n, 950n]);
    expect(engine.book(CHAIN, ASSET).bids).toEqual([{ price: 1_000n, quantity: LOT, orders: 1 }]);
    expect(engine.book(CHAIN, ASSET).asks).toEqual([{ price: 1_050n, quantity: LOT, orders: 1 }]);
  });
});

describe("partial fills", () => {
  it("partially fills a resting order and keeps the rest at its priority", () => {
    const maker = order({ side: "sell", wallet: "alice", quantity: 10n * LOT });
    engine.place(maker, NOW);
    const later = order({ side: "sell", wallet: "carol", quantity: 10n * LOT });
    engine.place(later, NOW);
    const [m] = matchesOf(engine.place(order({ side: "buy", wallet: "bob", quantity: 4n * LOT }), NOW));
    expect(m?.quantity).toBe(4n * LOT);
    expect(engine.getOrder(maker.id)).toMatchObject({ status: "partially_filled", filledQuantity: 4n * LOT, remaining: 6n * LOT });
    const [m2] = matchesOf(engine.place(order({ side: "buy", wallet: "dave", quantity: LOT }), NOW));
    expect(m2?.sellOrderId).toBe(maker.id);
  });

  it("partially fills an incoming order and rests the remainder", () => {
    engine.place(order({ side: "sell", wallet: "alice", quantity: 3n * LOT }), NOW);
    const taker = order({ side: "buy", wallet: "bob", quantity: 5n * LOT });
    const r = engine.place(taker, NOW);
    expect(matchesOf(r).map((m) => m.quantity)).toEqual([3n * LOT]);
    expect(engine.getOrder(taker.id)).toMatchObject({ status: "partially_filled", remaining: 2n * LOT });
    expect(engine.book(CHAIN, ASSET).bids).toEqual([{ price: 1_000n, quantity: 2n * LOT, orders: 1 }]);
  });

  it("marks both orders filled when the quantities are equal", () => {
    const maker = order({ side: "sell", wallet: "alice" });
    const taker = order({ side: "buy", wallet: "bob" });
    engine.place(maker, NOW);
    const r = engine.place(taker, NOW);
    expect(r.events.filter((e) => e.type === "order_filled").map((e) => e.type === "order_filled" && e.orderId)).toEqual([
      maker.id,
      taker.id,
    ]);
    expect(engine.getOrder(maker.id)?.status).toBe("filled");
    expect(engine.getOrder(taker.id)?.status).toBe("filled");
    expect(engine.book(CHAIN, ASSET)).toMatchObject({ bids: [], asks: [] });
  });

  it("never fills more than either order's quantity", () => {
    engine.place(order({ side: "sell", wallet: "alice", quantity: 2n * LOT }), NOW);
    engine.place(order({ side: "sell", wallet: "carol", quantity: 2n * LOT }), NOW);
    const taker = order({ side: "buy", wallet: "bob", quantity: 3n * LOT });
    const ms = matchesOf(engine.place(taker, NOW));
    expect(ms.map((m) => m.quantity)).toEqual([2n * LOT, LOT]);
    expect(engine.getOrder(taker.id)).toMatchObject({ status: "filled", filledQuantity: 3n * LOT });
  });
});

describe("cancellations", () => {
  it("cancels a resting order, which then never matches", () => {
    const resting = order({ side: "sell", wallet: "alice" });
    engine.place(resting, NOW);
    const r = engine.cancel(resting.id, "alice");
    expect(r).toMatchObject({ cancelled: true, order: { status: "cancelled", remaining: 10n * LOT } });
    expect(matchesOf(engine.place(order({ side: "buy", wallet: "bob" }), NOW))).toEqual([]);
  });

  it("cancels the remainder of a partially filled order", () => {
    const resting = order({ side: "sell", wallet: "alice", quantity: 5n * LOT });
    engine.place(resting, NOW);
    engine.place(order({ side: "buy", wallet: "bob", quantity: 2n * LOT }), NOW);
    expect(engine.cancel(resting.id, "alice")).toMatchObject({
      cancelled: true,
      order: { filledQuantity: 2n * LOT, remaining: 3n * LOT },
    });
    expect(engine.book(CHAIN, ASSET).asks).toEqual([]);
  });

  it("refuses to cancel another wallet's order", () => {
    const resting = order({ side: "sell", wallet: "alice" });
    engine.place(resting, NOW);
    expect(engine.cancel(resting.id, "bob")).toEqual({ cancelled: false, reason: "not_owner" });
    expect(engine.getOrder(resting.id)?.status).toBe("open");
  });

  it("refuses to cancel an unknown, filled or already cancelled order", () => {
    expect(engine.cancel("order-missing", "alice")).toEqual({ cancelled: false, reason: "unknown_order" });
    const filled = order({ side: "sell", wallet: "alice", quantity: LOT });
    engine.place(filled, NOW);
    engine.place(order({ side: "buy", wallet: "bob", quantity: LOT }), NOW);
    expect(engine.cancel(filled.id, "alice")).toEqual({ cancelled: false, reason: "not_live" });
    const resting = order({ side: "sell", wallet: "alice" });
    engine.place(resting, NOW);
    engine.cancel(resting.id, "alice");
    expect(engine.cancel(resting.id, "alice")).toEqual({ cancelled: false, reason: "not_live" });
  });

  it("takes a stale order out of the book and still lets its wallet cancel it", () => {
    const resting = order({ side: "sell", wallet: "alice" });
    engine.place(resting, NOW);
    expect(engine.markStale(resting.id)).toEqual([{ type: "order_stale", orderId: resting.id, remaining: 10n * LOT }]);
    expect(matchesOf(engine.place(order({ side: "buy", wallet: "bob" }), NOW))).toEqual([]);
    expect(engine.cancel(resting.id, "alice")).toMatchObject({ cancelled: true });
    expect(engine.markStale(resting.id)).toEqual([]);
  });
});

describe("self-trade prevention", () => {
  it("never matches a wallet with itself: the incoming order is cancelled, the resting one stays", () => {
    const resting = order({ side: "sell", wallet: "alice", limitPrice: 1_000n });
    engine.place(resting, NOW);
    const taker = order({ side: "buy", wallet: "alice", limitPrice: 1_000n });
    const r = engine.place(taker, NOW);
    expect(matchesOf(r)).toEqual([]);
    expect(r.events).toContainEqual({
      type: "order_cancelled",
      orderId: taker.id,
      reason: "self_trade_prevention",
      remaining: 10n * LOT,
    });
    expect(engine.getOrder(resting.id)?.status).toBe("open");
    expect(engine.getOrder(taker.id)?.status).toBe("cancelled");
    expect(engine.book(CHAIN, ASSET).bids).toEqual([]);
  });

  it("fills better-priced orders of other wallets first, then stops at its own", () => {
    engine.place(order({ side: "sell", wallet: "carol", limitPrice: 900n, quantity: LOT }), NOW);
    engine.place(order({ side: "sell", wallet: "alice", limitPrice: 950n, quantity: LOT }), NOW);
    engine.place(order({ side: "sell", wallet: "dave", limitPrice: 980n, quantity: LOT }), NOW);
    const taker = order({ side: "buy", wallet: "alice", limitPrice: 1_000n, quantity: 3n * LOT });
    const ms = matchesOf(engine.place(taker, NOW));
    expect(ms.map((m) => [m.seller, m.price])).toEqual([["carol", 900n]]);
    expect(engine.getOrder(taker.id)).toMatchObject({ status: "cancelled", filledQuantity: LOT, remaining: 2n * LOT });
    expect(engine.book(CHAIN, ASSET).asks.map((l) => l.price)).toEqual([950n, 980n]);
  });

  it("does not interfere when the own order does not cross", () => {
    engine.place(order({ side: "sell", wallet: "alice", limitPrice: 1_100n }), NOW);
    const r = engine.place(order({ side: "buy", wallet: "alice", limitPrice: 1_000n }), NOW);
    expect(r.accepted && r.order.status).toBe("open");
  });
});

describe("matches", () => {
  it("get a fresh UUID v4 match id each", () => {
    engine.place(order({ side: "sell", wallet: "alice", quantity: LOT }), NOW);
    engine.place(order({ side: "sell", wallet: "carol", quantity: LOT }), NOW);
    const ms = matchesOf(engine.place(order({ side: "buy", wallet: "bob", quantity: 2n * LOT }), NOW));
    expect(ms).toHaveLength(2);
    expect(ms.every((m) => isUuidV4(m.id))).toBe(true);
    expect(new Set(ms.map((m) => m.id)).size).toBe(2);
    expect(ms.map((m) => m.sequence)).toEqual([1, 2]);
  });

  it("refuse an id generator that does not return a UUID v4 (including all zeros) or repeats", () => {
    const bad = (id: string) => {
      const e = new MatchingEngine({ newMatchId: () => id });
      e.upsertMarket(market());
      e.place(order({ side: "sell", wallet: "alice" }), NOW);
      return () => e.place(order({ side: "buy", wallet: "bob", quantity: LOT }), NOW);
    };
    expect(bad("00000000-0000-0000-0000-000000000000")).toThrow(EngineInvariantError);
    expect(bad("6f1c1d4e-2a3b-1c5d-8e6f-7a8b9c0d1e2f")).toThrow(/UUID v4/);
    const repeat = bad("6f1c1d4e-2a3b-4c5d-8e6f-7a8b9c0d1e2f");
    repeat();
    expect(repeat).toThrow(/duplicate match id/);
  });

  it("are quoted in USDT with an exact payment amount", () => {
    engine.place(order({ side: "sell", wallet: "alice", limitPrice: 1_234_567n }), NOW);
    const [m] = matchesOf(engine.place(order({ side: "buy", wallet: "bob", limitPrice: 1_234_567n, quantity: 7n * LOT }), NOW));
    expect(m).toMatchObject({ paymentAsset: USDT, quantity: 7n * LOT, lotSize: LOT, paymentAmount: 7n * 1_234_567n });
  });

  it("carry the buyer, the seller and the earlier expiry of the two orders", () => {
    const sell = order({ side: "sell", wallet: "alice", expiresAt: NOW + 2 * DAY });
    const buy = order({ side: "buy", wallet: "bob", expiresAt: NOW + DAY });
    engine.place(sell, NOW);
    const [m] = matchesOf(engine.place(buy, NOW));
    expect(m).toMatchObject({
      buyOrderId: buy.id,
      sellOrderId: sell.id,
      buyer: "bob",
      seller: "alice",
      makerOrderId: sell.id,
      expiresAt: NOW + DAY,
    });
  });

  it("convert their id to the 16 bytes that settle takes", () => {
    expect(Array.from(uuidToBytes("6f1c1d4e-2a3b-4c5d-8e6f-7a8b9c0d1e2f"))).toEqual([
      0x6f, 0x1c, 0x1d, 0x4e, 0x2a, 0x3b, 0x4c, 0x5d, 0x8e, 0x6f, 0x7a, 0x8b, 0x9c, 0x0d, 0x1e, 0x2f,
    ]);
    expect(() => uuidToBytes("not-a-uuid")).toThrow(TypeError);
  });

  it("use random UUID v4 ids in production", () => {
    const a = randomMatchId();
    expect(isUuidV4(a)).toBe(true);
    expect(randomMatchId()).not.toBe(a);
  });
});

describe("only Equity order-book listings are matched", () => {
  for (const assetClass of ["fixed_income", "credit", "currency"] as AssetClass[]) {
    it(`refuses ${assetClass} (P2P escrow class)`, () => {
      engine.upsertMarket(market({ asset: `TEST-${assetClass}`, assetClass }));
      const r = engine.place(order({ side: "buy", wallet: "bob", asset: `TEST-${assetClass}` }), NOW);
      expect(rejection(r)).toBe("not_order_book_asset");
      expect(r.events).toEqual([{ type: "order_rejected", orderId: expect.any(String), reason: "not_order_book_asset" }]);
    });
  }

  for (const status of ["pending", "quoted", "suspended", "delisted"] as ListingStatus[]) {
    it(`refuses orders while the listing is ${status}`, () => {
      engine.upsertMarket(market({ status }));
      expect(rejection(engine.place(order({ side: "buy", wallet: "bob" }), NOW))).toBe("market_not_approved");
    });
  }

  it("keeps resting orders through a suspension and matches again after reinstatement", () => {
    engine.place(order({ side: "sell", wallet: "alice" }), NOW);
    engine.upsertMarket(market({ status: "suspended" }));
    expect(rejection(engine.place(order({ side: "buy", wallet: "bob" }), NOW))).toBe("market_not_approved");
    engine.upsertMarket(market({ status: "approved" }));
    expect(matchesOf(engine.place(order({ side: "buy", wallet: "bob" }), NOW))).toHaveLength(1);
  });
});

describe("order validation", () => {
  it("requires the market's quote asset (USDT)", () => {
    expect(rejection(engine.place(order({ side: "buy", wallet: "bob", paymentAsset: "TEST-BRL" }), NOW))).toBe(
      "wrong_payment_asset",
    );
  });

  it("requires the market's lot size", () => {
    expect(rejection(engine.place(order({ side: "buy", wallet: "bob", lotSize: 10n, quantity: 100n }), NOW))).toBe(
      "lot_size_mismatch",
    );
  });

  it("requires positive whole lots and a positive price", () => {
    expect(rejection(engine.place(order({ side: "buy", wallet: "bob", quantity: 0n }), NOW))).toBe("invalid_quantity");
    expect(rejection(engine.place(order({ side: "buy", wallet: "bob", quantity: -LOT }), NOW))).toBe("invalid_quantity");
    expect(rejection(engine.place(order({ side: "buy", wallet: "bob", quantity: LOT + 1n }), NOW))).toBe("not_whole_lots");
    expect(rejection(engine.place(order({ side: "buy", wallet: "bob", limitPrice: 0n }), NOW))).toBe("invalid_price");
  });

  it("enforces the market's minimum order notional (spec §9.12 item 1)", () => {
    engine.upsertMarket(market({ minOrderNotional: 10_000n }));
    expect(
      rejection(engine.place(order({ side: "buy", wallet: "bob", quantity: 9n * LOT, limitPrice: 1_000n }), NOW)),
    ).toBe("below_min_notional");
    expect(engine.place(order({ side: "buy", wallet: "bob", quantity: 10n * LOT, limitPrice: 1_000n }), NOW).accepted).toBe(
      true,
    );
  });

  it("refuses a reused order id", () => {
    const o = order({ side: "buy", wallet: "bob" });
    engine.place(o, NOW);
    expect(rejection(engine.place({ ...o }, NOW))).toBe("duplicate_order_id");
  });

  it("refuses to change the lot size of a market with resting orders", () => {
    engine.place(order({ side: "buy", wallet: "bob" }), NOW);
    expect(() => engine.upsertMarket(market({ lotSize: 10n }))).toThrow(/lot size/);
    expect(() => engine.upsertMarket(market({ lotSize: 0n }))).toThrow(RangeError);
  });

  it("rejects a non-integer clock", () => {
    expect(() => engine.place(order({ side: "buy", wallet: "bob" }), NOW + 0.5)).toThrow(RangeError);
  });
});

describe("expiry", () => {
  it("refuses an order that expires within the settlement margin (60 s by default)", () => {
    expect(rejection(engine.place(order({ side: "buy", wallet: "bob", expiresAt: NOW }), NOW))).toBe("expired");
    expect(rejection(engine.place(order({ side: "buy", wallet: "bob", expiresAt: NOW + 60 }), NOW))).toBe("expired");
    expect(engine.place(order({ side: "buy", wallet: "bob", expiresAt: NOW + 61 }), NOW).accepted).toBe(true);
  });

  it("skips and expires a resting order that is no longer matchable", () => {
    const old = order({ side: "sell", wallet: "alice", limitPrice: 900n, expiresAt: NOW + 120 });
    const fresh = order({ side: "sell", wallet: "carol", limitPrice: 1_000n });
    engine.place(old, NOW);
    engine.place(fresh, NOW);
    const r = engine.place(order({ side: "buy", wallet: "bob", quantity: LOT }), NOW + 60);
    expect(matchesOf(r).map((m) => m.sellOrderId)).toEqual([fresh.id]);
    expect(r.events[1]).toEqual({ type: "order_expired", orderId: old.id, remaining: 10n * LOT });
    expect(engine.getOrder(old.id)?.status).toBe("expired");
  });

  it("sweeps expired orders from every book", () => {
    const a = order({ side: "sell", wallet: "alice", expiresAt: NOW + 100 });
    const b = order({ side: "buy", wallet: "bob", limitPrice: 500n, expiresAt: NOW + DAY });
    engine.place(a, NOW);
    engine.place(b, NOW);
    expect(engine.expire(NOW + 40)).toEqual([{ type: "order_expired", orderId: a.id, remaining: 10n * LOT }]);
    expect(engine.book(CHAIN, ASSET)).toMatchObject({ asks: [], bids: [{ price: 500n }] });
    expect(engine.cancel(a.id, "alice")).toEqual({ cancelled: false, reason: "not_live" });
  });

  it("honours a custom margin", () => {
    const e = new MatchingEngine({ newMatchId: seededUuidV4(2), settlementMarginSecs: 0 });
    e.upsertMarket(market());
    expect(e.place(order({ side: "buy", wallet: "bob", expiresAt: NOW + 1 }), NOW).accepted).toBe(true);
    expect(() => new MatchingEngine({ newMatchId: seededUuidV4(2), settlementMarginSecs: -1 })).toThrow(RangeError);
  });
});
