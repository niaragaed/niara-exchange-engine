import { parseUnits } from "../units.ts";

/**
 * Demo trading activity on Solana DEVNET between demo wallets Niara controls
 * (scripts/demo-activity.ts). TESTNET ONLY: test tokens, no real assets, no real money.
 *
 * These are real orders, real matches and real settlements on devnet, but every wallet
 * on both sides belongs to Niara: it is DEMO ACTIVITY, not market activity. Anything
 * that shows it (a chart, a history, a video) must say so (README, "Demo activity").
 *
 * This file is the pure part: the bounded price walk, the caps, the planning checks and
 * `runDemo`, the loop, which touches the world only through `DemoDeps` (clock, random
 * numbers, the engine, the chain), so tests drive it with fakes.
 */

// ---------------------------------------------------------------------------
// Caps and options
// ---------------------------------------------------------------------------

export const PRICE_CENTER_CENTS = 2500; // 25.00 mockUSDT per share
export const PRICE_BAND_BPS = 300; // +/- 3%
export const PRICE_MAX_STEP_CENTS = 20;

export const DEMO_CAPS = {
  /** New demo traders created on top of the two existing demo wallets. */
  maxTraders: 4,
  maxDurationMin: 240,
  maxTrades: 200,
  lots: { min: 1, max: 5 },
  delaySecs: { min: 20, max: 60 },
  /** Per trader, per run: a typo cannot drain the demo funder or the token source. */
  funding: { lamports: 50_000_000n, usdtWhole: 2_000n, eqtyWhole: 50n },
} as const;

export const DEMO_DEFAULTS = { durationMin: 30, maxTrades: 20, traders: 4, sol: "0.01", usdt: "500", eqty: "20" } as const;

/** What one settlement costs the operator: ~0.0007 SOL of rent plus fees. */
export const OPERATOR_LAMPORTS_PER_SETTLE = 750_000n;

export class DemoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DemoError";
  }
}

export interface DemoOptions {
  durationMin: number;
  maxTrades: number;
  traders: number;
  funding: { lamports: bigint; usdtWhole: bigint; eqtyWhole: bigint };
}

export interface RawDemoOptions {
  duration?: string;
  "max-trades"?: string;
  traders?: string;
  sol?: string;
  usdt?: string;
  eqty?: string;
}

const wholeInRange = (name: string, raw: string | undefined, fallback: string, min: number, max: number): number => {
  const text = raw ?? fallback;
  if (!/^\d{1,6}$/.test(text)) throw new DemoError(`--${name} must be a whole number`);
  const n = Number(text);
  if (n < min || n > max) throw new DemoError(`--${name} must be from ${min} to ${max}`);
  return n;
};

/** Validates the command line against the caps. */
export function parseDemoOptions(raw: RawDemoOptions): DemoOptions {
  let lamports: bigint;
  try {
    lamports = parseUnits(raw.sol ?? DEMO_DEFAULTS.sol, 9);
  } catch {
    throw new DemoError("--sol must be a decimal number of SOL");
  }
  if (lamports <= 0n || lamports > DEMO_CAPS.funding.lamports) throw new DemoError("--sol must be more than 0 and at most 0.05");
  const whole = (name: "usdt" | "eqty", cap: bigint): bigint => {
    const text = raw[name] ?? DEMO_DEFAULTS[name];
    if (!/^\d{1,9}$/.test(text)) throw new DemoError(`--${name} must be a whole number`);
    const v = BigInt(text);
    if (v <= 0n || v > cap) throw new DemoError(`--${name} must be from 1 to ${cap}`);
    return v;
  };
  return {
    durationMin: wholeInRange("duration", raw.duration, String(DEMO_DEFAULTS.durationMin), 1, DEMO_CAPS.maxDurationMin),
    maxTrades: wholeInRange("max-trades", raw["max-trades"], String(DEMO_DEFAULTS.maxTrades), 1, DEMO_CAPS.maxTrades),
    traders: wholeInRange("traders", raw.traders, String(DEMO_DEFAULTS.traders), 0, DEMO_CAPS.maxTraders),
    funding: { lamports, usdtWhole: whole("usdt", DEMO_CAPS.funding.usdtWhole), eqtyWhole: whole("eqty", DEMO_CAPS.funding.eqtyWhole) },
  };
}

