import { isChainId, type ChainId } from "../chains.ts";
import type { Database, Queryable } from "../db/database.ts";
import {
  acquireInstanceLock,
  asServiceRole,
  checkServiceRole,
  countOpenOrders,
  findOrderByNonce,
  loadChains,
  loadListings,
} from "../db/repository.ts";
import type { CancelReason, EngineEvent, MatchingEngine, OrderView } from "../engine/engine.ts";
import type { Match, OrderInput } from "../engine/types.ts";
import { admitCancelIntent, parseCancelIntent } from "../intents/cancel.ts";
import { IntentError } from "../intents/types.ts";
import { parseOrderIntent } from "../intents/validate.ts";
import { admitOrderIntent } from "../intents/verify.ts";
import { loadSettlement } from "../db/settlements.ts";
import { isUuidV4 } from "../engine/ids.ts";
import { orderNeed, type CoverageChecker } from "../solana/coverage.ts";
import { buildCatalog, canonicalAddress, type Catalog } from "./catalog.ts";
import { persistEvents, persistPlacement } from "./persist.ts";
import { rebuildEngine } from "./rebuild.ts";

/**
 * The order service (single process, single instance). TESTNET ONLY.
 *
 * Every state change runs under one in-process mutex and in one database transaction
 * as `service_role`: the checks that read the database (nonce, open orders), the
 * engine call, and the writes of its outcome (the order, its matches, the other orders
 * it changed) commit together or not at all. The engine is in memory, so a failed
 * write leaves it ahead of the database: the service then refuses everything
 * (`fatal`) and the process must restart, which rebuilds the engine from the database.
 *
 * Nothing here settles anything: matches are stored `pending` for the settlement
 * worker, which is still a stub.
 */

export interface Json {
  [key: string]: unknown;
}

export interface Reply {
  status: number;
  body: Json;
}

export interface OrderServiceDeps {
  db: Database;
  /** Unix seconds. */
  clock: () => number;
  newOrderId: () => string;
  newMatchId: () => string;
  settlementMarginSecs: number;
  maxOpenOrdersPerWallet: number;
  /** On-chain delegate checks per chain (spec §3.5); a chain without one is not checked. */
  coverage?: Partial<Record<ChainId, CoverageChecker>>;
  /** Called once when the engine and the database may have diverged: stop the process. */
  onFatal: (err: unknown) => void;
  log?: (event: string, data?: Json) => void;
}

export class NotSingleInstanceError extends Error {
  constructor() {
    super("another order service instance holds the advisory lock: refusing to start");
    this.name = "NotSingleInstanceError";
  }
}

export class ServiceRoleError extends Error {
  constructor() {
    super("the database login role is not a member of service_role: refusing to start");
    this.name = "ServiceRoleError";
  }
}

class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = result.catch(() => undefined);
    return result;
  }
}

const error = (status: number, code: string, detail?: string): Reply => ({
  status,
  body: detail === undefined ? { error: code } : { error: code, detail },
});

function cancelReasonOf(events: readonly EngineEvent[], orderId: string): CancelReason | undefined {
  for (const e of events) if (e.type === "order_cancelled" && e.orderId === orderId) return e.reason;
  return undefined;
}

export function orderJson(o: OrderView, cancelReason?: CancelReason): Json {
  return {
    id: o.id,
    seq: o.seq,
    chain: o.chain,
    asset: o.asset,
    wallet: o.wallet,
    side: o.side,
    quantity: o.quantity.toString(),
    lotSize: o.lotSize.toString(),
    limitPrice: o.limitPrice.toString(),
    paymentAsset: o.paymentAsset,
    expiresAt: o.expiresAt,
    filledQuantity: o.filledQuantity.toString(),
    remaining: o.remaining.toString(),
    status: o.status,
    ...(cancelReason ? { cancelReason } : {}),
  };
}

export function matchJson(m: Match): Json {
  return {
    id: m.id,
    sequence: m.sequence,
    chain: m.chain,
    asset: m.asset,
    paymentAsset: m.paymentAsset,
    buyOrderId: m.buyOrderId,
    sellOrderId: m.sellOrderId,
    makerOrderId: m.makerOrderId,
    takerSide: m.takerSide,
    quantity: m.quantity.toString(),
    lotSize: m.lotSize.toString(),
    price: m.price.toString(),
    paymentAmount: m.paymentAmount.toString(),
    expiresAt: m.expiresAt,
    // Matched off-chain only. Settlement is the worker's (a stub in this build).
    status: "pending",
  };
}

