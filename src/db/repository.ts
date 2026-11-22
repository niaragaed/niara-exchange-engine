import type { ChainId } from "../chains.ts";
import type { CancelReason, OrderStatus } from "../engine/engine.ts";
import type { AssetClass, ListingStatus, Match, Side } from "../engine/types.ts";
import type { Database, Queryable } from "./database.ts";

/**
 * Every read and write of the order service. Writes (and the reads that feed them) run
 * in a transaction that first switches to the Supabase `service_role`
 * (`set local role`), so the migration's grants apply to the service exactly as
 * designed: insert and update, never delete. The connecting login role must be a
 * member of `service_role` (`checkServiceRole`).
 */

export const SERVICE_ROLE = "service_role";

/** Name hashed into the 64-bit key of the single-instance advisory lock. */
export const INSTANCE_LOCK_NAME = "niara-exchange-engine/order-service";

/** Runs `fn` in one transaction as `service_role`. */
export function asServiceRole<T>(db: Database, fn: (tx: Queryable) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.query(`set local role ${SERVICE_ROLE}`);
    return fn(tx);
  });
}

/** True when the connected login role may `set role service_role`. */
export async function checkServiceRole(db: Queryable): Promise<boolean> {
  const r = await db.query<{ ok: boolean }>(`select pg_has_role(current_user, $1, 'MEMBER') as ok`, [SERVICE_ROLE]);
  return r.rows[0]?.ok === true;
}

/**
 * Takes the session-level advisory lock that makes the order service a single
 * instance. Non-blocking: false when another session holds it. Held until the session
 * ends (the process exits or its connection drops).
 */
export async function acquireInstanceLock(db: Queryable): Promise<boolean> {
  const r = await db.query<{ locked: boolean }>(`select pg_try_advisory_lock(hashtextextended($1, 0)) as locked`, [
    INSTANCE_LOCK_NAME,
  ]);
  return r.rows[0]?.locked === true;
}

export async function releaseInstanceLock(db: Queryable): Promise<void> {
  await db.query(`select pg_advisory_unlock(hashtextextended($1, 0))`, [INSTANCE_LOCK_NAME]);
}

// ---------------------------------------------------------------------------
// Configuration: chains and listings
// ---------------------------------------------------------------------------

export interface ChainRow {
  id: ChainId;
  settlementProgram: string | null;
  quoteAsset: string | null;
  minOrderNotional: bigint;
  maxIntentValiditySecs: number;
}

export async function loadChains(tx: Queryable): Promise<ChainRow[]> {
  const r = await tx.query<{
    id: ChainId;
    settlement_program: string | null;
    quote_asset: string | null;
    min_order_notional: string;
    max_intent_validity_secs: number;
  }>(
    `select id, settlement_program, quote_asset, min_order_notional::text, max_intent_validity_secs
       from public.chains order by id`,
  );
  return r.rows.map((c) => ({
    id: c.id,
    settlementProgram: c.settlement_program,
    quoteAsset: c.quote_asset,
    minOrderNotional: BigInt(c.min_order_notional),
    maxIntentValiditySecs: Number(c.max_intent_validity_secs),
  }));
}

export interface ListingRow {
  chain: ChainId;
  /** Exactly as stored: orders and matches reference it by foreign key. */
  asset: string;
  assetClass: AssetClass;
  status: ListingStatus;
  lotSize: bigint;
}

