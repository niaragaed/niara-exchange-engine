import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { insertOrder as insertOrderRow, loadOrder, loadSequences, missingMigrations, updateOrderState } from "../../src/db/repository.ts";
import { applyMigration, resetData, startPglite, type TestDb } from "./pglite.ts";

/**
 * Migration 20261127120000_iceberg_orders on PGlite (Postgres 17, real migrations):
 * display_quantity, visible_quantity, priority_seq, book_quantity, their checks, the
 * guard, and what anon/authenticated can read. Labeled test values; nothing is applied
 * to any Supabase project.
 */

const CHAIN = "base-sepolia";
const EQUITY = "0x00000000000000000000000000000000000E0001";
const USDT = "0x00000000000000000000000000000000000D0001";
const ALICE = "0x00000000000000000000000000000000000A11CE";
const MIGRATION = "20261127120000_iceberg_orders.sql";
// Distinctive hidden quantity: 9,137 lots of 100, of which 2 lots show.
const TOTAL = 913_700;
const DISPLAY = 200;

let t: TestDb;
let nonce = 0;

async function seedListing(): Promise<void> {
  await t.pglite.query(
    `insert into public.listings (chain_id, asset, issuer, asset_class, status, cashback_eligible, doc_hash, asset_decimals, lot_size)
     values ($1, $2, $3, 'equity', 'approved', true, repeat('ab', 32), 6, 100)`,
    [CHAIN, EQUITY, ALICE],
  );
}

/** A sell order at price 10 (lot 100) with optional extra columns; v3 iceberg columns by default when `iceberg`. */
async function insert(
  status: string,
  extra: Record<string, string | number | null> = {},
  options: { quantity?: number; filled?: number; iceberg?: boolean } = {},
): Promise<string> {
  nonce += 1;
  const values: Record<string, string | number | null> = options.iceberg
    ? { intent_version: 3, time_in_force: "gtc", display_quantity: DISPLAY, visible_quantity: DISPLAY, ...extra }
    : { intent_version: 2, ...extra };
  const cols = Object.keys(values);
  const r = await t.pglite.query<{ id: string }>(
    `insert into public.orders (chain_id, asset, side, quantity, lot_size, limit_price, payment_asset, wallet, nonce,
       expires_at, intent_signature, filled_quantity, status${cols.map((c) => `, ${c}`).join("")})
     values ($1, $2, 'sell', $3, 100, 10, $4, $5, $6, now() + interval '1 day', 'TEST-SIGNATURE', $7, $8
       ${cols.map((_, i) => `, $${9 + i}`).join("")})
     returning id::text`,
    [CHAIN, EQUITY, options.quantity ?? TOTAL, USDT, ALICE, nonce.toString(16).padStart(32, "0"), options.filled ?? 0, status, ...Object.values(values)],
  );
  return r.rows[0]!.id;
}

async function asRole<T>(role: string, fn: () => Promise<T>): Promise<T> {
  await t.pglite.exec(`set role ${role}`);
  try {
    return await fn();
  } finally {
    await t.pglite.exec("reset role");
  }
}

describe("applying the migration", () => {
  beforeAll(async () => {
    t = await startPglite({ before: MIGRATION });
    await seedListing();
  });
  afterAll(async () => {
    await t.pglite.close();
  });

  it("is named as missing before, applies in ONE transaction, and leaves existing orders shown whole", async () => {
    expect(await missingMigrations(t.db)).toEqual(["20261127120000_iceberg_orders"]);
    const old = await insert("partially_filled", {}, { quantity: 1000, filled: 300 });
    const before = await t.pglite.query("select side, price::text, quantity::text, orders::int from public.order_book");
    await t.pglite.exec("begin");
    await applyMigration(t.pglite, MIGRATION);
    await t.pglite.exec("commit");
    expect(await missingMigrations(t.db)).toEqual([]);
    const r = await t.pglite.query<Record<string, string | null>>(
      "select display_quantity::text as d, visible_quantity::text as v, priority_seq::text as p, book_quantity::text as b from public.orders where id = $1",
      [old],
    );
    expect(r.rows[0]).toEqual({ d: null, v: null, p: null, b: "700" });
    // The public book reads the same as before the migration.
    expect((await t.pglite.query("select side, price::text, quantity::text, orders::int from public.order_book")).rows).toEqual(before.rows);
  });
});