function bodyFields(body: unknown, intentField: string): { payload: unknown; signature: string } | Reply {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return error(400, "malformed", "body must be a JSON object");
  }
  const o = body as Record<string, unknown>;
  for (const key of Object.keys(o)) {
    if (key !== intentField && key !== "signature") return error(400, "malformed", `unexpected field: ${key}`);
  }
  if (typeof o["signature"] !== "string" || o["signature"].length === 0 || o["signature"].length > 200) {
    return error(400, "malformed", "signature must be a non-empty string");
  }
  return { payload: o[intentField], signature: o["signature"] };
}

export class OrderService {
  private readonly mutex = new Mutex();
  private failed = false;
  private readonly deps: OrderServiceDeps;
  private readonly engine: MatchingEngine;
  private catalog: Catalog;

  // No parameter properties: Node runs this file with type stripping only.
  private constructor(deps: OrderServiceDeps, engine: MatchingEngine, catalog: Catalog) {
    this.deps = deps;
    this.engine = engine;
    this.catalog = catalog;
  }

  /**
   * Starts the service on `db`: checks the service role, takes the single-instance
   * advisory lock (refuses to start if another instance holds it), and rebuilds the
   * engine from the database.
   */
  static async start(deps: OrderServiceDeps): Promise<OrderService> {
    if (!(await checkServiceRole(deps.db))) throw new ServiceRoleError();
    if (!(await acquireInstanceLock(deps.db))) throw new NotSingleInstanceError();
    const { engine, catalog } = await rebuildEngine(deps.db, {
      newMatchId: deps.newMatchId,
      settlementMarginSecs: deps.settlementMarginSecs,
    });
    const service = new OrderService(deps, engine, catalog);
    service.logSkipped();
    deps.log?.("service_started", { openOrders: engine.exportState().orders.length, markets: catalog.markets.length });
    return service;
  }

  /** The admission config of a chain, as last read from `chains`. */
  chainConfig(chain: ChainId) {
    return this.catalog.chains.get(chain);
  }

  /** Engine state, for tests and diagnostics. */
  state() {
    return this.engine.exportState();
  }

  /** Runs `fn` under the mutex and in one service_role transaction; any failure is fatal. */
  private async exclusive(fn: (tx: Queryable) => Promise<Reply>): Promise<Reply> {
    return this.mutex.run(() => this.inTransaction(fn));
  }

  /** One service_role transaction (caller holds the mutex); any failure is fatal. */
  private async inTransaction(fn: (tx: Queryable) => Promise<Reply>): Promise<Reply> {
    if (this.failed) return error(503, "unavailable", "the service stopped after a database failure");
    try {
      return await asServiceRole(this.deps.db, fn);
    } catch (e) {
      this.failed = true;
      this.deps.log?.("fatal", { error: e instanceof Error ? e.message : String(e) });
      this.deps.onFatal(e);
      return error(503, "unavailable", "database write failed; the service is restarting");
    }
  }

  /**
   * Spec §3.5, before matching: checks on-chain the resting orders `order` would trade
   * with, best first, until their covered quantity reaches the order's (in rounds of 50,
   * at most 5). Returns the ids of those whose delegation or balance no longer covers
   * them. Throws on RPC trouble. Caller holds the mutex.
   */
  private async uncoveredMakers(order: OrderInput, now: number, checker: CoverageChecker): Promise<string[]> {
    const checked = new Set<string>();
    const stale: string[] = [];
    let covered = 0n;
    for (let round = 0; round < 5 && covered < order.quantity; round++) {
      const candidates = this.engine.crossingOrders(order, now, 50, checked);
      if (candidates.length === 0) break;
      const results = await checker.check(candidates.map(orderNeed));
      candidates.forEach((c, i) => {
        checked.add(c.id);
        if (results[i] === null) covered += c.remaining;
        else {
          stale.push(c.id);
          this.deps.log?.("order_not_covered", { orderId: c.id, reason: results[i] });
        }
      });
    }
    return stale;
  }