export async function loadListings(tx: Queryable): Promise<ListingRow[]> {
  const r = await tx.query<{
    chain_id: ChainId;
    asset: string;
    asset_class: AssetClass;
    status: ListingStatus;
    lot_size: string;
  }>(`select chain_id, asset, asset_class::text, status::text, lot_size::text from public.listings order by chain_id, asset`);
  return r.rows.map((l) => ({
    chain: l.chain_id,
    asset: l.asset,
    assetClass: l.asset_class,
    status: l.status,
    lotSize: BigInt(l.lot_size),
  }));
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

export interface OrderRow {
  id: string;
  seq: number;
  chain: ChainId;
  /** As stored (the listing's spelling). */
  asset: string;
  side: Side;
  quantity: bigint;
  lotSize: bigint;
  limitPrice: bigint;
  paymentAsset: string;
  wallet: string;
  nonce: string;
  /** Unix seconds. */
  expiresAt: number;
  intentVersion: number;
  intentSignature: string;
  filledQuantity: bigint;
  /** Migration 20261120120000: settled on-chain / released / voided by failed matches. */
  settledQuantity?: bigint;
  releasedQuantity?: bigint;
  voidedQuantity?: bigint;
  status: OrderStatus;
  /** Migration 20261120130000: why the order left the book; the wallet's signature if it cancelled. */
  cancelReason?: StoredCancelReason | null;
  cancelSignature?: string | null;
}

/**
 * `orders.cancel_reason`: the engine's cancel reasons, plus expiry and stale. Required for
 * the statuses cancelled, expired and stale, absent otherwise (`orders_cancel_reason_check`).
 */
export type StoredCancelReason = CancelReason | "expired" | "stale";

/** Why an order left the book, as written with its new status. */
export interface OrderClosing {
  reason: StoredCancelReason;
  /** The wallet's cancellation signature: required for `by_wallet`, refused otherwise. */
  signature?: string;
}

export const ORDER_COLUMNS = `id::text, seq::text, chain_id, asset, side::text, quantity::text, lot_size::text,
  limit_price::text, payment_asset, wallet, nonce, extract(epoch from expires_at)::bigint::text as expires_at,
  intent_version, intent_signature, filled_quantity::text, settled_quantity::text, released_quantity::text,
  voided_quantity::text, status::text, cancel_reason::text, cancel_signature`;

export interface RawOrder {
  id: string;
  seq: string;
  chain_id: ChainId;
  asset: string;
  side: Side;
  quantity: string;
  lot_size: string;
  limit_price: string;
  payment_asset: string;
  wallet: string;
  nonce: string;
  expires_at: string;
  intent_version: number;
  intent_signature: string;
  filled_quantity: string;
  settled_quantity: string;
  released_quantity: string;
  voided_quantity: string;
  status: OrderStatus;
  cancel_reason: StoredCancelReason | null;
  cancel_signature: string | null;
}

export function toOrderRow(o: RawOrder): OrderRow {
  return {
    id: o.id,
    seq: Number(o.seq),
    chain: o.chain_id,
    asset: o.asset,
    side: o.side,
    quantity: BigInt(o.quantity),
    lotSize: BigInt(o.lot_size),
    limitPrice: BigInt(o.limit_price),
    paymentAsset: o.payment_asset,
    wallet: o.wallet,
    nonce: o.nonce,
    expiresAt: Number(o.expires_at),
    intentVersion: Number(o.intent_version),
    intentSignature: o.intent_signature,
    filledQuantity: BigInt(o.filled_quantity),
    settledQuantity: BigInt(o.settled_quantity),
    releasedQuantity: BigInt(o.released_quantity),
    voidedQuantity: BigInt(o.voided_quantity),
    status: o.status,
    cancelReason: o.cancel_reason,
    cancelSignature: o.cancel_signature,
  };
}

/**
 * What the engine is rebuilt from on start, in the original arrival sequence: every
 * order that is not terminal (`open`, `partially_filled`, `stale`), and the `filled`
 * ones with quantity still in flight (a failed match may give it back to them).
 */
export async function loadOpenOrders(tx: Queryable): Promise<OrderRow[]> {
  const r = await tx.query<RawOrder>(
    `select ${ORDER_COLUMNS} from public.orders
      where status in ('open', 'partially_filled', 'stale')
         or (status = 'filled' and filled_quantity - settled_quantity - released_quantity - voided_quantity > 0)
      -- qualified: a bare "seq" would sort the text output column (1, 10, 2)
      order by public.orders.seq`,
  );
  return r.rows.map(toOrderRow);
}

export async function loadOrder(tx: Queryable, id: string): Promise<OrderRow | null> {
  const r = await tx.query<RawOrder>(`select ${ORDER_COLUMNS} from public.orders where id = $1`, [id]);
  return r.rows[0] ? toOrderRow(r.rows[0]) : null;
}

/** The order a (chain, wallet, nonce) names, if any: nonces are unique per (chain, wallet). */
export async function findOrderByNonce(
  tx: Queryable,
  chain: ChainId,
  wallet: string,
  nonce: string,
): Promise<{ id: string; status: OrderStatus } | null> {
  const r = await tx.query<{ id: string; status: OrderStatus }>(
    `select id::text, status::text from public.orders where chain_id = $1 and wallet = $2 and nonce = $3`,
    [chain, wallet, nonce],
  );
  return r.rows[0] ?? null;
}

/** Orders of (chain, wallet) that are not terminal and not past their expiry at `now`. */
export async function countOpenOrders(tx: Queryable, chain: ChainId, wallet: string, now: number): Promise<number> {
  const r = await tx.query<{ n: string }>(
    `select count(*)::text as n from public.orders
      where chain_id = $1 and wallet = $2 and status in ('open', 'partially_filled', 'stale')
        and expires_at > to_timestamp($3)`,
    [chain, wallet, now],
  );
  return Number(r.rows[0]?.n ?? 0);
}

/** Highest `seq` of orders and of matches (0 when none): the engine continues after them. */
export async function loadSequences(tx: Queryable): Promise<{ lastOrderSeq: number; lastMatchSeq: number }> {
  const r = await tx.query<{ o: string; m: string }>(
    `select (select coalesce(max(seq), 0) from public.orders)::text as o,
            (select coalesce(max(seq), 0) from public.matches)::text as m`,
  );
  return { lastOrderSeq: Number(r.rows[0]!.o), lastMatchSeq: Number(r.rows[0]!.m) };
}

/**
 * Inserts an order with the engine's arrival sequence as `seq` (`overriding system
 * value`), so the database and the engine share one time priority and a restart
 * rebuilds the books in the original order.
 */
export async function insertOrder(tx: Queryable, o: OrderRow): Promise<void> {
  await tx.query(
    `insert into public.orders
       (id, seq, chain_id, asset, side, quantity, lot_size, limit_price, payment_asset, wallet, nonce,
        expires_at, intent_version, intent_signature, filled_quantity, status, cancel_reason, cancel_signature)
     overriding system value
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, to_timestamp($12), $13, $14, $15, $16, $17, $18)`,
    [
      o.id,
      o.seq,
      o.chain,
      o.asset,
      o.side,
      o.quantity.toString(),
      o.lotSize.toString(),
      o.limitPrice.toString(),
      o.paymentAsset,
      o.wallet,
      o.nonce,
      o.expiresAt,
      o.intentVersion,
      o.intentSignature,
      o.filledQuantity.toString(),
      o.status,
      o.cancelReason ?? null,
      o.cancelSignature ?? null,
    ],
  );
}

/**
 * Writes the engine's state of an order. A released or voided quantity lower than the
 * stored one is refused by the guard trigger (never silently kept), and any change of
 * them must come with its reversal rows (checked at commit).
 *
 * `closing` is written when the order leaves the book (cancelled, expired, stale); without
 * it the stored reason is kept, and a status that needs one is refused by the table check.
 */
export async function updateOrderState(
  tx: Queryable,
  id: string,
  filledQuantity: bigint,
  status: OrderStatus,
  counters: { releasedQuantity: bigint; voidedQuantity: bigint } = { releasedQuantity: 0n, voidedQuantity: 0n },
  closing?: OrderClosing,
): Promise<void> {
  const r = await tx.query<{ id: string }>(
    `update public.orders
        set filled_quantity = $2, status = $3,
            released_quantity = $4, voided_quantity = $5,
            cancel_reason = coalesce($6::public.cancel_reason, cancel_reason),
            cancel_signature = coalesce($7, cancel_signature)
      where id = $1 returning id::text`,
    [
      id,
      filledQuantity.toString(),
      status,
      counters.releasedQuantity.toString(),
      counters.voidedQuantity.toString(),
      closing?.reason ?? null,
      closing?.signature ?? null,
    ],
  );
  if (r.rows.length !== 1) throw new Error(`order ${id} not found`);
}

/** A settled match: its quantity is settled on both orders (checked at commit). */
export async function addSettledQuantity(tx: Queryable, orderIds: readonly string[], quantity: bigint): Promise<void> {
  for (const id of orderIds) {
    await tx.query(`update public.orders set settled_quantity = settled_quantity + $2 where id = $1`, [id, quantity.toString()]);
  }
}

/** The audit row of a failed match on one of its orders (append-only). */
export async function insertReversal(
  tx: Queryable,
  r: { matchId: string; orderId: string; kind: "released" | "voided"; fault: string; quantity: bigint; reason: string },
): Promise<void> {
  await tx.query(
    `insert into public.match_reversals (match_id, order_id, kind, fault, quantity, reason) values ($1, $2, $3, $4, $5, $6)`,
    [r.matchId, r.orderId, r.kind, r.fault, r.quantity.toString(), r.reason.slice(0, 1000)],
  );
}

/** Migrations the service writes through, each with what shows it is applied. */
export const REQUIRED_MIGRATIONS = [
  "20261120120000_match_reversals",
  "20261120130000_cancel_reasons",
  "20261122120000_listing_metadata",
] as const;

/** The required migrations that are not applied yet (empty when the schema is ready). */
export async function missingMigrations(tx: Queryable): Promise<string[]> {
  const r = await tx.query<{ match_reversals: boolean; cancel_reasons: boolean; listing_metadata: boolean }>(
    `select to_regclass('public.match_reversals') is not null as match_reversals,
            exists (select 1 from information_schema.columns
                     where table_schema = 'public' and table_name = 'orders' and column_name = 'cancel_reason') as cancel_reasons,
            exists (select 1 from information_schema.columns
                     where table_schema = 'public' and table_name = 'listings' and column_name = 'symbol') as listing_metadata`,
  );
  const row = r.rows[0];
  return REQUIRED_MIGRATIONS.filter((m) => row?.[m.slice(15) as "match_reversals" | "cancel_reasons" | "listing_metadata"] !== true);
}

// ---------------------------------------------------------------------------
// Matches
// ---------------------------------------------------------------------------

/**
 * Inserts a match with the engine's `sequence` as `seq`. `asset` is the listing's
 * stored spelling (foreign key). Status starts `pending`: nothing is settled here.
 */
export async function insertMatch(tx: Queryable, m: Match, asset: string): Promise<void> {
  await tx.query(
    `insert into public.matches
       (id, seq, chain_id, asset, buy_order, sell_order, maker_order, quantity, lot_size, price,
        payment_amount, expires_at)
     overriding system value
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, to_timestamp($12))`,
    [
      m.id,
      m.sequence,
      m.chain,
      asset,
      m.buyOrderId,
      m.sellOrderId,
      m.makerOrderId,
      m.quantity.toString(),
      m.lotSize.toString(),
      m.price.toString(),
      m.paymentAmount.toString(),
      m.expiresAt,
    ],
  );
}

export interface MatchRow {
  id: string;
  seq: number;
  chain: ChainId;
  asset: string;
  buyOrderId: string;
  sellOrderId: string;
  makerOrderId: string;
  quantity: bigint;
  lotSize: bigint;
  price: bigint;
  paymentAmount: bigint;
  expiresAt: number;
  status: string;
}

export async function loadMatches(tx: Queryable): Promise<MatchRow[]> {
  const r = await tx.query<{
    id: string;
    seq: string;
    chain_id: ChainId;
    asset: string;
    buy_order: string;
    sell_order: string;
    maker_order: string;
    quantity: string;
    lot_size: string;
    price: string;
    payment_amount: string;
    expires_at: string;
    status: string;
  }>(
    `select id::text, seq::text, chain_id, asset, buy_order::text, sell_order::text, maker_order::text,
            quantity::text, lot_size::text, price::text, payment_amount::text,
            extract(epoch from expires_at)::bigint::text as expires_at, status::text
       from public.matches
      -- qualified: a bare "seq" would sort the text output column
      order by public.matches.seq`,
  );
  return r.rows.map((m) => ({
    id: m.id,
    seq: Number(m.seq),
    chain: m.chain_id,
    asset: m.asset,
    buyOrderId: m.buy_order,
    sellOrderId: m.sell_order,
    makerOrderId: m.maker_order,
    quantity: BigInt(m.quantity),
    lotSize: BigInt(m.lot_size),
    price: BigInt(m.price),
    paymentAmount: BigInt(m.payment_amount),
    expiresAt: Number(m.expires_at),
    status: m.status,
  }));
}
