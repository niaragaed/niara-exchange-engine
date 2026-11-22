import type { ChainId } from "../chains.ts";
import type { Queryable } from "./database.ts";
import { ORDER_COLUMNS, toOrderRow, type OrderRow, type RawOrder } from "./repository.ts";

/**
 * Read-only queries behind the site's history endpoints (orders of a wallet, one order,
 * matches of a wallet, trades of a market). Run as service_role by the caller; nothing
 * here writes. Pages go newest first by `seq`, `before` being the last `seq` of the
 * previous page.
 */

export interface Page {
  /** 1..max rows. */
  limit: number;
  /** Only rows with a lower `seq` (the previous page's last). */
  before: number | null;
}

/** Timestamps are selected as epoch milliseconds (text), not parsed from Postgres's text format. */
export function isoFromMs(ms: string): string {
  return new Date(Number(ms)).toISOString();
}

export type StoredOrder = OrderRow & { createdAt: string };

function toStoredOrder(o: RawOrder & { created_at: string }): StoredOrder {
  return { ...toOrderRow(o), createdAt: isoFromMs(o.created_at) };
}

/** Orders of (chain, wallet), every status, newest first. `wallet` exactly as stored (admission's spelling). */
export async function listWalletOrders(tx: Queryable, chain: ChainId, wallet: string, page: Page): Promise<StoredOrder[]> {
  const r = await tx.query<RawOrder & { created_at: string }>(
    `select ${ORDER_COLUMNS}, (extract(epoch from created_at) * 1000)::bigint::text as created_at from public.orders
      where chain_id = $1 and wallet = $2 and ($3::bigint is null or public.orders.seq < $3::bigint)
      -- qualified: a bare "seq" would sort the text output column
      order by public.orders.seq desc
      limit $4`,
    [chain, wallet, page.before, page.limit],
  );
  return r.rows.map(toStoredOrder);
}

/** One order by id (any status), or null. */
export async function loadStoredOrder(tx: Queryable, id: string): Promise<StoredOrder | null> {
  const r = await tx.query<RawOrder & { created_at: string }>(
    `select ${ORDER_COLUMNS}, (extract(epoch from created_at) * 1000)::bigint::text as created_at from public.orders where id = $1`,
    [id],
  );
  return r.rows[0] ? toStoredOrder(r.rows[0]) : null;
}

export interface MatchHistoryRow {
  id: string;
  seq: number;
  chain: ChainId;
  /** As stored (the listing's spelling). */
  asset: string;
  paymentAsset: string;
  buyOrderId: string;
  sellOrderId: string;
  makerOrderId: string;
  buyer: string;
  seller: string;
  quantity: bigint;
  lotSize: bigint;
  price: bigint;
  paymentAmount: bigint;
  /** Unix seconds. */
  expiresAt: number;
  status: string;
  matchedAt: string;
  settlement: {
    status: string;
    attempts: number;
    txHash: string | null;
    error: string | null;
    /** When the settlement row last changed: the confirmation time once confirmed. */
    updatedAt: string;
  } | null;
}

const MATCH_SELECT = `
  select m.id::text, m.seq::text, m.chain_id, m.asset, b.payment_asset, m.buy_order::text, m.sell_order::text,
         m.maker_order::text, b.wallet as buyer, s.wallet as seller, m.quantity::text, m.lot_size::text,
         m.price::text, m.payment_amount::text, extract(epoch from m.expires_at)::bigint::text as expires_at,
         m.status::text, (extract(epoch from m.created_at) * 1000)::bigint::text as created_at, st.status::text as settlement_status, st.attempts, st.tx_hash,
         st.error, (extract(epoch from st.updated_at) * 1000)::bigint::text as settlement_updated_at
    from public.matches m
    join public.orders b on b.id = m.buy_order
    join public.orders s on s.id = m.sell_order
    left join public.settlements st on st.match_id = m.id`;

interface RawMatch {
  id: string;
  seq: string;
  chain_id: ChainId;
  asset: string;
  payment_asset: string;
  buy_order: string;
  sell_order: string;
  maker_order: string;
  buyer: string;
  seller: string;
  quantity: string;
  lot_size: string;
  price: string;
  payment_amount: string;
  expires_at: string;
  status: string;
  created_at: string;
  settlement_status: string | null;
  attempts: number | null;
  tx_hash: string | null;
  error: string | null;
  settlement_updated_at: string | null;
}

