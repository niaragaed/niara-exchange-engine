import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Queryable } from "../../src/db/database.ts";
import { applyMigration, resetData, startPglite, type TestDb } from "./pglite.ts";

/**
 * Migration 20261120120000_match_reversals on PGlite (Postgres 17, real migrations).
 * Labeled test values; nothing is applied to any Supabase project.
 */

const CHAIN = "base-sepolia";
const EQUITY = "0x00000000000000000000000000000000000E0001";
const USDT = "0x00000000000000000000000000000000000D0001";
const ALICE = "0x00000000000000000000000000000000000A11CE";
const BOB = "0x0000000000000000000000000000000000000B0B";
const MIGRATION = "20261120120000_match_reversals.sql";

let t: TestDb;
let nonce = 0;

async function seedListing(q: Queryable): Promise<void> {
  await q.query(
    `insert into public.listings (chain_id, asset, issuer, asset_class, status, cashback_eligible, doc_hash, asset_decimals, lot_size)
     values ($1, $2, $3, 'equity', 'approved', true, repeat('ab', 32), 6, 100)`,
    [CHAIN, EQUITY, ALICE],
  );
}

/** A buy (Alice) and a sell (Bob) of 1,000, matched for `matched`, as the service stores them. */
async function seedMatch(q: Queryable, matched = 1000n): Promise<{ buy: string; sell: string; match: string }> {
  const order = async (wallet: string, side: "buy" | "sell") => {
    nonce += 1;
    const r = await q.query<{ id: string }>(
      `insert into public.orders (chain_id, asset, side, quantity, lot_size, limit_price, payment_asset, wallet, nonce,
         expires_at, intent_version, intent_signature, filled_quantity, status)
       values ($1, $2, $3, 1000, 100, 10, $4, $5, $6, now() + interval '1 day', 1, 'TEST-SIGNATURE', $7, $8)
       returning id::text`,
      [CHAIN, EQUITY, side, USDT, wallet, nonce.toString(16).padStart(32, "0"), matched.toString(), matched === 1000n ? "filled" : "partially_filled"],
    );
    return r.rows[0]!.id;
  };
  const buy = await order(ALICE, "buy");
  const sell = await order(BOB, "sell");
  const match = randomUUID();
  await q.query(
    `insert into public.matches (id, chain_id, asset, buy_order, sell_order, maker_order, quantity, lot_size, price, payment_amount, expires_at)
     values ($1, $2, $3, $4, $5, $5, $6, 100, 10, $7, (select expires_at from public.orders where id = $4))`,
    [match, CHAIN, EQUITY, buy, sell, matched.toString(), ((matched / 100n) * 10n).toString()],
  );
  return { buy, sell, match };
}

/** One service_role transaction; the deferred checks run at its commit. */
function asService<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
  return t.db.transaction(async (tx) => {
    await tx.query("set local role service_role");
    return fn(tx);
  });
}

async function order(id: string) {
  const r = await t.pglite.query<{ status: string; filled: string; settled: string; released: string; voided: string }>(
    `select status::text, filled_quantity::text as filled, settled_quantity::text as settled,
            released_quantity::text as released, voided_quantity::text as voided from public.orders where id = $1`,
    [id],
  );
  return r.rows[0];
}

/** The seller defaulted: its quantity is voided (stale), the buyer's is released (open again). */
async function failSellerDefault(tx: Queryable, m: { buy: string; sell: string; match: string }) {
  await tx.query("update public.matches set status = 'failed' where id = $1", [m.match]);
  await tx.query(
    `insert into public.match_reversals (match_id, order_id, kind, fault, quantity, reason) values
     ($1, $2, 'released', 'seller', 1000, 'TEST: seller delegation revoked'),
     ($1, $3, 'voided', 'seller', 1000, 'TEST: seller delegation revoked')`,
    [m.match, m.buy, m.sell],
  );
  await tx.query("update public.orders set released_quantity = 1000, status = 'open' where id = $1", [m.buy]);
  await tx.query("update public.orders set voided_quantity = 1000, status = 'stale', cancel_reason = 'stale' where id = $1", [m.sell]);
}

beforeAll(async () => {
  t = await startPglite();
});

afterAll(async () => {
  await t.pglite.close();
});

beforeEach(async () => {
  await resetData(t.pglite);
  await seedListing(t.db);
});

