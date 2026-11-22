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

export type StoredOrder = OrderRow & { createdAt: string };

function toStoredOrder(o: RawOrder & { created_at: string }): StoredOrder {
  return { ...toOrderRow(o), createdAt: new Date(o.created_at).toISOString() };
}

/** Orders of (chain, wallet), every status, newest first. `wallet` exactly as stored (admission's spelling). */
export async function listWalletOrders(tx: Queryable, chain: ChainId, wallet: string, page: Page): Promise<StoredOrder[]> {
  const r = await tx.query<RawOrder & { created_at: string }>(
    `select ${ORDER_COLUMNS}, created_at::text from public.orders
      where chain_id = $1 and wallet = $2 and ($3::bigint is null or public.orders.seq < $3::bigint)
      -- qualified: a bare "seq" would sort the text output column
      order by public.orders.seq desc
      limit $4`,
    [chain, wallet, page.before, page.limit],
  );
  return r.rows.map(toStoredOrder);
}