function toMatchHistory(m: RawMatch): MatchHistoryRow {
  return {
    id: m.id,
    seq: Number(m.seq),
    chain: m.chain_id,
    asset: m.asset,
    paymentAsset: m.payment_asset,
    buyOrderId: m.buy_order,
    sellOrderId: m.sell_order,
    makerOrderId: m.maker_order,
    buyer: m.buyer,
    seller: m.seller,
    quantity: BigInt(m.quantity),
    lotSize: BigInt(m.lot_size),
    price: BigInt(m.price),
    paymentAmount: BigInt(m.payment_amount),
    expiresAt: Number(m.expires_at),
    status: m.status,
    matchedAt: isoFromMs(m.created_at),
    settlement:
      m.settlement_status === null
        ? null
        : {
            status: m.settlement_status,
            attempts: m.attempts ?? 0,
            txHash: m.tx_hash,
            error: m.error,
            updatedAt: isoFromMs(m.settlement_updated_at!),
          },
  };
}

/** The matches of one order, oldest first. */
export async function listOrderMatches(tx: Queryable, orderId: string): Promise<MatchHistoryRow[]> {
  const r = await tx.query<RawMatch>(
    `${MATCH_SELECT}
      where m.buy_order = $1 or m.sell_order = $1
      order by m.seq`,
    [orderId],
  );
  return r.rows.map(toMatchHistory);
}

/** Matches where `wallet` is the buyer or the seller on `chain`, newest first. */
export async function listWalletMatches(tx: Queryable, chain: ChainId, wallet: string, page: Page): Promise<MatchHistoryRow[]> {
  const r = await tx.query<RawMatch>(
    `${MATCH_SELECT}
      where m.chain_id = $1 and (b.wallet = $2 or s.wallet = $2) and ($3::bigint is null or m.seq < $3::bigint)
      order by m.seq desc
      limit $4`,
    [chain, wallet, page.before, page.limit],
  );
  return r.rows.map(toMatchHistory);
}

export interface TradeRow {
  id: string;
  seq: number;
  quantity: bigint;
  lotSize: bigint;
  price: bigint;
  paymentAmount: bigint;
  takerSide: "buy" | "sell";
  matchedAt: string;
  settledAt: string;
  txHash: string;
}

/**
 * Settled matches of one market (confirmed on-chain), newest first: public trade data
 * only (no wallets, no order ids). `asset` as stored (the listing's spelling);
 * `sinceSecs` keeps trades matched at or after that unix time.
 */
export async function listTrades(
  tx: Queryable,
  chain: ChainId,
  asset: string,
  page: Page,
  sinceSecs: number | null,
): Promise<TradeRow[]> {
  const r = await tx.query<{
    id: string;
    seq: string;
    quantity: string;
    lot_size: string;
    price: string;
    payment_amount: string;
    taker_side: "buy" | "sell";
    matched_at: string;
    settled_at: string;
    tx_hash: string;
  }>(
    `select m.id::text, m.seq::text, m.quantity::text, m.lot_size::text, m.price::text, m.payment_amount::text,
            (case when m.maker_order = m.buy_order then 'sell' else 'buy' end) as taker_side,
            (extract(epoch from m.created_at) * 1000)::bigint::text as matched_at,
            (extract(epoch from st.updated_at) * 1000)::bigint::text as settled_at, st.tx_hash
       from public.matches m
       join public.settlements st on st.match_id = m.id and st.status = 'confirmed'
      where m.chain_id = $1 and m.asset = $2 and m.status = 'settled'
        and ($3::bigint is null or m.seq < $3::bigint)
        and ($4::bigint is null or m.created_at >= to_timestamp($4::bigint))
      order by m.seq desc
      limit $5`,
    [chain, asset, page.before, sinceSecs, page.limit],
  );
  return r.rows.map((t) => ({
    id: t.id,
    seq: Number(t.seq),
    quantity: BigInt(t.quantity),
    lotSize: BigInt(t.lot_size),
    price: BigInt(t.price),
    paymentAmount: BigInt(t.payment_amount),
    takerSide: t.taker_side,
    matchedAt: isoFromMs(t.matched_at),
    settledAt: isoFromMs(t.settled_at),
    txHash: t.tx_hash,
  }));
}