  /**
   * Spec §3.5: takes orders out of the book because their on-chain delegation or balance
   * no longer covers them, and stores them `stale` (the settlement worker calls this
   * before settling). Terminal orders are left as they are.
   */
  async markStale(orderIds: readonly string[]): Promise<Reply> {
    return this.exclusive(async (tx) => {
      const events = orderIds.flatMap((id) => this.engine.markStale(id));
      await persistEvents(tx, this.engine, events);
      return { status: 200, body: { stale: events.length } };
    });
  }

  async submitOrder(body: unknown): Promise<Reply> {
    const fields = bodyFields(body, "intent");
    if ("status" in fields) return fields;
    let intent;
    try {
      intent = parseOrderIntent(fields.payload);
    } catch (e) {
      if (e instanceof IntentError) return error(400, e.code, e.message);
      throw e;
    }
    const chain = this.catalog.chains.get(intent.chain);
    if (!chain) return error(422, "chain_not_ready", `${intent.chain} is not configured`);
    // Signature checks are CPU work: done before taking the mutex.
    const admitted = await admitOrderIntent({
      intent,
      signature: fields.signature,
      orderId: this.deps.newOrderId(),
      now: this.deps.clock(),
      chain,
    });
    if (!admitted.ok) return error(admitted.reason === "bad_signature" ? 401 : 422, admitted.reason, admitted.detail);
    const { order } = admitted;

    // Spec §3.5: the new order must be covered on-chain before it can enter the book.
    const checker = this.deps.coverage?.[order.chain];
    if (checker) {
      let reason: string | null | undefined;
      try {
        [reason] = await checker.check([orderNeed({ ...order, remaining: order.quantity })]);
      } catch (e) {
        this.deps.log?.("coverage_check_failed", { error: e instanceof Error ? e.message : String(e) });
        return error(503, "chain_unavailable", "could not check the on-chain delegation; try again");
      }
      if (reason) return error(422, "delegate_not_covered", reason);
    }

    return this.mutex.run(async () => {
      const now = this.deps.clock();
      let stale: string[] = [];
      if (checker) {
        try {
          stale = await this.uncoveredMakers(order, now, checker);
        } catch (e) {
          this.deps.log?.("coverage_check_failed", { error: e instanceof Error ? e.message : String(e) });
          return error(503, "chain_unavailable", "could not check the resting orders' on-chain delegations; try again");
        }
      }
      return this.inTransaction((tx) => this.placeChecked(tx, admitted, now, stale));
    });
  }

  /** The database part of a submission, in one transaction: stale makers out, checks, match, write. */
  private async placeChecked(
    tx: Queryable,
    admitted: Extract<Awaited<ReturnType<typeof admitOrderIntent>>, { ok: true }>,
    now: number,
    stale: readonly string[],
  ): Promise<Reply> {
    const { order } = admitted;
    const staleEvents = stale.flatMap((id) => this.engine.markStale(id));
    await persistEvents(tx, this.engine, staleEvents);
    if (await findOrderByNonce(tx, order.chain, order.wallet, admitted.intent.nonce)) {
      return error(409, "duplicate_nonce", "this wallet already used this nonce on this chain");
    }
    const open = await countOpenOrders(tx, order.chain, order.wallet, now);
    if (open >= this.deps.maxOpenOrdersPerWallet) {
      return error(429, "too_many_open_orders", `at most ${this.deps.maxOpenOrdersPerWallet} open orders per wallet`);
    }
    const result = this.engine.place(order, now);
    if (!result.accepted) return error(422, result.reason);
    await persistPlacement(tx, this.engine, this.catalog, result, {
      nonce: admitted.intent.nonce,
      intentVersion: admitted.intent.version,
      intentSignature: admitted.signature,
    });
    return {
      status: 201,
      body: {
        order: orderJson(result.order, cancelReasonOf(result.events, result.order.id)),
        matches: result.matches.map(matchJson),
      },
    };
  }

