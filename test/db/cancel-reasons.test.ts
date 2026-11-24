import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomMatchId } from "../../src/engine/random-id.ts";
import { OrderService, SchemaNotReadyError } from "../../src/service/order-service.ts";
import { applyMigration, resetData, startPglite, type TestDb } from "./pglite.ts";

/**
 * Migration 20261120130000_cancel_reasons on PGlite (Postgres 17, real migrations):
 * orders.cancel_reason and orders.cancel_signature. Labeled test values; nothing is
 * applied to any Supabase project.
 */

const CHAIN = "base-sepolia";
const EQUITY = "0x00000000000000000000000000000000000E0001";
const USDT = "0x00000000000000000000000000000000000D0001";
const ALICE = "0x00000000000000000000000000000000000A11CE";
const MIGRATION = "20261120130000_cancel_reasons.sql";
const SIG = "0xTEST-CANCEL-SIGNATURE";

let t: TestDb;
let nonce = 0;

async function seedListing(): Promise<void> {
  await t.pglite.query(
    `insert into public.listings (chain_id, asset, issuer, asset_class, status, cashback_eligible, doc_hash, asset_decimals, lot_size)
     values ($1, $2, $3, 'equity', 'approved', true, repeat('ab', 32), 6, 100)`,
    [CHAIN, EQUITY, ALICE],
  );
}

/** An order of 1,000 (lot 100), nothing filled, in `status`, with optional extra columns. */
async function insertOrder(status: string, extra: Record<string, string | null> = {}): Promise<string> {
  nonce += 1;
  const cols = Object.keys(extra);
  const r = await t.pglite.query<{ id: string }>(
    `insert into public.orders (chain_id, asset, side, quantity, lot_size, limit_price, payment_asset, wallet, nonce,
       expires_at, intent_version, intent_signature, filled_quantity, status${cols.map((c) => `, ${c}`).join("")})
     values ($1, $2, 'sell', 1000, 100, 10, $3, $4, $5, now() + interval '1 day', 1, 'TEST-SIGNATURE', 0, $6
       ${cols.map((_, i) => `, $${7 + i}`).join("")})
     returning id::text`,
    [CHAIN, EQUITY, USDT, ALICE, nonce.toString(16).padStart(32, "0"), status, ...Object.values(extra)],
  );
  return r.rows[0]!.id;
}

async function reasonOf(id: string) {
  const r = await t.pglite.query<{ status: string; reason: string | null; signature: string | null }>(
    `select status::text, cancel_reason::text as reason, cancel_signature as signature from public.orders where id = $1`,
    [id],
  );
  return r.rows[0];
}

