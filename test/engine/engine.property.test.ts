import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { MatchingEngine, type CancelResult, type EngineEvent, type OrderView } from "../../src/engine/engine.ts";
import { isUuidV4 } from "../../src/engine/ids.ts";
import type { Match, OrderInput, Side } from "../../src/engine/types.ts";
import { CHAIN, LOT, NOW, OTHER_CHAIN, USDT, market, seededUuidV4 } from "./helpers.ts";

/**
 * Random command sequences over a few books and wallets, with small price and size
 * ranges so that orders cross, partially fill, self-trade and expire often.
 */

const MARGIN = 60;
const WALLETS = ["wallet-a", "wallet-b", "wallet-c"] as const;
const MARKETS = [
  { chain: CHAIN, asset: "TEST-EQ-1" },
  { chain: OTHER_CHAIN, asset: "TEST-EQ-1" },
  { chain: CHAIN, asset: "TEST-EQ-2" },
] as const;
// A P2P-class market: every order on it must be refused.
const BOND = { chain: CHAIN, asset: "TEST-BOND" } as const;

type Command =
  | { kind: "place"; market: number; wallet: number; side: Side; lots: number; price: number; ttl: number }
  | { kind: "cancel"; pick: number; byOwner: boolean }
  | { kind: "stale"; pick: number }
  | { kind: "tick"; secs: number }
  | { kind: "expire" };

const commandArb: fc.Arbitrary<Command> = fc.oneof(
  {
    weight: 8,
    arbitrary: fc.record({
      kind: fc.constant("place" as const),
      market: fc.integer({ min: 0, max: MARKETS.length }), // == MARKETS.length → the bond market
      wallet: fc.integer({ min: 0, max: WALLETS.length - 1 }),
      side: fc.constantFrom<Side>("buy", "sell"),
      lots: fc.integer({ min: 1, max: 6 }),
      price: fc.integer({ min: 1, max: 6 }),
      ttl: fc.integer({ min: 30, max: 900 }),
    }),
  },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("cancel" as const), pick: fc.nat(), byOwner: fc.boolean() }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("stale" as const), pick: fc.nat() }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("tick" as const), secs: fc.integer({ min: 1, max: 300 }) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("expire" as const) }) },
);

interface Run {
  /** Every engine output, in order: events, and cancel results (accepted or not). */
  events: (EngineEvent | CancelResult)[];
  matches: { match: Match; at: number }[];
  placed: OrderInput[];
  engine: MatchingEngine;
  crossedAfter: number[];
}

function run(commands: readonly Command[], seed: number): Run {
  const engine = new MatchingEngine({ newMatchId: seededUuidV4(seed), settlementMarginSecs: MARGIN });
  for (const m of MARKETS) engine.upsertMarket(market({ chain: m.chain, asset: m.asset }));
  engine.upsertMarket(market({ chain: BOND.chain, asset: BOND.asset, assetClass: "fixed_income" }));

  const out: Run = { events: [], matches: [], placed: [], engine, crossedAfter: [] };
  let now = NOW;
  let n = 0;
  commands.forEach((c, step) => {
    switch (c.kind) {
      case "place": {
        const m = MARKETS[c.market] ?? BOND;
        const input: OrderInput = {
          id: `order-${++n}`,
          chain: m.chain,
          asset: m.asset,
          paymentAsset: USDT,
          wallet: WALLETS[c.wallet]!,
          side: c.side,
          quantity: BigInt(c.lots) * LOT,
          limitPrice: BigInt(c.price),
          lotSize: LOT,
          expiresAt: now + c.ttl,
        };
        const r = engine.place(input, now);
        out.events.push(...r.events);
        if (r.accepted) {
          out.placed.push(input);
          for (const match of r.matches) out.matches.push({ match, at: now });
        }
        break;
      }
      case "cancel": {
        const target = out.placed[c.pick % Math.max(out.placed.length, 1)];
        if (!target) break;
        out.events.push(engine.cancel(target.id, c.byOwner ? target.wallet : `${target.wallet}-other`));
        break;
      }
      case "stale": {
        const target = out.placed[c.pick % Math.max(out.placed.length, 1)];
        if (target) out.events.push(...engine.markStale(target.id));
        break;
      }
      case "tick":
        now += c.secs;
        break;
      case "expire":
        out.events.push(...engine.expire(now));
        break;
    }
    for (const m of [...MARKETS, BOND]) {
      const b = engine.book(m.chain, m.asset);
      const bid = b.bids[0];
      const ask = b.asks[0];
      if (bid && ask && bid.price >= ask.price) out.crossedAfter.push(step);
    }
  });
  return out;
}

const commandsArb = fc.array(commandArb, { minLength: 1, maxLength: 200, size: "max" });
const PARAMS = { numRuns: 300 };

function orderOf(r: Run, id: string): OrderView {
  const o = r.engine.getOrder(id);
  if (!o) throw new Error(`missing order ${id}`);
  return o;
}