describe("iceberg columns", () => {
  beforeAll(async () => {
    t = await startPglite();
  });
  afterAll(async () => {
    await t.pglite.close();
  });
  beforeEach(async () => {
    await resetData(t.pglite);
    await seedListing();
  });

  it("display_quantity: only on v3 GTC intents, whole lots, at least 1, below the quantity", async () => {
    await insert("open", {}, { iceberg: true });
    await expect(insert("open", { intent_version: 2 }, { iceberg: true })).rejects.toThrow(/orders_display_quantity_check/);
    await expect(insert("open", { intent_version: 1, time_in_force: "gtc" }, { iceberg: true })).rejects.toThrow(/orders_display_quantity_check/);
    await expect(insert("cancelled", { time_in_force: "ioc", cancel_reason: "ioc_unfilled" }, { iceberg: true })).rejects.toThrow(
      /orders_display_quantity_check/,
    );
    await expect(insert("open", { display_quantity: TOTAL, visible_quantity: 100 }, { iceberg: true })).rejects.toThrow(/orders_display_quantity_check/);
    await expect(insert("open", { display_quantity: 150, visible_quantity: 100 }, { iceberg: true })).rejects.toThrow(/orders_display_quantity_check/);
    await expect(insert("open", { display_quantity: 0, visible_quantity: 0 }, { iceberg: true })).rejects.toThrow(/orders_display_quantity_check/);
  });

  it("a v3 intent is an iceberg; v1/v2 orders have no slice", async () => {
    await expect(insert("open", { intent_version: 3 })).rejects.toThrow(/orders_v3_iceberg_check/);
    await expect(insert("open", { visible_quantity: 100 })).rejects.toThrow(/orders_visible_quantity_check/);
  });

  it("visible_quantity: required for icebergs, at most the display, positive and within the remainder while resting", async () => {
    await expect(insert("open", { visible_quantity: null }, { iceberg: true })).rejects.toThrow(/orders_visible_quantity_check/);
    await expect(insert("open", { visible_quantity: 300 }, { iceberg: true })).rejects.toThrow(/orders_visible_quantity_check/);
    await expect(insert("open", { visible_quantity: 0 }, { iceberg: true })).rejects.toThrow(/orders_visible_quantity_check/);
    // Remainder 100 (of 1000, 900 filled): a slice of 200 is more than is left.
    await expect(insert("partially_filled", {}, { iceberg: true, quantity: 1000, filled: 900 })).rejects.toThrow(/orders_visible_quantity_check/);
    await insert("partially_filled", { visible_quantity: 100 }, { iceberg: true, quantity: 1000, filled: 900 });
    await insert("filled", { visible_quantity: 0 }, { iceberg: true, quantity: 1000, filled: 1000 }); // out of the book
  });

  it("priority_seq: icebergs only, after the order's seq, unique, and it only moves later", async () => {
    await expect(insert("open", { priority_seq: 1_000_000 })).rejects.toThrow(/orders_priority_seq_check/);
    const id = await insert("open", {}, { iceberg: true });
    const seq = Number((await t.pglite.query<{ seq: string }>("select seq::text from public.orders where id = $1", [id])).rows[0]!.seq);
    await expect(t.pglite.query("update public.orders set priority_seq = $2 where id = $1", [id, seq])).rejects.toThrow(/orders_priority_seq_check/);
    await t.pglite.query("update public.orders set priority_seq = $2 where id = $1", [id, seq + 10]);
    await expect(t.pglite.query("update public.orders set priority_seq = $2 where id = $1", [id, seq + 5])).rejects.toThrow(/only moves later/);
    await expect(t.pglite.query("update public.orders set priority_seq = null where id = $1", [id])).rejects.toThrow(/only moves later/);
    const other = await insert("open", {}, { iceberg: true });
    await expect(t.pglite.query("update public.orders set priority_seq = $2 where id = $1", [other, seq + 10])).rejects.toThrow(
      /orders_priority_seq_key/,
    );
    // The engine continues after the highest sequence, priority_seq included.
    expect((await loadSequences(t.db)).lastOrderSeq).toBe(seq + 10);
  });

  it("display_quantity is a signed field: immutable; the slice changes", async () => {
    const id = await insert("open", {}, { iceberg: true });
    await expect(t.pglite.query("update public.orders set display_quantity = 300, visible_quantity = 300 where id = $1", [id])).rejects.toThrow(
      /immutable/,
    );
    await t.pglite.query("update public.orders set visible_quantity = 100, filled_quantity = 100, status = 'partially_filled' where id = $1", [id]);
  });

  it("round-trips through the repository, slice and priority included", async () => {
    const row = {
      id: "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4c",
      seq: 1,
      chain: CHAIN as "base-sepolia",
      asset: EQUITY,
      side: "sell" as const,
      quantity: 1000n,
      lotSize: 100n,
      limitPrice: 10n,
      paymentAsset: USDT,
      wallet: ALICE,
      nonce: "cc000000000000000000000000000001",
      expiresAt: Math.floor(Date.now() / 1000) + 86_400,
      intentVersion: 3,
      intentSignature: "TEST-SIGNATURE",
      filledQuantity: 0n,
      status: "open" as const,
      timeInForce: "GTC" as const,
      displayQuantity: 300n,
      visibleQuantity: 300n,
    };
    await t.db.transaction((tx) => insertOrderRow(tx, row));
    expect(await loadOrder(t.db, row.id)).toMatchObject({ displayQuantity: 300n, visibleQuantity: 300n, prioritySeq: null });
    await t.db.transaction((tx) =>
      updateOrderState(tx, row.id, 300n, "partially_filled", { releasedQuantity: 0n, voidedQuantity: 0n, seq: 1, prioritySeq: 7, visibleQuantity: 300n }),
    );
    expect(await loadOrder(t.db, row.id)).toMatchObject({ filledQuantity: 300n, visibleQuantity: 300n, prioritySeq: 7 });
    // A priority equal to the seq is not a refresh: nothing is written.
    await t.db.transaction((tx) =>
      updateOrderState(tx, row.id, 400n, "partially_filled", { releasedQuantity: 0n, voidedQuantity: 0n, seq: 1, prioritySeq: 1, visibleQuantity: 200n }),
    );
    expect(await loadOrder(t.db, row.id)).toMatchObject({ visibleQuantity: 200n, prioritySeq: 7 });
  });

  for (const role of ["anon", "authenticated"]) {
    it(`${role}: the book and the table show the visible slice only, never the hidden quantity`, async () => {
      await insert("open", {}, { iceberg: true }); // 9,137 lots, 2 shown
      await insert("open", {}, { quantity: 300 }); // a plain order at the same price
      await asRole(role, async () => {
        const book = await t.pglite.query("select side, price::text, quantity::text, orders::int from public.order_book");
        expect(book.rows).toEqual([{ side: "sell", price: "10", quantity: "500", orders: 2 }]);
        const rows = await t.pglite.query<{ b: string }>("select book_quantity::text as b from public.orders order by book_quantity");
        expect(rows.rows.map((r) => r.b)).toEqual(["200", "300"]);
        for (const column of ["quantity", "filled_quantity", "released_quantity", "voided_quantity", "display_quantity", "visible_quantity", "priority_seq", "*"]) {
          await expect(t.pglite.query(`select ${column} from public.orders`), column).rejects.toThrow(/permission denied/);
        }
        // Still readable: the price-level columns.
        await t.pglite.query("select chain_id, asset, side, limit_price, lot_size, book_quantity, status, expires_at from public.orders");
      });
    });
  }
});
