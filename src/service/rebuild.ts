import type { Database } from "../db/database.ts";
import { asServiceRole, loadChains, loadListings, loadOpenOrders, loadSequences } from "../db/repository.ts";
import { EngineInvariantError, MatchingEngine, type EngineOptions, type RestoredOrder } from "../engine/engine.ts";
import { buildCatalog, canonicalAddress, type Catalog } from "./catalog.ts";

/**
 * Restart: builds a fresh engine from the database. Markets come from `chains` and
 * `listings`; the books from every non-terminal order, in their original `seq`, with
 * their fills; the next order and match sequences continue after the highest stored.
 * One transaction, so the snapshot is consistent.
 */
export async function rebuildEngine(
  db: Database,
  options: EngineOptions,
): Promise<{ engine: MatchingEngine; catalog: Catalog }> {
  const snapshot = await asServiceRole(db, async (tx) => ({
    chains: await loadChains(tx),
    listings: await loadListings(tx),
    open: await loadOpenOrders(tx),
    sequences: await loadSequences(tx),
  }));
  const catalog = buildCatalog(snapshot.chains, snapshot.listings);
  const engine = new MatchingEngine(options);
  for (const m of catalog.markets) engine.upsertMarket(m);

  const orders: RestoredOrder[] = snapshot.open.map((r) => {
    const asset = canonicalAddress(r.chain, r.asset);
    const paymentAsset = canonicalAddress(r.chain, r.paymentAsset);
    if (asset === null || paymentAsset === null || r.status === "cancelled" || r.status === "expired") {
      throw new EngineInvariantError(`order ${r.id} cannot be restored`);
    }
    return {
      id: r.id,
      chain: r.chain,
      asset,
      paymentAsset,
      wallet: r.wallet,
      side: r.side,
      quantity: r.quantity,
      limitPrice: r.limitPrice,
      lotSize: r.lotSize,
      expiresAt: r.expiresAt,
      seq: r.seq,
      filledQuantity: r.filledQuantity,
      releasedQuantity: r.releasedQuantity ?? 0n,
      voidedQuantity: r.voidedQuantity ?? 0n,
      status: r.status,
    };
  });
  engine.restore({
    orders,
    lastOrderSeq: snapshot.sequences.lastOrderSeq,
    lastMatchSeq: snapshot.sequences.lastMatchSeq,
  });
  return { engine, catalog };
}
