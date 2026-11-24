import { describe, expect, it } from "vitest";
import {
  DEMO_CAPS,
  DemoError,
  OPERATOR_LAMPORTS_PER_SETTLE,
  PRICE_CENTER_CENTS,
  centsToPrice,
  checkOperatorBalance,
  crossingLevels,
  matchesOnlyMaker,
  nextDelaySecs,
  nextLots,
  nextPriceCents,
  parseDemoOptions,
  plannedTrades,
  priceBoundsCents,
  runDemo,
  type BookView,
  type DemoDeps,
  type DemoWallet,
  type LiveOrder,
  type PlacedOrder,
  type Side,
} from "../../src/devnet/demo-activity.ts";

/** Demo activity on devnet: the price walk, the caps, the planning checks and the loop (driven by a fake engine). */

const seeded = (seed: number) => () => {
  // mulberry32
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

describe("price walk", () => {
  it("stays within +/-3% of 25 mockUSDT over many steps, from any seed", () => {
    const { lo, hi } = priceBoundsCents();
    expect([lo, hi]).toEqual([2425, 2575]);
    for (const seed of [1, 2, 3, 42, 1234]) {
      const rng = seeded(seed);
      let p = PRICE_CENTER_CENTS;
      const seen = new Set<number>();
      for (let i = 0; i < 20_000; i++) {
        p = nextPriceCents(rng, p);
        expect(Number.isInteger(p)).toBe(true);
        expect(p).toBeGreaterThanOrEqual(lo);
        expect(p).toBeLessThanOrEqual(hi);
        seen.add(p);
      }
      expect(seen.size).toBeGreaterThan(50); // it actually walks
    }
  });

  it("is bounded at the extremes of the random source and from a start outside the band", () => {
    for (const r of [0, 0.999999999]) {
      let p = 2575;
      for (let i = 0; i < 50; i++) p = nextPriceCents(() => r, p);
      expect(p).toBeGreaterThanOrEqual(2425);
      expect(p).toBeLessThanOrEqual(2575);
    }
    expect(nextPriceCents(() => 0.5, 9999)).toBeLessThanOrEqual(2575);
    expect(nextPriceCents(() => 0.5, 1)).toBeGreaterThanOrEqual(2425);
  });

  it("formats cents", () => {
    expect(centsToPrice(2500)).toBe("25.00");
    expect(centsToPrice(2507)).toBe("25.07");
    expect(centsToPrice(2430)).toBe("24.30");
  });

  it("sizes are 1-5 lots and delays 20-60 s, whatever the random source gives", () => {
    for (const r of [0, 0.2, 0.5, 0.9999999]) {
      expect(nextLots(() => r)).toBeGreaterThanOrEqual(1);
      expect(nextLots(() => r)).toBeLessThanOrEqual(5);
      expect(nextDelaySecs(() => r)).toBeGreaterThanOrEqual(20);
      expect(nextDelaySecs(() => r)).toBeLessThanOrEqual(60);
    }
    const rng = seeded(9);
    const lots = new Set(Array.from({ length: 500 }, () => nextLots(rng)));
    expect([...lots].sort()).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("caps", () => {
  it("defaults: 30 minutes, 20 trades, 4 traders", () => {
    const o = parseDemoOptions({});
    expect(o).toMatchObject({ durationMin: 30, maxTrades: 20, traders: 4 });
    expect(o.funding).toEqual({ lamports: 10_000_000n, usdtWhole: 500n, eqtyWhole: 20n });
  });

  it("refuses anything above the caps or malformed", () => {
    const bad: Record<string, string>[] = [
      { traders: "5" },
      { traders: "-1" },
      { duration: "0" },
      { duration: "241" },
      { "max-trades": "0" },
      { "max-trades": "201" },
      { sol: "0" },
      { sol: "0.06" },
      { sol: "abc" },
      { usdt: "2001" },
      { usdt: "0" },
      { usdt: "1.5" },
      { eqty: "51" },
      { duration: "3e2" },
    ];
    for (const b of bad) expect(() => parseDemoOptions(b), JSON.stringify(b)).toThrow(DemoError);
    expect(() => parseDemoOptions({ traders: "0" })).not.toThrow(); // only the two existing wallets
    expect(parseDemoOptions({ duration: "240", "max-trades": "200", traders: "4", sol: "0.05", usdt: "2000", eqty: "50" }).funding.lamports).toBe(50_000_000n);
    expect(DEMO_CAPS.maxTraders).toBe(4);
  });

  it("plans at most min(max trades, duration / 40 s) trades, and checks the operator's SOL against it", () => {
    expect(plannedTrades({ durationMin: 30, maxTrades: 20 })).toBe(20);
    expect(plannedTrades({ durationMin: 30, maxTrades: 200 })).toBe(45);
    expect(plannedTrades({ durationMin: 1, maxTrades: 200 })).toBe(1);
    const need = OPERATOR_LAMPORTS_PER_SETTLE * 20n;
    expect(checkOperatorBalance(need, 20)).toBe(need);
    expect(() => checkOperatorBalance(need - 1n, 20)).toThrow(/settlement operator holds/);
    expect(() => checkOperatorBalance(0n, 1)).toThrow(DemoError);
  });
});

describe("the book checks", () => {
  const lvl = (price: number, quantity: number, orders = 1) => ({ price: BigInt(price), quantity: BigInt(quantity), orders });
  const book: BookView = { bids: [lvl(24, 3), lvl(23, 5)], asks: [lvl(26, 2), lvl(27, 4)] };
  it("finds the levels an order would trade against", () => {
    expect(crossingLevels(book, "buy", 25n)).toEqual([]);
    expect(crossingLevels(book, "buy", 26n)).toEqual([lvl(26, 2)]);
    expect(crossingLevels(book, "sell", 24n)).toEqual([lvl(24, 3)]);
    expect(crossingLevels(book, "sell", 25n)).toEqual([]);
  });
  it("the taker may only meet the maker: one level, one order, its price and quantity", () => {
    const mine: BookView = { bids: [], asks: [lvl(26, 2)] };
    expect(matchesOnlyMaker(mine, "buy", 26n, 2n)).toBe(true);
    expect(matchesOnlyMaker({ bids: [], asks: [lvl(26, 2, 2)] }, "buy", 26n, 2n)).toBe(false); // someone else's order too
    expect(matchesOnlyMaker({ bids: [], asks: [lvl(26, 5)] }, "buy", 26n, 2n)).toBe(false);
    expect(matchesOnlyMaker({ bids: [], asks: [lvl(25, 1), lvl(26, 2)] }, "buy", 26n, 2n)).toBe(false); // a better price first
    expect(matchesOnlyMaker({ bids: [], asks: [] }, "buy", 26n, 2n)).toBe(false); // the maker is gone
  });
});

// ---------------------------------------------------------------------------
// The loop, against a fake engine
// ---------------------------------------------------------------------------

interface FakeOrder {
  id: string;
  wallet: DemoWallet;
  side: Side;
  lots: number;
  priceCents: number;
  status: "open" | "filled" | "cancelled";
}

function world(opts: { wallets?: number; settleAfterPolls?: number; failSettlement?: boolean; afford?: (w: DemoWallet, s: Side) => boolean; stopAtSleep?: number } = {}) {
  const wallets: DemoWallet[] = Array.from({ length: opts.wallets ?? 3 }, (_, i) => ({ name: `w${i}`, address: `addr${i}` }));
  const ctl = new AbortController();
  let t = 1_000_000;
  let sleeps = 0;
  let n = 0;
  const orders = new Map<string, FakeOrder>();
  const matches = new Map<string, { slots: string[]; polls: number }>();
  const violations: string[] = [];
  const log: string[] = [];
  const events: string[] = [];
  const delays: number[] = [];
  const cancelCalls: LiveOrder[] = [];
  const liveOn = (w: DemoWallet, s: Side) => [...orders.values()].filter((o) => o.status === "open" && o.wallet.address === w.address && o.side === s);
  const slotPending = (w: DemoWallet, s: Side) => [...matches.values()].some((m) => m.slots.includes(`${w.address}:${s}`) && m.polls < (opts.settleAfterPolls ?? 1));

  const deps: DemoDeps = {
    now: () => t,
    rng: seeded(11),
    sleep: async (ms, signal) => {
      if (signal.aborted) return;
      delays.push(ms);
      t += ms;
      sleeps++;
      if (opts.stopAtSleep !== undefined && sleeps >= opts.stopAtSleep) ctl.abort();
    },
    log: (l) => log.push(l),
    explorerTx: (s) => `https://explorer.solana.com/tx/${s}?cluster=devnet`,
    wallets,
    canAfford: async (w, s) => (opts.afford ? opts.afford(w, s) : true),
    book: async () => {
      const lv = (side: Side) => {
        const by = new Map<number, { q: number; c: number }>();
        for (const o of orders.values()) if (o.status === "open" && o.side === side) by.set(o.priceCents, { q: (by.get(o.priceCents)?.q ?? 0) + o.lots, c: (by.get(o.priceCents)?.c ?? 0) + 1 });
        return [...by].map(([p, v]) => ({ price: BigInt(p) * 10_000n, quantity: BigInt(v.q), orders: v.c }));
      };
      return { bids: lv("buy"), asks: lv("sell") };
    },
    priceOf: (c) => BigInt(c) * 10_000n,
    quantityOf: (l) => BigInt(l),
    approve: async (w, s) => {
      events.push(`approve ${w.name} ${s}`);
      if (liveOn(w, s).length > 0) violations.push(`approve over a live ${s} order of ${w.name}`);
      if (slotPending(w, s)) violations.push(`approve over an unsettled match on ${w.name} ${s}`);
    },
    place: async (w, s, lots, priceCents) => {
      events.push(`place ${w.name} ${s}`);
      if (liveOn(w, s).length > 0) violations.push(`two live ${s} orders on ${w.name}`);
      const o: FakeOrder = { id: `o${++n}`, wallet: w, side: s, lots, priceCents, status: "open" };
      orders.set(o.id, o);
      const placed: PlacedOrder = { id: o.id, nonce: `nonce${n}`, status: "open", matches: [] };
      const other = [...orders.values()].find((x) => x.status === "open" && x.side !== s && x.priceCents === priceCents && x.lots === lots && x.wallet.address !== w.address);
      if (other) {
        o.status = other.status = "filled";
        const id = `m${++n}`;
        matches.set(id, { slots: [`${w.address}:${s}`, `${other.wallet.address}:${other.side}`], polls: 0 });
        placed.status = "filled";
        placed.matches.push({ id, buyOrderId: s === "buy" ? o.id : other.id, sellOrderId: s === "sell" ? o.id : other.id });
      }
      return placed;
    },
    orderStatus: async (id) => orders.get(id)!.status,
    cancel: async (o) => {
      cancelCalls.push(o);
      events.push(`cancel ${o.id}`);
      const f = orders.get(o.id)!;
      if (f.status !== "open") return "gone";
      f.status = "cancelled";
      return "cancelled";
    },
    matchStatus: async (id) => {
      const m = matches.get(id)!;
      m.polls++;
      if (m.polls < (opts.settleAfterPolls ?? 1)) return { status: "pending", txHash: null };
      return opts.failSettlement ? { status: "failed", txHash: null, error: "boom" } : { status: "settled", txHash: `sig-${id}` };
    },
  };
  return { deps, ctl, orders, matches, violations, log, events, delays, cancelCalls, wallets };
}

describe("runDemo", () => {
  it("stops at the maximum trade count; every trade is a settled match logged with its Explorer link", async () => {
    const w = world({ settleAfterPolls: 2 });
    const s = await runDemo(w.deps, { durationMin: 240, maxTrades: 4 }, w.ctl.signal);
    expect(s).toMatchObject({ matched: 4, settled: 4, unsettled: 0, aborted: false, error: null });
    expect(w.violations).toEqual([]);
    for (const m of w.matches.keys()) expect(w.log.some((l) => l.includes(`https://explorer.solana.com/tx/sig-${m}?cluster=devnet`))).toBe(true);
    expect(w.log.filter((l) => l.includes("settled (")).length).toBe(4);
    expect(w.cancelCalls).toEqual([]); // nothing was left open
  });

  it("places one order every 20-60 s", async () => {
    const w = world();
    await runDemo(w.deps, { durationMin: 240, maxTrades: 6 }, w.ctl.signal);
    const placements = w.events.filter((e) => e.startsWith("place")).length;
    expect(placements).toBe(12); // a maker and a taker per trade
    for (const d of w.delays) {
      expect(d).toBeGreaterThanOrEqual(20_000);
      expect(d).toBeLessThanOrEqual(60_000);
    }
  });

  it("stops at the duration", async () => {
    const w = world();
    const s = await runDemo(w.deps, { durationMin: 5, maxTrades: 200 }, w.ctl.signal);
    expect(s.error).toBeNull();
    expect(s.matched).toBeGreaterThan(0);
    expect(s.matched).toBeLessThanOrEqual(plannedTrades({ durationMin: 5, maxTrades: 200 }));
    expect(w.orders.size).toBeLessThanOrEqual(2 * plannedTrades({ durationMin: 5, maxTrades: 200 }) + 1);
  });

  it("never has two live orders of a wallet on a side, nor approves over an unsettled match (two wallets, slow settlement)", async () => {
    const w = world({ wallets: 2, settleAfterPolls: 5 });
    const s = await runDemo(w.deps, { durationMin: 240, maxTrades: 5 }, w.ctl.signal);
    expect(w.violations).toEqual([]);
    expect(s.settled).toBe(5);
    expect(w.log.some((l) => l.startsWith("skip: no pair"))).toBe(true); // it waited for the settlements
  });

  it("Ctrl+C: cancels this script's open order with a signed cancel, then returns without waiting", async () => {
    const w = world({ stopAtSleep: 1 }); // aborted while the maker rests
    const s = await runDemo(w.deps, { durationMin: 240, maxTrades: 20 }, w.ctl.signal);
    expect(s.aborted).toBe(true);
    expect(s.matched).toBe(0);
    expect(s.cancelled).toBe(1);
    expect(w.cancelCalls).toHaveLength(1);
    const o = w.orders.get(w.cancelCalls[0]!.id)!;
    expect(o.status).toBe("cancelled");
    expect(w.events.at(-1)).toBe(`cancel ${o.id}`); // the cancel is the last thing it does
    expect(w.events.filter((e) => e.startsWith("place"))).toHaveLength(1); // no taker after the abort
  });

  it("Ctrl+C with trades in flight: no wait for them, and they are reported unsettled", async () => {
    const w = world({ settleAfterPolls: 1000, stopAtSleep: 2 });
    const s = await runDemo(w.deps, { durationMin: 240, maxTrades: 20 }, w.ctl.signal);
    expect(s.aborted).toBe(true);
    expect(s.matched).toBe(1);
    expect(s.unsettled).toBe(1);
  });

  it("a failed cancel is logged and the others are still tried", async () => {
    const w = world({ stopAtSleep: 1 });
    const real = w.deps.cancel;
    let calls = 0;
    w.deps.cancel = async (o) => {
      calls++;
      if (calls === 1) throw new Error("engine unreachable");
      return real(o);
    };
    const s = await runDemo(w.deps, { durationMin: 240, maxTrades: 20 }, w.ctl.signal);
    expect(s.cancelled).toBe(0);
    expect(w.log.some((l) => l.includes("FAILED: engine unreachable"))).toBe(true);
  });

  it("a failed settlement stops the run and cancels what is open", async () => {
    const w = world({ failSettlement: true });
    const s = await runDemo(w.deps, { durationMin: 240, maxTrades: 20 }, w.ctl.signal);
    expect(s.error).toMatch(/failed to settle: boom/);
    expect(s.settled).toBe(0);
    expect(w.orders.size).toBeLessThanOrEqual(3); // it did not carry on
  });

  it("an engine refusal stops the run and cancels the maker", async () => {
    const w = world();
    const real = w.deps.place;
    let n = 0;
    w.deps.place = async (...a) => {
      if (++n === 2) throw new Error("order refused (429)");
      return real(...a);
    };
    const s = await runDemo(w.deps, { durationMin: 240, maxTrades: 20 }, w.ctl.signal);
    expect(s.error).toMatch(/order refused/);
    expect(s.cancelled).toBe(1);
    expect([...w.orders.values()].every((o) => o.status !== "open")).toBe(true);
  });

  it("other orders at the maker's price: the maker is cancelled and nothing trades against them", async () => {
    const w = world();
    const realBook = w.deps.book;
    let injected = false;
    w.deps.book = async () => {
      const b = await realBook();
      // After the maker rests, a stranger's order appears at the same level.
      if (w.orders.size === 1 && !injected) {
        injected = true;
        const [lvl] = b.asks.length ? b.asks : b.bids;
        lvl!.orders += 1;
      }
      return b;
    };
    const s = await runDemo(w.deps, { durationMin: 3, maxTrades: 1 }, w.ctl.signal);
    expect(w.cancelCalls.length).toBeGreaterThanOrEqual(1);
    expect(w.log.some((l) => l.includes("other orders at this price"))).toBe(true);
    expect(s.error).toBeNull();
  });

  it("wallets that cannot afford the order are not used", async () => {
    const w = world({ wallets: 2, afford: (x) => x.name === "w0" });
    const s = await runDemo(w.deps, { durationMin: 3, maxTrades: 5 }, w.ctl.signal);
    expect(s.matched).toBe(0); // w1 can afford nothing, so no pair exists
    expect(w.events.some((e) => e.startsWith("place"))).toBe(false);
  });
});
