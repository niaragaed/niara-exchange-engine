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
import type { Match } from "../engine/types.ts";
import { admitCancelIntent, parseCancelIntent } from "../intents/cancel.ts";
import { IntentError } from "../intents/types.ts";
import { parseOrderIntent } from "../intents/validate.ts";
import { admitOrderIntent } from "../intents/verify.ts";
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

  /** Engine state, for tests and diagnostics. */
  state() {
    return this.engine.exportState();
  }

  /** Runs `fn` under the mutex and in one service_role transaction; any failure is fatal. */
  private async exclusive(fn: (tx: Queryable) => Promise<Reply>): Promise<Reply> {
    return this.mutex.run(async () => {
      if (this.failed) return error(503, "unavailable", "the service stopped after a database failure");
      try {
        return await asServiceRole(this.deps.db, fn);
      } catch (e) {
        this.failed = true;
        this.deps.log?.("fatal", { error: e instanceof Error ? e.message : String(e) });
        this.deps.onFatal(e);
        return error(503, "unavailable", "database write failed; the service is restarting");
      }
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

    return this.exclusive(async (tx) => {
      const now = this.deps.clock();
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
    });
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