describe("failed match after both orders were filled", () => {
  it("returns the innocent side's quantity to its order and voids the defaulter's, with one audit row each", async () => {
    const m = await seedMatch(t.db);
    await asService((tx) => failSellerDefault(tx, m));
    expect(await order(m.buy)).toEqual({ status: "open", filled: "1000", settled: "0", released: "1000", voided: "0" });
    expect(await order(m.sell)).toEqual({ status: "stale", filled: "1000", settled: "0", released: "0", voided: "1000" });
    const rows = await t.pglite.query<{ kind: string; fault: string }>(
      "select kind::text, fault::text from public.match_reversals where match_id = $1 order by kind",
      [m.match],
    );
    expect(rows.rows).toEqual([
      { kind: "released", fault: "seller" },
      { kind: "voided", fault: "seller" },
    ]);
    // filled_quantity never decreased; the public book shows the buy again.
    const book = await t.pglite.query<{ side: string; quantity: string }>("select side::text, quantity::text from public.order_book");
    expect(book.rows).toEqual([{ side: "buy", quantity: "1000" }]);
  });

  it("refuses at commit a failed match without its two reversal rows", async () => {
    const m = await seedMatch(t.db);
    await expect(asService((tx) => tx.query("update public.matches set status = 'failed' where id = $1", [m.match]))).rejects.toThrow(
      /needs one reversal per order/,
    );
    const one = asService(async (tx) => {
      await tx.query("update public.matches set status = 'failed' where id = $1", [m.match]);
      await tx.query(
        `insert into public.match_reversals (match_id, order_id, kind, fault, quantity, reason)
         values ($1, $2, 'released', 'seller', 1000, 'TEST')`,
        [m.match, m.buy],
      );
      await tx.query("update public.orders set released_quantity = 1000, status = 'open' where id = $1", [m.buy]);
    });
    await expect(one).rejects.toThrow(/needs one reversal per order/);
    expect((await order(m.buy))?.status).toBe("filled");
  });

  it("refuses a counter that moves without its rows, or rows that do not match the counters", async () => {
    const m = await seedMatch(t.db);
    await expect(
      asService((tx) => tx.query("update public.orders set released_quantity = 1000, status = 'open' where id = $1", [m.buy])),
    ).rejects.toThrow(/not the sum of its match_reversals/);
    // settled_quantity without a settled match.
    const other = await seedMatch(t.db);
    await expect(
      asService((tx) => tx.query("update public.orders set settled_quantity = 1000 where id = $1", [other.sell])),
    ).rejects.toThrow(/not the sum of its settled matches/);
  });

  it("refuses a reversal of a match that did not fail, of another order, or of another quantity", async () => {
    const m = await seedMatch(t.db);
    const other = await seedMatch(t.db);
    const insert = (order: string, quantity: number) =>
      asService((tx) =>
        tx.query(
          `insert into public.match_reversals (match_id, order_id, kind, fault, quantity, reason) values ($1, $2, 'released', 'none', $3, 'TEST')`,
          [m.match, order, quantity],
        ),
      );
    await expect(insert(m.buy, 1000)).rejects.toThrow(/not failed/);
    await expect(insert(other.buy, 1000)).rejects.toThrow(/./);
    await expect(insert(m.buy, 500)).rejects.toThrow(/./);
  });

  it("keeps filled_quantity and every counter monotonic, and a filled order filled unless released or voided", async () => {
    const m = await seedMatch(t.db);
    await expect(asService((tx) => tx.query("update public.orders set status = 'open' where id = $1", [m.buy]))).rejects.toThrow(
      /only with a release or a void/,
    );
    await asService((tx) => failSellerDefault(tx, m));
    for (const sql of [
      "update public.orders set filled_quantity = 0 where id = $1",
      "update public.orders set released_quantity = 0, status = 'filled' where id = $1",
    ]) {
      await expect(asService((tx) => tx.query(sql, [m.buy]))).rejects.toThrow(/cannot decrease/);
    }
  });

  it("checks status against net matched quantity (filled - released - voided)", async () => {
    const m = await seedMatch(t.db);
    await expect(
      asService(async (tx) => {
        await failSellerDefault(tx, m);
        await tx.query("update public.orders set status = 'partially_filled' where id = $1", [m.buy]);
      }),
    ).rejects.toThrow(/orders_status_check/);
  });

  it("settles a match together with the settled quantity of both orders", async () => {
    const m = await seedMatch(t.db);
    await expect(asService((tx) => tx.query("update public.matches set status = 'settled' where id = $1", [m.match]))).rejects.toThrow(
      /not the sum of its settled matches/,
    );
    await asService(async (tx) => {
      await tx.query("update public.matches set status = 'settled' where id = $1", [m.match]);
      await tx.query("update public.orders set settled_quantity = 1000 where id in ($1, $2)", [m.buy, m.sell]);
    });
    expect(await order(m.buy)).toMatchObject({ status: "filled", settled: "1000" });
  });

  it("keeps the audit trail append-only, even for the service, and hidden from clients", async () => {
    const m = await seedMatch(t.db);
    await asService((tx) => failSellerDefault(tx, m));
    await expect(asService((tx) => tx.query("update public.match_reversals set reason = 'x'"))).rejects.toThrow(/permission denied/);
    await expect(asService((tx) => tx.query("delete from public.match_reversals"))).rejects.toThrow(/permission denied/);
    for (const role of ["anon", "authenticated"]) {
      await expect(
        t.db.transaction(async (tx) => {
          await tx.query(`set local role ${role}`);
          await tx.query("select * from public.match_reversals");
        }),
      ).rejects.toThrow(/permission denied/);
    }
  });
});

describe("migration backfill", () => {
  it("sets settled_quantity from the matches already settled before the migration", async () => {
    const old = await startPglite({ before: MIGRATION });
    const t0 = t;
    try {
      await seedListing(old.db);
      t = old;
      const settled = await seedMatch(old.db);
      const pending = await seedMatch(old.db, 500n);
      await old.pglite.query("update public.matches set status = 'settled' where id = $1", [settled.match]);
      await applyMigration(old.pglite, MIGRATION);
      expect(await order(settled.buy)).toMatchObject({ settled: "1000", released: "0", voided: "0" });
      expect(await order(settled.sell)).toMatchObject({ settled: "1000" });
      expect(await order(pending.buy)).toMatchObject({ settled: "0", status: "partially_filled" });
    } finally {
      t = t0;
      await old.pglite.close();
    }
  }, 240_000);
});
