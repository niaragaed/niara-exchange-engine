import type { ChainId } from "../chains.ts";
import type { Match, Side } from "../engine/types.ts";
import type { Queryable } from "./database.ts";

/**
 * Settlement worker reads and writes (run as service_role by the caller). Settlement
 * rows: one per match (`settlements.match_id` unique), updated in place across
 * attempts.
 *
 *   pending    created, or waiting for a retry after a transient failure
 *   submitted  handed to the chain adapter for this attempt
 *   confirmed  settled on-chain (tx_hash set)
 *   failed     will not be settled (error set)
 */

export type MatchStatus = "pending" | "settling" | "settled" | "failed";

export interface MatchToSettle {
  match: Match;
  status: MatchStatus;
  attempts: number;
}

/** The oldest (lowest seq) match still to settle on one of `chains`, with its parties. */
export async function nextMatchToSettle(tx: Queryable, chains: readonly ChainId[]): Promise<MatchToSettle | null> {
  if (chains.length === 0) return null;
  const r = await tx.query<{
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
    maker_side: Side;
    quantity: string;
    lot_size: string;
    price: string;
    payment_amount: string;
    expires_at: string;
    status: MatchStatus;
    attempts: number | null;
  }>(
    `select m.id::text, m.seq::text, m.chain_id, m.asset, b.payment_asset, m.buy_order::text, m.sell_order::text,
            m.maker_order::text, b.wallet as buyer, s.wallet as seller,
            (case when m.maker_order = m.buy_order then 'buy' else 'sell' end) as maker_side,
            m.quantity::text, m.lot_size::text, m.price::text, m.payment_amount::text,
            extract(epoch from m.expires_at)::bigint::text as expires_at, m.status::text, st.attempts
       from public.matches m
       join public.orders b on b.id = m.buy_order
       join public.orders s on s.id = m.sell_order
       left join public.settlements st on st.match_id = m.id
      where m.status in ('pending', 'settling') and m.chain_id = any($1)
      order by m.seq
      limit 1`,
    [chains],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    status: row.status,
    attempts: row.attempts ?? 0,
    match: {
      id: row.id,
      sequence: Number(row.seq),
      chain: row.chain_id,
      asset: row.asset,
      paymentAsset: row.payment_asset,
      buyOrderId: row.buy_order,
      sellOrderId: row.sell_order,
      buyer: row.buyer,
      seller: row.seller,
      makerOrderId: row.maker_order,
      takerSide: row.maker_side === "buy" ? "sell" : "buy",
      quantity: BigInt(row.quantity),
      lotSize: BigInt(row.lot_size),
      price: BigInt(row.price),
      paymentAmount: BigInt(row.payment_amount),
      expiresAt: Number(row.expires_at),
    },
  };
}

export async function setMatchStatus(tx: Queryable, matchId: string, status: MatchStatus): Promise<void> {
  const r = await tx.query<{ id: string }>(
    `update public.matches set status = $2 where id = $1 and status is distinct from $2 returning id::text`,
    [matchId, status],
  );
  if (r.rows.length === 0) {
    const cur = await tx.query<{ status: string }>(`select status::text from public.matches where id = $1`, [matchId]);
    if (cur.rows[0]?.status !== status) throw new Error(`match ${matchId} not found`);
  }
}

export type SettlementStatus = "pending" | "submitted" | "confirmed" | "failed";

export async function writeSettlement(
  tx: Queryable,
  s: { matchId: string; chain: ChainId; status: SettlementStatus; attempts: number; txHash: string | null; error: string | null },
): Promise<void> {
  await tx.query(
    `insert into public.settlements (match_id, chain_id, status, attempts, tx_hash, error)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (match_id) do update set
       status = excluded.status, attempts = excluded.attempts, tx_hash = excluded.tx_hash, error = excluded.error`,
    [s.matchId, s.chain, s.status, s.attempts, s.txHash, s.error],
  );
}

export interface SettlementRow {
  matchId: string;
  matchStatus: MatchStatus;
  status: SettlementStatus | null;
  attempts: number;
  txHash: string | null;
  error: string | null;
}

/** A match's settlement state (public fields only: no wallets). */
export async function loadSettlement(tx: Queryable, matchId: string): Promise<SettlementRow | null> {
  const r = await tx.query<{
    id: string;
    match_status: MatchStatus;
    status: SettlementStatus | null;
    attempts: number | null;
    tx_hash: string | null;
    error: string | null;
  }>(
    `select m.id::text, m.status::text as match_status, st.status::text, st.attempts, st.tx_hash, st.error
       from public.matches m left join public.settlements st on st.match_id = m.id
      where m.id = $1`,
    [matchId],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    matchId: row.id,
    matchStatus: row.match_status,
    status: row.status,
    attempts: row.attempts ?? 0,
    txHash: row.tx_hash,
    error: row.error,
  };
}
