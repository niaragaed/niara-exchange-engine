import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { insertOrder as insertOrderRow, loadOrder, missingMigrations } from "../../src/db/repository.ts";
import { applyMigration, resetData, startPglite, type TestDb } from "./pglite.ts";

/**
 * Migration 20261124120000_time_in_force on PGlite (Postgres 17, real migrations):
 * orders.time_in_force and the cancel reason ioc_unfilled. Labeled test values; nothing
 * is applied to any Supabase project.
 */

const CHAIN = "base-sepolia";
const EQUITY = "0x00000000000000000000000000000000000E0001";
const USDT = "0x00000000000000000000000000000000000D0001";
const ALICE = "0x00000000000000000000000000000000000A11CE";
const MIGRATION = "20261124120000_time_in_force.sql";

let t: TestDb;
let nonce = 0;

async function seedListing(): Promise<void> {
  await t.pglite.query(
    `insert into public.listings (chain_id, asset, issuer, asset_class, status, cashback_eligible, doc_hash, asset_decimals, lot_size)
     values ($1, $2, $3, 'equity', 'approved', true, repeat('ab', 32), 6, 100)`,
    [CHAIN, EQUITY, ALICE],
  );
}

/** A v2 buy order of 1,000 (lot 100) with `filled` matched, in `status`, with optional extra columns. */
async function insert(status: string, extra: Record<string, string | number | null> = {}, filled = 0): Promise<string> {
  nonce += 1;
  const values: Record<string, string | number | null> = { intent_version: 2, ...extra };
  const cols = Object.keys(values);
  const r = await t.pglite.query<{ id: string }>(
    `insert into public.orders (chain_id, asset, side, quantity, lot_size, limit_price, payment_asset, wallet, nonce,
       expires_at, intent_signature, filled_quantity, status${cols.map((c) => `, ${c}`).join("")})
     values ($1, $2, 'buy', 1000, 100, 10, $3, $4, $5, now() + interval '1 day', 'TEST-SIGNATURE', $6, $7
       ${cols.map((_, i) => `, $${8 + i}`).join("")})
     returning id::text`,
    [CHAIN, EQUITY, USDT, ALICE, nonce.toString(16).padStart(32, "0"), filled, status, ...Object.values(values)],
  );
  return r.rows[0]!.id;
}

describe("applying the migration", () => {
  beforeAll(async () => {
    t = await startPglite({ before: MIGRATION });
    await seedListing();
  });
  afterAll(async () => {
    await t.pglite.close();
  });

  it("is named as missing before, applies in ONE transaction, and makes existing orders GTC", async () => {
    expect(await missingMigrations(t.db)).toEqual(["20261124120000_time_in_force", "20261127120000_iceberg_orders"]);
    const old = await insert("open", { intent_version: 1 });
    // As `supabase db push` runs a migration file: inside one transaction.
    await t.pglite.exec("begin");
    await applyMigration(t.pglite, MIGRATION);
    await t.pglite.exec("commit");
    expect(await missingMigrations(t.db)).toEqual(["20261127120000_iceberg_orders"]);
    const r = await t.pglite.query<{ tif: string }>("select time_in_force::text as tif from public.orders where id = $1", [old]);
    expect(r.rows[0]!.tif).toBe("gtc");
  });
});

describe("time_in_force and ioc_unfilled", () => {
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

  it("an IOC never rests: open or partially filled IOC rows are refused", async () => {
    await expect(insert("open", { time_in_force: "ioc" })).rejects.toThrow(/orders_ioc_never_rests_check/);
    await expect(insert("partially_filled", { time_in_force: "ioc" }, 100)).rejects.toThrow(/orders_ioc_never_rests_check/);
    await insert("filled", { time_in_force: "ioc" }, 1000);
    await insert("cancelled", { time_in_force: "ioc", cancel_reason: "ioc_unfilled" }, 300);
  });

  it("ioc_unfilled is the reason of IOC orders only, and a v1 intent is GTC", async () => {
    await expect(insert("cancelled", { cancel_reason: "ioc_unfilled" })).rejects.toThrow(/orders_ioc_unfilled_check/);
    await expect(insert("expired", { time_in_force: "ioc", cancel_reason: "ioc_unfilled" })).rejects.toThrow(/orders_cancel_reason_check/);
    await expect(insert("filled", { time_in_force: "ioc", intent_version: 1 }, 1000)).rejects.toThrow(/orders_time_in_force_version_check/);
    await insert("open", { intent_version: 1 }); // v1 GTC: fine
  });

  it("time_in_force is a signed field: immutable", async () => {
    const id = await insert("filled", { time_in_force: "ioc" }, 1000);
    await expect(t.pglite.query("update public.orders set time_in_force = 'gtc' where id = $1", [id])).rejects.toThrow(/immutable/);
  });

  it("round-trips through the repository", async () => {
    const row = {
      id: "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b",
      seq: 1,
      chain: CHAIN as "base-sepolia",
      asset: EQUITY,
      side: "buy" as const,
      quantity: 1000n,
      lotSize: 100n,
      limitPrice: 10n,
      paymentAsset: USDT,
      wallet: ALICE,
      nonce: "bb000000000000000000000000000001",
      expiresAt: Math.floor(Date.now() / 1000) + 86_400,
      intentVersion: 2,
      intentSignature: "TEST-SIGNATURE",
      filledQuantity: 300n,
      status: "cancelled" as const,
      cancelReason: "ioc_unfilled" as const,
      timeInForce: "IOC" as const,
    };
    await t.db.transaction((tx) => insertOrderRow(tx, row));
    expect(await loadOrder(t.db, row.id)).toMatchObject({ timeInForce: "IOC", cancelReason: "ioc_unfilled", status: "cancelled" });
  });
});
