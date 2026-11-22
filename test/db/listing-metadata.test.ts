import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomMatchId } from "../../src/engine/random-id.ts";
import { OrderService, SchemaNotReadyError } from "../../src/service/order-service.ts";
import { applyMigration, startPglite, type TestDb } from "./pglite.ts";

/**
 * Migration 20261122120000_listing_metadata on PGlite (Postgres 17, real migrations):
 * listings.symbol and listings.name. Patterned test addresses and labeled test values;
 * nothing is applied to any Supabase project.
 */

const MIGRATION = "20261122120000_listing_metadata.sql";
const EQUITY = "0x00000000000000000000000000000000000E0001";
const BOND = "0x00000000000000000000000000000000000B0001";

let t: TestDb;

beforeAll(async () => {
  t = await startPglite({ before: MIGRATION });
});

afterAll(async () => {
  await t.pglite.close();
});

describe("listing metadata migration", () => {
  it("before it is applied, the order service refuses to start and names it", async () => {
    const err = await OrderService.start({
      db: t.db,
      clock: () => 1_800_000_000,
      newOrderId: randomUUID,
      newMatchId: randomMatchId,
      settlementMarginSecs: 60,
      maxOpenOrdersPerWallet: 3,
      onFatal: () => undefined,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SchemaNotReadyError);
    expect((err as SchemaNotReadyError).missing).toEqual(["20261122120000_listing_metadata"]);
  });

  it("applies over existing listings (null metadata), and checks what is stored", async () => {
    await t.pglite.query(
      `insert into public.listings (chain_id, asset, issuer, asset_class, status, cashback_eligible, doc_hash, asset_decimals, lot_size)
       values ('base-sepolia', $1, 'TEST-ISSUER', 'equity', 'approved', true, repeat('ab', 32), 18, 1),
              ('base-sepolia', $2, 'TEST-ISSUER', 'fixed_income', 'approved', true, repeat('cd', 32), 18, 1)`,
      [EQUITY, BOND],
    );
    await applyMigration(t.pglite, MIGRATION);
    const before = await t.pglite.query(`select symbol, name from public.listings order by asset`);
    expect(before.rows).toEqual([
      { symbol: null, name: null },
      { symbol: null, name: null },
    ]);

    const set = (symbol: string | null, name: string | null) =>
      t.pglite.query(`update public.listings set symbol = $2, name = $3 where asset = $1`, [EQUITY, symbol, name]);
    await set("tEQTY", "Test Demo Equity");
    await set(null, null);
    await set("x".repeat(32), "n".repeat(128));
    for (const [symbol, name] of [
      ["", null],
      [" tEQTY", null],
      ["tEQTY ", null],
      ["t\u0007EQTY", null],
      ["x".repeat(33), null],
      [null, ""],
      [null, "n".repeat(129)],
      [null, "Line\nBreak"],
    ] as const) {
      await expect(set(symbol, name), JSON.stringify([symbol, name])).rejects.toThrow(/listings_(symbol|name)_check/);
    }
  });

  it("is readable by anon on public listings only, through the existing grant and policy", async () => {
    await t.pglite.query(`update public.listings set symbol = 'tEQTY', name = 'Test Demo Equity' where asset = $1`, [EQUITY]);
    await t.pglite.query(`update public.listings set symbol = 'tBOND', name = 'Test Demo Bond' where asset = $1`, [BOND]);
    await t.pglite.exec("begin; set local role anon;");
    try {
      const r = await t.pglite.query(`select asset, symbol, name from public.listings order by asset`);
      // tBOND (fixed income) is hidden by the row policy, as before.
      expect(r.rows).toEqual([{ asset: EQUITY, symbol: "tEQTY", name: "Test Demo Equity" }]);
      await expect(t.pglite.query(`update public.listings set symbol = 'X' where asset = $1`, [EQUITY])).rejects.toThrow(/permission denied/);
    } finally {
      await t.pglite.exec("rollback;");
    }
  });
});