/** The most trades the run can make: an upper bound, since each trade takes two orders at least 20 s apart. */
export function plannedTrades(o: Pick<DemoOptions, "durationMin" | "maxTrades">): number {
  return Math.min(o.maxTrades, Math.floor((o.durationMin * 60) / (2 * DEMO_CAPS.delaySecs.min)));
}

/** Refuses when the settlement operator cannot pay for the planned trades. */
export function checkOperatorBalance(operatorLamports: bigint, trades: number): bigint {
  const needed = OPERATOR_LAMPORTS_PER_SETTLE * BigInt(trades);
  if (operatorLamports < needed) {
    throw new DemoError(
      `the settlement operator holds ${operatorLamports} lamports; ${trades} planned settlements need about ${needed} ` +
        `(${OPERATOR_LAMPORTS_PER_SETTLE} each): top it up, or lower --duration / --max-trades`,
    );
  }
  return needed;
}

// ---------------------------------------------------------------------------
// The price walk and the order parameters
// ---------------------------------------------------------------------------

export type Rng = () => number; // [0, 1)

export function priceBoundsCents(center = PRICE_CENTER_CENTS, bandBps = PRICE_BAND_BPS): { lo: number; hi: number } {
  const band = Math.floor((center * bandBps) / 10_000);
  return { lo: center - band, hi: center + band };
}

/** One step of a bounded random walk: a step of up to +/- PRICE_MAX_STEP_CENTS, reflected at the band's edges. */
export function nextPriceCents(rng: Rng, prev: number, center = PRICE_CENTER_CENTS, bandBps = PRICE_BAND_BPS): number {
  const { lo, hi } = priceBoundsCents(center, bandBps);
  const step = Math.floor(rng() * (2 * PRICE_MAX_STEP_CENTS + 1)) - PRICE_MAX_STEP_CENTS;
  let p = Math.min(hi, Math.max(lo, prev)) + step;
  if (p > hi) p = hi - (p - hi);
  if (p < lo) p = lo + (lo - p);
  return Math.min(hi, Math.max(lo, p));
}

