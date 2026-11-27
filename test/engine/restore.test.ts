import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { EngineInvariantError, MatchingEngine, type OrderView, type RestoredOrder } from "../../src/engine/engine.ts";
import { MARGIN, MARKETS, apply, commandArb, marketOf, type Command, type Context } from "./commands.ts";
import { NOW, seededUuidV4 } from "./helpers.ts";

function freshEngine(newMatchId: () => string): MatchingEngine {
  const e = new MatchingEngine({ newMatchId, settlementMarginSecs: MARGIN });
  MARKETS.forEach((_, i) => e.upsertMarket(marketOf(i)));
  return e;
}

function toRestored(o: OrderView): RestoredOrder {
  if (o.status !== "open" && o.status !== "partially_filled" && o.status !== "stale") throw new Error("terminal");
  return {
    id: o.id,
    chain: o.chain,
    asset: o.asset,
    paymentAsset: o.paymentAsset,
    wallet: o.wallet,
    side: o.side,
    quantity: o.quantity,
    limitPrice: o.limitPrice,
    lotSize: o.lotSize,
    expiresAt: o.expiresAt,
    seq: o.seq,
    filledQuantity: o.filledQuantity,
    status: o.status,
    // Icebergs: the signed display, the visible slice and its priority survive the restart.
    ...(o.displayQuantity !== undefined && { displayQuantity: o.displayQuantity, prioritySeq: o.prioritySeq }),
    ...(o.visibleQuantity !== undefined && { visibleQuantity: o.visibleQuantity }),
  };
}

/** Restarts `engine` the way the service does: only non-terminal orders and the last sequences survive. */
function restart(engine: MatchingEngine, newMatchId: () => string): MatchingEngine {
  const s = engine.exportState();
  const e = freshEngine(newMatchId);
  e.restore({ orders: s.orders.map(toRestored), lastOrderSeq: s.nextOrderSeq - 1, lastMatchSeq: s.nextMatchSeq - 1 });
  return e;
}

const order = (id: string, over: Partial<RestoredOrder> = {}): RestoredOrder => ({
  id,
  chain: MARKETS[0]!.chain,
  asset: MARKETS[0]!.asset,
  paymentAsset: "TEST-USDT",
  wallet: "TEST-WALLET-A",
  side: "sell",
  quantity: 500n,
  limitPrice: 3n,
  lotSize: 100n,
  expiresAt: NOW + 3600,
  seq: 1,
  filledQuantity: 0n,
  status: "open",
  ...over,
});