describe("applying the migration", () => {
  let pre: TestDb;
  beforeAll(async () => {
    pre = await startPglite({ before: MIGRATION });
    t = pre;
    await seedListing();
  });
  afterAll(async () => {
    await pre.pglite.close();
  });

  it("before it is applied, the order service refuses to start and names it", async () => {
    const err = await OrderService.start({
      db: pre.db,
      clock: () => 1_800_000_000,
      newOrderId: randomUUID,
      newMatchId: randomMatchId,
      settlementMarginSecs: 60,
      maxOpenOrdersPerWallet: 3,
      onFatal: () => undefined,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SchemaNotReadyError);
    expect((err as SchemaNotReadyError).missing).toEqual(["20261120130000_cancel_reasons", "20261122120000_listing_metadata", "20261124120000_time_in_force"]);
  });

  it("refuses to run while a cancelled order has no recorded reason, then backfills expired and stale", async () => {
    const cancelled = await insertOrder("cancelled");
    await pre.pglite.exec("begin");
    await expect(applyMigration(pre.pglite, MIGRATION)).rejects.toThrow(/cancelled orders exist whose reason was never recorded/);
    await pre.pglite.exec("rollback");
    await pre.pglite.query("delete from public.orders where id = $1", [cancelled]);

    const expired = await insertOrder("expired");
    const stale = await insertOrder("stale");
    const open = await insertOrder("open");
    await applyMigration(pre.pglite, MIGRATION);
    expect(await reasonOf(expired)).toEqual({ status: "expired", reason: "expired", signature: null });
    expect(await reasonOf(stale)).toEqual({ status: "stale", reason: "stale", signature: null });
    expect(await reasonOf(open)).toEqual({ status: "open", reason: null, signature: null });
  });
});

describe("cancel_reason and cancel_signature", () => {
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

  it("requires the reason the status calls for, and none on a live or filled order", async () => {
    await expect(insertOrder("cancelled")).rejects.toThrow(/orders_cancel_reason_check/);
    await expect(insertOrder("expired")).rejects.toThrow(/orders_cancel_reason_check/);
    await expect(insertOrder("stale")).rejects.toThrow(/orders_cancel_reason_check/);
    await expect(insertOrder("cancelled", { cancel_reason: "expired" })).rejects.toThrow(/orders_cancel_reason_check/);
    await expect(insertOrder("expired", { cancel_reason: "stale" })).rejects.toThrow(/orders_cancel_reason_check/);
    await expect(insertOrder("open", { cancel_reason: "self_trade_prevention" })).rejects.toThrow(/orders_cancel_reason_check/);
    for (const reason of ["self_trade_prevention", "below_min_notional"]) {
      expect((await reasonOf(await insertOrder("cancelled", { cancel_reason: reason })))?.reason).toBe(reason);
    }
    expect((await reasonOf(await insertOrder("expired", { cancel_reason: "expired" })))?.reason).toBe("expired");
  });

  it("stores the signature exactly when the wallet cancelled", async () => {
    await expect(insertOrder("cancelled", { cancel_reason: "by_wallet" })).rejects.toThrow(/orders_cancel_signature_reason_check/);
    await expect(insertOrder("cancelled", { cancel_reason: "self_trade_prevention", cancel_signature: SIG })).rejects.toThrow(
      /orders_cancel_signature_reason_check/,
    );
    await expect(insertOrder("cancelled", { cancel_reason: "by_wallet", cancel_signature: "" })).rejects.toThrow(/check/);
    const id = await insertOrder("cancelled", { cancel_reason: "by_wallet", cancel_signature: SIG });
    expect(await reasonOf(id)).toEqual({ status: "cancelled", reason: "by_wallet", signature: SIG });
  });

  it("keeps a recorded reason and signature: only stale may become by_wallet", async () => {
    const stale = await insertOrder("stale", { cancel_reason: "stale" });
    await t.pglite.query(
      `update public.orders set status = 'cancelled', cancel_reason = 'by_wallet', cancel_signature = $2 where id = $1`,
      [stale, SIG],
    );
    expect(await reasonOf(stale)).toEqual({ status: "cancelled", reason: "by_wallet", signature: SIG });
    await expect(t.pglite.query(`update public.orders set cancel_signature = 'other' where id = $1`, [stale])).rejects.toThrow(
      /cancel_signature is immutable/,
    );
    await expect(
      t.pglite.query(`update public.orders set cancel_reason = 'below_min_notional', cancel_signature = null where id = $1`, [stale]),
    ).rejects.toThrow(/cancel_signature is immutable/);

    const cancelled = await insertOrder("cancelled", { cancel_reason: "self_trade_prevention" });
    await expect(t.pglite.query(`update public.orders set cancel_reason = 'below_min_notional' where id = $1`, [cancelled])).rejects.toThrow(
      /cancel_reason self_trade_prevention is final/,
    );
  });

  it("is invisible to anon and authenticated", async () => {
    await insertOrder("cancelled", { cancel_reason: "by_wallet", cancel_signature: SIG });
    for (const role of ["anon", "authenticated"]) {
      await t.pglite.exec(`set role ${role}`);
      try {
        for (const column of ["cancel_reason", "cancel_signature"]) {
          await expect(t.pglite.query(`select ${column} from public.orders`)).rejects.toThrow(/permission denied/);
        }
      } finally {
        await t.pglite.exec("reset role");
      }
    }
  });
});