/** 2512 -> "25.12" */
export function centsToPrice(cents: number): string {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

const intIn = (rng: Rng, min: number, max: number) => min + Math.min(max - min, Math.floor(rng() * (max - min + 1)));
export const nextLots = (rng: Rng): number => intIn(rng, DEMO_CAPS.lots.min, DEMO_CAPS.lots.max);
export const nextDelaySecs = (rng: Rng): number => intIn(rng, DEMO_CAPS.delaySecs.min, DEMO_CAPS.delaySecs.max);

// ---------------------------------------------------------------------------
// The book (prices in mockUSDT base units per lot, quantities in asset base units)
// ---------------------------------------------------------------------------

export type Side = "buy" | "sell";
export interface BookLevel {
  price: bigint;
  quantity: bigint;
  orders: number;
}
export interface BookView {
  bids: readonly BookLevel[];
  asks: readonly BookLevel[];
}

/** The resting levels an order of `side` at `price` would trade against. */
export function crossingLevels(book: BookView, side: Side, price: bigint): BookLevel[] {
  return side === "buy" ? book.asks.filter((l) => l.price <= price) : book.bids.filter((l) => l.price >= price);
}

/** True when the taker would trade against our maker order only: one level, at its price, holding just its quantity. */
export function matchesOnlyMaker(book: BookView, takerSide: Side, price: bigint, makerQuantity: bigint): boolean {
  const levels = crossingLevels(book, takerSide, price);
  const [only] = levels;
  return levels.length === 1 && only!.price === price && only!.orders === 1 && only!.quantity === makerQuantity;
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

export interface DemoWallet {
  name: string;
  address: string;
}

export interface PlacedOrder {
  id: string;
  nonce: string;
  status: string;
  matches: { id: string; buyOrderId: string; sellOrderId: string }[];
}

export interface DemoDeps {
  /** Milliseconds. */
  now: () => number;
  rng: Rng;
  /** Resolves after `ms`, or at once when `signal` aborts. */
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  log: (line: string) => void;
  explorerTx: (signature: string) => string;
  wallets: readonly DemoWallet[];
  /** Whether the wallet holds what an order needs (sell: the shares; buy: shares x price). */
  canAfford: (wallet: DemoWallet, side: Side, lots: number, priceCents: number) => Promise<boolean>;
  book: () => Promise<BookView>;
  /** The base-unit price per lot and quantity of a price in cents and a number of lots. */
  priceOf: (priceCents: number) => bigint;
  quantityOf: (lots: number) => bigint;
  /** Approves EXACTLY what the order needs to the vault (one devnet transaction). Not called in a dry run. */
  approve: (wallet: DemoWallet, side: Side, lots: number, priceCents: number) => Promise<void>;
  /** Signs and submits the order intent. Throws when the engine refuses. */
  place: (wallet: DemoWallet, side: Side, lots: number, priceCents: number) => Promise<PlacedOrder>;
  orderStatus: (orderId: string) => Promise<string>;
  /** Signs and submits the cancellation. "gone" = it was no longer live. Throws on other refusals. */
  cancel: (order: LiveOrder) => Promise<"cancelled" | "gone">;
  matchStatus: (matchId: string) => Promise<{ status: string; txHash: string | null; error?: string | null }>;
}

export interface LiveOrder {
  id: string;
  nonce: string;
  wallet: DemoWallet;
  side: Side;
}

export interface DemoSummary {
  matched: number;
  settled: number;
  cancelled: number;
  unsettled: number;
  aborted: boolean;
  error: string | null;
}

const SETTLE_WAIT_MS = 180_000;

/**
 * Alternates a maker order (rests at the walk's price) and a taker order (opposite side,
 * another wallet, the same price and quantity), so each pair is one real match. One order
 * every 20-60 s. Stops at the duration, at `maxTrades` matches, on `signal`, or on any
 * error; then cancels the orders it left open with signed cancellations.
 *
 * Rules kept: never two live orders of one wallet on one side (one delegate per token
 * account): a wallet side stays busy until its order is cancelled or its match is
 * settled, because `approve` for a new order would replace the delegation a pending
 * settlement still needs. Only a settled match counts as a trade, and a failed
 * settlement stops the run.
 */
export async function runDemo(deps: DemoDeps, options: Pick<DemoOptions, "durationMin" | "maxTrades">, signal: AbortSignal): Promise<DemoSummary> {
  const busy = new Set<string>(); // `${address}:${side}`
  const slot = (w: DemoWallet, s: Side) => `${w.address}:${s}`;
  const live = new Map<string, LiveOrder>();
  const pending = new Map<string, string[]>(); // match id -> busy slots to free once settled
  let maker: { order: LiveOrder; taker: DemoWallet; lots: number; priceCents: number } | null = null;
  let priceCents = PRICE_CENTER_CENTS;
  let matched = 0;
  let settled = 0;
  let cancelled = 0;
  let error: string | null = null;
  const endAt = deps.now() + options.durationMin * 60_000;
  const opposite = (s: Side): Side => (s === "buy" ? "sell" : "buy");

  const pollPending = async (): Promise<void> => {
    for (const [id, slots] of [...pending]) {
      const s = await deps.matchStatus(id);
      if (s.status === "failed") throw new DemoError(`match ${id} failed to settle: ${s.error ?? "see the service log"}`);
      if (s.status !== "settled") continue;
      settled++;
      for (const k of slots) busy.delete(k);
      pending.delete(id);
      deps.log(`  settled (${settled}): ${s.txHash ? deps.explorerTx(s.txHash) : "(no transaction hash reported)"}`);
    }
  };

  const release = (m: NonNullable<typeof maker>) => {
    busy.delete(slot(m.order.wallet, m.order.side));
    busy.delete(slot(m.taker, opposite(m.order.side)));
    live.delete(m.order.id);
  };

  const placeMaker = async (): Promise<void> => {
    priceCents = nextPriceCents(deps.rng, priceCents);
    const lots = nextLots(deps.rng);
    const side: Side = deps.rng() < 0.5 ? "buy" : "sell";
    const book = await deps.book();
    if (crossingLevels(book, side, deps.priceOf(priceCents)).length > 0) {
      deps.log(`skip: a ${side} at ${centsToPrice(priceCents)} would trade against another order in the book`);
      return;
    }
    const wallets = [...deps.wallets].sort(() => deps.rng() - 0.5);
    for (const mk of wallets) {
      if (busy.has(slot(mk, side)) || !(await deps.canAfford(mk, side, lots, priceCents))) continue;
      for (const tk of wallets) {
        if (tk.address === mk.address || busy.has(slot(tk, opposite(side))) || !(await deps.canAfford(tk, opposite(side), lots, priceCents))) continue;
        busy.add(slot(mk, side));
        busy.add(slot(tk, opposite(side)));
        try {
          await deps.approve(mk, side, lots, priceCents);
          const placed = await deps.place(mk, side, lots, priceCents);
          const order: LiveOrder = { id: placed.id, nonce: placed.nonce, wallet: mk, side };
          live.set(order.id, order);
          maker = { order, taker: tk, lots, priceCents };
          deps.log(`maker: ${mk.name} ${side} ${lots} at ${centsToPrice(priceCents)} (order ${placed.id}, ${placed.status})`);
          if (placed.matches.length > 0) throw new DemoError("the maker order matched at once: the book changed after it was read");
        } catch (e) {
          if (!maker) {
            busy.delete(slot(mk, side));
            busy.delete(slot(tk, opposite(side)));
          }
          throw e;
        }
        return;
      }
    }
    deps.log("skip: no pair of wallets is free and funded for this order");
  };

  const placeTaker = async (): Promise<void> => {
    const m = maker!;
    const status = await deps.orderStatus(m.order.id);
    if (status !== "open") {
      deps.log(`maker order ${m.order.id} is ${status}: starting over`);
      release(m);
      maker = null;
      return;
    }
    const takerSide = opposite(m.order.side);
    const book = await deps.book();
    if (!matchesOnlyMaker(book, takerSide, deps.priceOf(m.priceCents), deps.quantityOf(m.lots))) {
      deps.log("the book holds other orders at this price: cancelling the maker and starting over");
      if ((await deps.cancel(m.order)) === "cancelled") cancelled++;
      release(m);
      maker = null;
      return;
    }
    await deps.approve(m.taker, takerSide, m.lots, m.priceCents);
    const placed = await deps.place(m.taker, takerSide, m.lots, m.priceCents);
    if (placed.matches.length === 0) {
      live.set(placed.id, { id: placed.id, nonce: placed.nonce, wallet: m.taker, side: takerSide });
      throw new DemoError(`the taker order ${placed.id} did not match (${placed.status}); stopping`);
    }
    const slots = [slot(m.order.wallet, m.order.side), slot(m.taker, takerSide)];
    for (const x of placed.matches) {
      matched++;
      pending.set(x.id, slots);
      deps.log(`taker: ${m.taker.name} ${takerSide} ${m.lots} at ${centsToPrice(m.priceCents)}: match ${x.id} (${matched}), waiting for the worker`);
    }
    live.delete(m.order.id); // filled
    maker = null;
  };

  const cancelOpen = async (): Promise<void> => {
    for (const o of live.values()) {
      try {
        const r = await deps.cancel(o);
        if (r === "cancelled") cancelled++;
        deps.log(`cancel: ${o.wallet.name} ${o.side} order ${o.id}: ${r === "cancelled" ? "cancelled" : "no longer live"}`);
      } catch (e) {
        deps.log(`cancel: order ${o.id} FAILED: ${e instanceof Error ? e.message : String(e)} (it expires on its own)`);
      }
    }
    live.clear();
  };

  try {
    while (!signal.aborted && deps.now() < endAt && matched < options.maxTrades) {
      await pollPending();
      if (maker) await placeTaker();
      else await placeMaker();
      if (matched >= options.maxTrades) break;
      await deps.sleep(nextDelaySecs(deps.rng) * 1000, signal);
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    deps.log(`ERROR: ${error}`);
  }

  await cancelOpen();

  if (!signal.aborted && error === null) {
    const until = deps.now() + SETTLE_WAIT_MS;
    try {
      while (pending.size > 0 && deps.now() < until && !signal.aborted) {
        await pollPending();
        if (pending.size > 0) await deps.sleep(3_000, signal);
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      deps.log(`ERROR: ${error}`);
    }
  }
  return { matched, settled, cancelled, unsettled: pending.size, aborted: signal.aborted, error };
}
