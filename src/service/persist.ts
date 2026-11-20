import type { Queryable } from "../db/database.ts";
import { insertMatch, insertOrder, insertReversal, updateOrderState } from "../db/repository.ts";
import { setMatchStatus, writeSettlement } from "../db/settlements.ts";
import type { EngineEvent, MatchFault, MatchingEngine, OrderView, Reversal } from "../engine/engine.ts";
import type { Match } from "../engine/types.ts";
import type { Catalog } from "./catalog.ts";

/**
 * Writes what the engine just did to the database, inside the caller's transaction
 * (run as service_role). The engine is the source of the new state: every order an
 * event touched is written with its state as the engine now holds it.
 *
 * If a write fails, the transaction rolls back and the engine is ahead of the database:
 * the caller must stop the process, and the restart rebuilds the engine from the
 * database (`rebuild.ts`).
 */

export class PersistError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PersistError";
  }
}

/** The signed fields the engine does not keep. */
export interface IntentRecord {
  nonce: string;
  intentVersion: number;
  intentSignature: string;
}

function dbAssetOf(catalog: Catalog, o: { chain: OrderView["chain"]; asset: string }): string {
  const asset = catalog.dbAsset(o.chain, o.asset);
  if (asset === undefined) throw new PersistError(`no listing for ${o.chain}/${o.asset}`);
  return asset;
}

/** Ids of the orders an event list changed, in first-seen order. */
export function touchedOrders(events: readonly EngineEvent[]): string[] {
  const ids = new Set<string>();
  for (const e of events) {
    if (e.type === "match") {
      ids.add(e.match.buyOrderId);
      ids.add(e.match.sellOrderId);
    } else if (e.type !== "order_rejected") {
      ids.add(e.orderId);
    }
  }
  return [...ids];
}

/** An accepted order: insert it (final state), its matches, then the other orders touched. */
export async function persistPlacement(
  tx: Queryable,
  engine: MatchingEngine,
  catalog: Catalog,
  placed: { order: OrderView; matches: readonly Match[]; events: readonly EngineEvent[] },
  record: IntentRecord,
): Promise<void> {
  const o = placed.order;
  await insertOrder(tx, {
    id: o.id,
    seq: o.seq,
    chain: o.chain,
    asset: dbAssetOf(catalog, o),
    side: o.side,
    quantity: o.quantity,
    lotSize: o.lotSize,
    limitPrice: o.limitPrice,
    paymentAsset: o.paymentAsset,
    wallet: o.wallet,
    nonce: record.nonce,
    expiresAt: o.expiresAt,
    intentVersion: record.intentVersion,
    intentSignature: record.intentSignature,
    filledQuantity: o.filledQuantity,
    status: o.status,
  });
  for (const m of placed.matches) await insertMatch(tx, m, dbAssetOf(catalog, m));
  // The new order is already written in its final state.
  await persistEvents(tx, engine, placed.events, new Set([o.id]));
}

/** Writes the current engine state of every order `events` touched (cancel, expiry, stale). */
export async function persistEvents(
  tx: Queryable,
  engine: MatchingEngine,
  events: readonly EngineEvent[],
  skip: ReadonlySet<string> = new Set(),
): Promise<void> {
  for (const id of touchedOrders(events)) {
    if (skip.has(id)) continue;
    const o = engine.getOrder(id);
    if (!o) throw new PersistError(`engine has no order ${id}`);
    await updateOrderState(tx, id, o.filledQuantity, o.status, o);
  }
}

/**
 * A match failed after both orders were filled (`MatchingEngine.reverse` already ran):
 * in the caller's transaction, the settlement and the match become `failed`, each order
 * gets its audit row (released or voided), the orders their new state, and any match
 * the re-entered order made is inserted. The deferred checks of migration
 * 20261120120000 verify at commit that counters and rows agree.
 */
export async function persistReversal(
  tx: Queryable,
  engine: MatchingEngine,
  catalog: Catalog,
  failed: { match: Match; fault: MatchFault; reason: string; attempts: number },
  result: { reversals: readonly Reversal[]; events: readonly EngineEvent[]; matches: readonly Match[] },
): Promise<void> {
  const { match } = failed;
  await writeSettlement(tx, {
    matchId: match.id,
    chain: match.chain,
    status: "failed",
    attempts: failed.attempts,
    txHash: null,
    error: failed.reason,
  });
  await setMatchStatus(tx, match.id, "failed");
  for (const r of result.reversals) {
    await insertReversal(tx, { matchId: match.id, orderId: r.orderId, kind: r.kind, fault: failed.fault, quantity: r.quantity, reason: failed.reason });
  }
  for (const m of result.matches) await insertMatch(tx, m, dbAssetOf(catalog, m));
  await persistEvents(tx, engine, result.events);
}