describe("restore", () => {
  it("rebuilds price-time priority from seq, keeps fills, and continues the sequences", () => {
    const e = freshEngine(seededUuidV4(1));
    e.restore({
      orders: [
        order("a", { seq: 3, limitPrice: 4n }),
        order("b", { seq: 5, limitPrice: 3n, filledQuantity: 200n, status: "partially_filled" }),
        order("c", { seq: 8, limitPrice: 3n }),
        order("d", { seq: 9, status: "stale" }),
      ],
      lastOrderSeq: 12,
      lastMatchSeq: 4,
    });
    const s = e.exportState();
    expect(s.books.find((b) => b.asset === MARKETS[0]!.asset)?.asks).toEqual(["b", "c", "a"]);
    expect(s.nextOrderSeq).toBe(13);
    expect(s.nextMatchSeq).toBe(5);
    // A buyer takes b's remaining 300 first (earlier seq at the best price), then c.
    // (Market 0's minimum notional is 5: every fill here is 3 lots at 3 = 9.)
    const r = e.place(
      {
        id: "x",
        chain: MARKETS[0]!.chain,
        asset: MARKETS[0]!.asset,
        paymentAsset: "TEST-USDT",
        wallet: "TEST-WALLET-B",
        side: "buy",
        quantity: 600n,
        limitPrice: 3n,
        lotSize: 100n,
        expiresAt: NOW + 3600,
      },
      NOW,
    );
    expect(r.accepted && r.matches.map((m) => [m.sellOrderId, m.quantity, m.sequence])).toEqual([
      ["b", 300n, 5],
      ["c", 300n, 6],
    ]);
    expect(r.accepted && r.order.seq).toBe(13);
    // The stale order is out of the book but its wallet can still cancel it.
    expect(e.cancel("d", "TEST-WALLET-A").cancelled).toBe(true);
  });

  it("refuses a non-fresh engine, out-of-order or duplicate seqs, unknown markets and inconsistent fills", () => {
    const used = freshEngine(seededUuidV4(1));
    used.restore({ orders: [order("a")], lastOrderSeq: 1, lastMatchSeq: 0 });
    expect(() => used.restore({ orders: [], lastOrderSeq: 1, lastMatchSeq: 0 })).toThrow(EngineInvariantError);

    const bad: [string, RestoredOrder[], number][] = [
      ["out of order", [order("a", { seq: 2 }), order("b", { seq: 1 })], 5],
      ["duplicate seq", [order("a", { seq: 2 }), order("b", { seq: 2 })], 5],
      ["seq above the last", [order("a", { seq: 6 })], 5],
      ["duplicate id", [order("a", { seq: 1 }), order("a", { seq: 2 })], 5],
      ["unknown market", [order("a", { asset: "TEST-UNLISTED" })], 5],
      ["lot size", [order("a", { lotSize: 10n })], 5],
      ["filled all", [order("a", { filledQuantity: 500n, status: "partially_filled" })], 5],
      ["open with a fill", [order("a", { filledQuantity: 100n })], 5],
      ["partial without a fill", [order("a", { status: "partially_filled" })], 5],
      ["fill not in lots", [order("a", { filledQuantity: 150n, status: "partially_filled" })], 5],
    ];
    for (const [why, orders, last] of bad) {
      expect(() => freshEngine(seededUuidV4(1)).restore({ orders, lastOrderSeq: last, lastMatchSeq: 0 }), why).toThrow(
        EngineInvariantError,
      );
    }
  });
});

describe("restart equivalence (fast-check, engine only)", () => {
  it("the rebuilt state equals the state before the restart, and both engines then behave identically", async () => {
    const prefixArb = fc.array(commandArb, { minLength: 0, maxLength: 120 });
    const tailArb = fc.array(commandArb, { minLength: 1, maxLength: 80 });
    await fc.assert(
      fc.asyncProperty(prefixArb, tailArb, fc.nat(), async (prefix: Command[], tail: Command[], seed: number) => {
        let matchIds = seededUuidV4(seed);
        const before = freshEngine(() => matchIds());
        const ctx: Context = { now: NOW, placed: [], newOrderId: seededUuidV4(seed + 1_000_000) };
        for (const c of prefix) await apply(before, c, ctx);

        // Same match ids for both engines from here on.
        matchIds = seededUuidV4(seed + 2_000_000);
        const after = restart(before, seededUuidV4(seed + 2_000_000));
        expect(after.exportState()).toEqual(before.exportState());

        const tailIds = seed + 3_000_000;
        const ctxBefore: Context = { now: ctx.now, placed: [...ctx.placed], newOrderId: seededUuidV4(tailIds) };
        const ctxAfter: Context = { now: ctx.now, placed: [...ctx.placed], newOrderId: seededUuidV4(tailIds) };
        const liveAtRestart = new Set(before.exportState().orders.map((o) => o.id));
        for (const c of tail) {
          const a = (await apply(before, c, ctxBefore)) as { reason?: string } | null;
          const b = (await apply(after, c, ctxAfter)) as { reason?: string } | null;
          // The one allowed difference: an order that was terminal at the restart is
          // unknown to the rebuilt engine, which refuses to cancel it either way. (The
          // service looks the order up in the database first and answers "not live".)
          const target = c.kind === "cancel" ? ctxBefore.placed[c.pick % Math.max(ctxBefore.placed.length, 1)] : undefined;
          if (target && !liveAtRestart.has(target.id) && b?.reason === "unknown_order") {
            expect(["not_live", "not_owner"]).toContain(a?.reason);
            continue;
          }
          expect(b).toEqual(a);
        }
        expect(after.exportState()).toEqual(before.exportState());
      }),
      { numRuns: 200 },
    );
  });
});
