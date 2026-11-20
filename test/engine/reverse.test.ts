import { beforeEach, describe, expect, it } from "vitest";
import { EngineInvariantError, MatchingEngine, type PlaceResult } from "../../src/engine/engine.ts";
import type { Match } from "../../src/engine/types.ts";
import { ASSET, CHAIN, DAY, LOT, NOW, market, order, seededUuidV4 } from "./helpers.ts";

/**
 * MatchingEngine.reverse: a match failed after both orders were filled. Nothing
 * decreases: the match's quantity goes to `released` (innocent side, back to the
 * market) or `voided` (side at fault, stale).
 */

let engine: MatchingEngine;

function matchOf(r: PlaceResult): Match {
  if (!r.accepted || !r.matches[0]) throw new Error("expected a match");
  return r.matches[0];
}

beforeEach(() => {
  engine = new MatchingEngine({ newMatchId: seededUuidV4(3) });
  engine.upsertMarket(market());
});

describe("reverse", () => {
  it("seller at fault: the seller's quantity is voided (stale), the buyer's released back to the book at its original priority", () => {
    const bob = order({ side: "buy", wallet: "bob", quantity: 10n * LOT, limitPrice: 1_000n });
    const carol = order({ side: "buy", wallet: "carol", quantity: 10n * LOT, limitPrice: 1_000n });
    engine.place(bob, NOW);
    engine.place(carol, NOW);
    const alice = order({ side: "sell", wallet: "alice", quantity: 10n * LOT, limitPrice: 1_000n });
    const m = matchOf(engine.place(alice, NOW));
    expect(m.buyOrderId).toBe(bob.id);

    const r = engine.reverse(m, "seller", NOW + 10);
    expect(r.reversals).toEqual([
      { orderId: bob.id, kind: "released", quantity: 10n * LOT },
      { orderId: alice.id, kind: "voided", quantity: 10n * LOT },
    ]);
    expect(r.matches).toEqual([]);
    expect(engine.getOrder(bob.id)).toMatchObject({ status: "open", filledQuantity: 10n * LOT, releasedQuantity: 10n * LOT, remaining: 10n * LOT });
    expect(engine.getOrder(alice.id)).toMatchObject({ status: "stale", filledQuantity: 10n * LOT, voidedQuantity: 10n * LOT });
    // Bob (seq 1) is ahead of Carol (seq 2) again.
    const s = engine.exportState().books.find((b) => b.asset === ASSET)!;
    expect(s.bids).toEqual([bob.id, carol.id]);
  });

  it("the released order re-enters through matching: it trades with an order that now crosses it, so the book never crosses", () => {
    const bob = order({ side: "buy", wallet: "bob", quantity: 10n * LOT, limitPrice: 1_000n });
    engine.place(bob, NOW);
    const alice = order({ side: "sell", wallet: "alice", quantity: 10n * LOT, limitPrice: 1_000n });
    const m = matchOf(engine.place(alice, NOW));
    // While Bob was filled, Dave rested a cheaper sell.
    const dave = order({ side: "sell", wallet: "dave", quantity: 10n * LOT, limitPrice: 900n });
    engine.place(dave, NOW);
    const r = engine.reverse(m, "seller", NOW + 10);
    expect(r.matches.map((x) => [x.buyOrderId, x.sellOrderId, x.price, x.quantity])).toEqual([[bob.id, dave.id, 900n, 10n * LOT]]);
    expect(engine.getOrder(bob.id)).toMatchObject({ status: "filled", filledQuantity: 20n * LOT, releasedQuantity: 10n * LOT, remaining: 0n });
    const book = engine.book(CHAIN, ASSET);
    expect([book.bids, book.asks]).toEqual([[], []]);
  });

  it("both at fault: both voided and stale", () => {
    engine.place(order({ side: "buy", wallet: "bob" }), NOW);
    const m = matchOf(engine.place(order({ side: "sell", wallet: "alice" }), NOW));
    const r = engine.reverse(m, "both", NOW);
    expect(r.reversals.map((x) => x.kind)).toEqual(["voided", "voided"]);
    expect([engine.getOrder(m.buyOrderId)?.status, engine.getOrder(m.sellOrderId)?.status]).toEqual(["stale", "stale"]);
  });

  it("no attributable fault: both released, both stale (out of the book), so they cannot rematch each other", () => {
    engine.place(order({ side: "buy", wallet: "bob", limitPrice: 1_100n }), NOW);
    const m = matchOf(engine.place(order({ side: "sell", wallet: "alice", limitPrice: 1_000n }), NOW));
    const r = engine.reverse(m, "none", NOW);
    expect(r.reversals.map((x) => x.kind)).toEqual(["released", "released"]);
    expect(r.matches).toEqual([]);
    expect([engine.getOrder(m.buyOrderId)?.status, engine.getOrder(m.sellOrderId)?.status]).toEqual(["stale", "stale"]);
    expect(engine.getOrder(m.buyOrderId)?.remaining).toBe(10n * LOT);
    // The stale orders can still be cancelled by their wallets.
    expect(engine.cancel(m.buyOrderId, "bob").cancelled).toBe(true);
  });

  it("expired: the order expiring with the match expires, a longer-lived one returns to the book", () => {
    const bob = order({ side: "buy", wallet: "bob", expiresAt: NOW + 2 * DAY });
    engine.place(bob, NOW);
    const alice = order({ side: "sell", wallet: "alice", expiresAt: NOW + DAY });
    const m = matchOf(engine.place(alice, NOW));
    expect(m.expiresAt).toBe(NOW + DAY);
    engine.reverse(m, "expired", NOW + 100);
    expect(engine.getOrder(alice.id)?.status).toBe("expired");
    expect(engine.getOrder(bob.id)).toMatchObject({ status: "open", releasedQuantity: 10n * LOT });
  });

  it("an innocent order that is no longer live expires instead of re-entering", () => {
    const bob = order({ side: "buy", wallet: "bob", expiresAt: NOW + 120 });
    engine.place(bob, NOW);
    const m = matchOf(engine.place(order({ side: "sell", wallet: "alice" }), NOW));
    engine.reverse(m, "seller", NOW + 100); // 20 s left: inside the 60 s margin
    expect(engine.getOrder(bob.id)?.status).toBe("expired");
  });

  it("a cancelled innocent order gets its quantity released as accounting only, and stays cancelled", () => {
    const bob = order({ side: "buy", wallet: "bob", quantity: 20n * LOT });
    engine.place(bob, NOW);
    const m = matchOf(engine.place(order({ side: "sell", wallet: "alice", quantity: 10n * LOT }), NOW));
    expect(engine.cancel(bob.id, "bob").cancelled).toBe(true);
    const r = engine.reverse(m, "seller", NOW);
    expect(r.matches).toEqual([]);
    expect(engine.getOrder(bob.id)).toMatchObject({ status: "cancelled", filledQuantity: 10n * LOT, releasedQuantity: 10n * LOT, remaining: 20n * LOT });
    expect(engine.book(CHAIN, ASSET).bids).toEqual([]);
  });

  it("refuses to reverse more than an order has matched (e.g. the same match twice)", () => {
    engine.place(order({ side: "buy", wallet: "bob" }), NOW);
    const m = matchOf(engine.place(order({ side: "sell", wallet: "alice" }), NOW));
    engine.reverse(m, "seller", NOW);
    expect(() => engine.reverse(m, "seller", NOW)).toThrow(EngineInvariantError);
  });

  it("works after a restart: a filled order with quantity in flight is restored out of the book", () => {
    const e = new MatchingEngine({ newMatchId: seededUuidV4(4) });
    e.upsertMarket(market());
    const base = { chain: CHAIN, asset: ASSET, paymentAsset: "TEST-USDT", quantity: 10n * LOT, lotSize: LOT, limitPrice: 1_000n, expiresAt: NOW + DAY };
    e.restore({
      orders: [
        { ...base, id: "b", wallet: "bob", side: "buy", seq: 1, filledQuantity: 10n * LOT, status: "filled" },
        { ...base, id: "s", wallet: "alice", side: "sell", seq: 2, filledQuantity: 10n * LOT, status: "filled" },
      ],
      lastOrderSeq: 2,
      lastMatchSeq: 1,
    });
    expect(e.book(CHAIN, ASSET)).toMatchObject({ bids: [], asks: [] });
    e.reverse({ id: "m", buyOrderId: "b", sellOrderId: "s", quantity: 10n * LOT, expiresAt: NOW + DAY }, "seller", NOW);
    expect(e.book(CHAIN, ASSET).bids).toEqual([{ price: 1_000n, quantity: 10n * LOT, orders: 1 }]);
    expect(() =>
      e.restore({ orders: [], lastOrderSeq: 0, lastMatchSeq: 0 }),
    ).toThrow(EngineInvariantError);
  });
});