describe("matching engine invariants (fast-check)", () => {
  it("no overfill: each order's fills sum to its filled quantity, never above its quantity", () => {
    fc.assert(
      fc.property(commandsArb, fc.nat(), (commands, seed) => {
        const r = run(commands, seed);
        const filled = new Map<string, bigint>();
        for (const { match } of r.matches) {
          filled.set(match.buyOrderId, (filled.get(match.buyOrderId) ?? 0n) + match.quantity);
          filled.set(match.sellOrderId, (filled.get(match.sellOrderId) ?? 0n) + match.quantity);
        }
        for (const input of r.placed) {
          const o = orderOf(r, input.id);
          expect(filled.get(input.id) ?? 0n).toBe(o.filledQuantity);
          expect(o.filledQuantity).toBeLessThanOrEqual(input.quantity);
          expect(o.filledQuantity % LOT).toBe(0n);
        }
      }),
      PARAMS,
    );
  });

  it("price within both limits, exact payment, USDT quote", () => {
    fc.assert(
      fc.property(commandsArb, fc.nat(), (commands, seed) => {
        const r = run(commands, seed);
        const byId = new Map(r.placed.map((o) => [o.id, o]));
        for (const { match } of r.matches) {
          const buy = byId.get(match.buyOrderId)!;
          const sell = byId.get(match.sellOrderId)!;
          expect(buy.side).toBe("buy");
          expect(sell.side).toBe("sell");
          expect(match.price).toBeLessThanOrEqual(buy.limitPrice);
          expect(match.price).toBeGreaterThanOrEqual(sell.limitPrice);
          expect(match.price).toBe(byId.get(match.makerOrderId)!.limitPrice);
          expect(match.quantity > 0n && match.quantity % match.lotSize === 0n).toBe(true);
          expect(match.paymentAmount).toBe((match.quantity / match.lotSize) * match.price);
          expect(match.paymentAsset).toBe(USDT);
          expect([buy.chain, buy.asset, sell.chain, sell.asset]).toEqual([match.chain, match.asset, match.chain, match.asset]);
        }
      }),
      PARAMS,
    );
  });

  it("quantity conservation: quantity = filled + remaining for every order, and the book holds exactly the live remainders", () => {
    fc.assert(
      fc.property(commandsArb, fc.nat(), (commands, seed) => {
        const r = run(commands, seed);
        const resting = new Map<string, bigint>();
        for (const input of r.placed) {
          const o = orderOf(r, input.id);
          expect(o.filledQuantity + o.remaining).toBe(input.quantity);
          expect(o.status === "filled").toBe(o.remaining === 0n);
          if (o.status === "open" || o.status === "partially_filled") {
            const key = `${o.chain}/${o.asset}/${o.side}`;
            resting.set(key, (resting.get(key) ?? 0n) + o.remaining);
          }
        }
        for (const m of MARKETS) {
          const b = r.engine.book(m.chain, m.asset);
          for (const [side, levels] of [["buy", b.bids], ["sell", b.asks]] as const) {
            const total = levels.reduce((s, l) => s + l.quantity, 0n);
            expect(total).toBe(resting.get(`${m.chain}/${m.asset}/${side}`) ?? 0n);
          }
        }
        const bought = r.matches.reduce((s, { match }) => s + match.quantity, 0n);
        const buyFilled = r.placed.filter((o) => o.side === "buy").reduce((s, o) => s + orderOf(r, o.id).filledQuantity, 0n);
        const sellFilled = r.placed.filter((o) => o.side === "sell").reduce((s, o) => s + orderOf(r, o.id).filledQuantity, 0n);
        expect(buyFilled).toBe(bought);
        expect(sellFilled).toBe(bought);
      }),
      PARAMS,
    );
  });

  it("no self-match, and the book never crosses", () => {
    fc.assert(
      fc.property(commandsArb, fc.nat(), (commands, seed) => {
        const r = run(commands, seed);
        for (const { match } of r.matches) expect(match.buyer).not.toBe(match.seller);
        expect(r.crossedAfter).toEqual([]);
      }),
      PARAMS,
    );
  });

  it("only approved equity markets match; every match id is a unique UUID v4; matches leave time to settle", () => {
    fc.assert(
      fc.property(commandsArb, fc.nat(), (commands, seed) => {
        const r = run(commands, seed);
        expect(r.placed.some((o) => o.asset === BOND.asset)).toBe(false);
        const ids = r.matches.map(({ match }) => match.id);
        expect(ids.every(isUuidV4)).toBe(true);
        expect(new Set(ids).size).toBe(ids.length);
        expect(r.matches.map(({ match }) => match.sequence)).toEqual(r.matches.map((_, i) => i + 1));
        for (const { match, at } of r.matches) expect(match.expiresAt - at).toBeGreaterThan(MARGIN);
      }),
      PARAMS,
    );
  });

  it("determinism: the same input sequence always gives the same matches and events", () => {
    fc.assert(
      fc.property(commandsArb, fc.nat(), (commands, seed) => {
        const a = run(commands, seed);
        const b = run(commands, seed);
        expect(b.events).toEqual(a.events);
        expect(b.matches).toEqual(a.matches);
        for (const m of [...MARKETS, BOND]) expect(b.engine.book(m.chain, m.asset)).toEqual(a.engine.book(m.chain, m.asset));
      }),
      PARAMS,
    );
  });

  it("determinism holds apart from the ids: other id seeds change only the match ids", () => {
    fc.assert(
      fc.property(commandsArb, fc.nat(), (commands, seed) => {
        const strip = (r: Run) => r.matches.map(({ match }) => ({ ...match, id: "" }));
        expect(strip(run(commands, seed + 1))).toEqual(strip(run(commands, seed)));
      }),
      { numRuns: 100 },
    );
  });
});
