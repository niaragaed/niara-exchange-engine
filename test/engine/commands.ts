/**
 * TEST ONLY: a random command model shared by the restart tests (engine only, and
 * engine + PGlite). Small price and size ranges, so orders cross, partially fill,
 * self-trade, fall below the minimum and expire often; some orders are icebergs, so
 * slices refresh and lose priority. Identifiers are labeled test
 * values, not real wallets, mints or tokens.
 */
import fc from "fast-check";
import { getAddress } from "viem";
import type { ChainId } from "../../src/chains.ts";
import type { EngineEvent, MatchingEngine, PlaceResult } from "../../src/engine/engine.ts";
import type { Market, OrderInput, Side } from "../../src/engine/types.ts";

export const MARGIN = 60;
export const LOT = 100n;
// EVM addresses in checksummed form, as admission returns them.
export const QUOTE = {
  "solana-devnet": "TEST-USDT",
  "base-sepolia": getAddress("0x000000000000000000000000000000000000d001"),
} as const;
/** Minimum notional per chain (the `chains` table holds it per chain). */
export const CHAIN_MIN = { "solana-devnet": 5n, "base-sepolia": 0n } as const;
export const MARKETS: readonly { chain: keyof typeof QUOTE; asset: string }[] = [
  { chain: "solana-devnet", asset: "TEST-EQ-1" },
  { chain: "solana-devnet", asset: "TEST-EQ-2" },
  { chain: "base-sepolia", asset: getAddress("0x000000000000000000000000000000000000e001") },
];
export const WALLETS = ["TEST-WALLET-A", "TEST-WALLET-B", "TEST-WALLET-C"] as const;

export function marketOf(i: number): Market {
  const m = MARKETS[i]!;
  return {
    chain: m.chain,
    asset: m.asset,
    assetClass: "equity",
    status: "approved",
    quoteAsset: QUOTE[m.chain],
    lotSize: LOT,
    minOrderNotional: CHAIN_MIN[m.chain],
  };
}

export type Command =
  /** `display`: lots shown at a time (an iceberg) when 1 <= display < lots; otherwise shown whole. */
  | { kind: "place"; market: number; wallet: number; side: Side; lots: number; price: number; ttl: number; display: number }
  | { kind: "cancel"; pick: number; byOwner: boolean }
  | { kind: "stale"; pick: number }
  | { kind: "tick"; secs: number }
  | { kind: "expire" };

export const commandArb: fc.Arbitrary<Command> = fc.oneof(
  {
    weight: 8,
    arbitrary: fc.record({
      kind: fc.constant("place" as const),
      market: fc.integer({ min: 0, max: MARKETS.length - 1 }),
      wallet: fc.integer({ min: 0, max: WALLETS.length - 1 }),
      side: fc.constantFrom<Side>("buy", "sell"),
      lots: fc.integer({ min: 1, max: 6 }),
      price: fc.integer({ min: 1, max: 6 }),
      ttl: fc.integer({ min: 30, max: 900 }),
      display: fc.integer({ min: 0, max: 3 }),
    }),
  },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("cancel" as const), pick: fc.nat(), byOwner: fc.boolean() }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("stale" as const), pick: fc.nat() }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("tick" as const), secs: fc.integer({ min: 1, max: 300 }) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("expire" as const) }) },
);

export interface Context {
  now: number;
  placed: OrderInput[];
  newOrderId: () => string;
}

/** What the database side does with each engine outcome (nothing for engine-only runs). */
export interface Sink {
  placed(result: Extract<PlaceResult, { accepted: true }>, input: OrderInput): Promise<void>;
  changed(events: readonly EngineEvent[]): Promise<void>;
}

/** Applies one command; returns the engine's output for comparison. */
export async function apply(engine: MatchingEngine, c: Command, ctx: Context, sink?: Sink): Promise<unknown> {
  switch (c.kind) {
    case "place": {
      const m = MARKETS[c.market]!;
      const input: OrderInput = {
        id: ctx.newOrderId(),
        chain: m.chain as ChainId,
        asset: m.asset,
        paymentAsset: QUOTE[m.chain],
        wallet: WALLETS[c.wallet]!,
        side: c.side,
        quantity: BigInt(c.lots) * LOT,
        limitPrice: BigInt(c.price),
        lotSize: LOT,
        expiresAt: ctx.now + c.ttl,
        ...(c.display >= 1 && c.display < c.lots && { displayQuantity: BigInt(c.display) * LOT }),
      };
      const r = engine.place(input, ctx.now);
      if (r.accepted) {
        ctx.placed.push(input);
        await sink?.placed(r, input);
      }
      return r;
    }
    case "cancel": {
      const target = ctx.placed[c.pick % Math.max(ctx.placed.length, 1)];
      if (!target) return null;
      const r = engine.cancel(target.id, c.byOwner ? target.wallet : `${target.wallet}-other`);
      if (r.cancelled) await sink?.changed(r.events);
      return r;
    }
    case "stale": {
      const target = ctx.placed[c.pick % Math.max(ctx.placed.length, 1)];
      if (!target) return null;
      const events = engine.markStale(target.id);
      await sink?.changed(events);
      return events;
    }
    case "tick":
      ctx.now += c.secs;
      return null;
    case "expire": {
      const events = engine.expire(ctx.now);
      await sink?.changed(events);
      return events;
    }
  }
}