  async cancelOrder(body: unknown): Promise<Reply> {
    const fields = bodyFields(body, "cancel");
    if ("status" in fields) return fields;
    let cancel;
    try {
      cancel = parseCancelIntent(fields.payload);
    } catch (e) {
      if (e instanceof IntentError) return error(400, e.code, e.message);
      throw e;
    }
    const chain = this.catalog.chains.get(cancel.chain);
    if (!chain) return error(422, "chain_not_ready", `${cancel.chain} is not configured`);
    const admitted = await admitCancelIntent({ cancel, signature: fields.signature, chain });
    if (!admitted.ok) return error(admitted.reason === "bad_signature" ? 401 : 422, admitted.reason, admitted.detail);
    const c = admitted.cancel;

    return this.exclusive(async (tx) => {
      const found = await findOrderByNonce(tx, c.chain, c.wallet, c.nonce);
      if (!found) return error(404, "unknown_order", "no order of this wallet with this nonce on this chain");
      const result = this.engine.cancel(found.id, c.wallet);
      if (!result.cancelled) {
        // An order that was terminal before a restart is unknown to the engine.
        if (result.reason === "not_live" || result.reason === "unknown_order") {
          return error(409, "not_live", `the order is ${found.status}`);
        }
        return error(403, result.reason);
      }
      await persistEvents(tx, this.engine, result.events);
      return { status: 200, body: { order: orderJson(result.order, "by_wallet") } };
    });
  }

  /** Public book: price levels only (no wallets, ids or nonces), matchable orders only. */
  async book(chainParam: string, assetParam: string): Promise<Reply> {
    if (!isChainId(chainParam)) return error(404, "unknown_chain");
    const chain: ChainId = chainParam;
    const asset = canonicalAddress(chain, assetParam);
    const market = asset === null ? undefined : this.catalog.markets.find((m) => m.chain === chain && m.asset === asset);
    if (!market || asset === null) return error(404, "unknown_market");
    return this.mutex.run(async () => {
      const b = this.engine.book(chain, asset, this.deps.clock());
      const level = (l: { price: bigint; quantity: bigint; orders: number }) => ({
        price: l.price.toString(),
        quantity: l.quantity.toString(),
        orders: l.orders,
      });
      return {
        status: 200,
        body: {
          chain,
          asset,
          assetClass: market.assetClass,
          status: market.status,
          lotSize: market.lotSize.toString(),
          quoteAsset: market.quoteAsset,
          minOrderNotional: market.minOrderNotional.toString(),
          bids: b.bids.map(level),
          asks: b.asks.map(level),
        },
      };
    });
  }

  /**
   * A match's settlement state: public fields only (no wallets). Match ids are random
   * UUID v4s, handed to the two parties in the order responses.
   */
  async settlementStatus(matchId: string): Promise<Reply> {
    if (!isUuidV4(matchId)) return error(404, "unknown_match");
    const row = await asServiceRole(this.deps.db, (tx) => loadSettlement(tx, matchId));
    if (!row) return error(404, "unknown_match");
    return {
      status: 200,
      body: {
        matchId: row.matchId,
        status: row.matchStatus,
        settlement: row.status === null ? null : { status: row.status, attempts: row.attempts, txHash: row.txHash, error: row.error },
      },
    };
  }

  /** Takes every order that is no longer matchable out of the books and stores it expired. */
  async sweepExpired(): Promise<Reply> {
    return this.exclusive(async (tx) => {
      const events = this.engine.expire(this.deps.clock());
      await persistEvents(tx, this.engine, events);
      return { status: 200, body: { expired: events.length } };
    });
  }

  /** Re-reads chains and listings (status, minimum notional, USDT, program). */
  async refreshMarkets(): Promise<Reply> {
    return this.exclusive(async (tx) => {
      const catalog = buildCatalog(await loadChains(tx), await loadListings(tx));
      for (const m of catalog.markets) {
        try {
          this.engine.upsertMarket(m);
        } catch (e) {
          // A lot size change while orders rest is refused: the old market stays.
          this.deps.log?.("market_not_updated", { chain: m.chain, asset: m.asset, error: (e as Error).message });
        }
      }
      this.catalog = catalog;
      this.logSkipped();
      return { status: 200, body: { markets: catalog.markets.length } };
    });
  }

  private logSkipped(): void {
    for (const s of this.catalog.skipped) this.deps.log?.("listing_skipped", { ...s });
  }
}
