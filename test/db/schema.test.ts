/**
 * Loads the migration into an in-memory PGlite (Postgres 17, WASM, in this process).
 * Nothing is applied to any Supabase project. The Supabase roles are recreated here
 * with the attributes that matter: service_role bypasses RLS, anon/authenticated don't.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const MIGRATIONS = join(import.meta.dirname, "../../supabase/migrations");

// Labeled test values: obviously not real addresses.
const CHAIN = "base-sepolia";
const EQUITY = "0x00000000000000000000000000000000000E0001";
const BOND = "0x00000000000000000000000000000000000B0001";
const SUSPENDED = "0x00000000000000000000000000000000000E0002";
const USDT = "0x00000000000000000000000000000000000D0001";
const ALICE = "0x00000000000000000000000000000000000A11CE";
const BOB = "0x0000000000000000000000000000000000000B0B";
const UUID_A = "6f1c1d4e-2a3b-4c5d-8e6f-7a8b9c0d1e2f";

let db: PGlite;
let nonce = 0;

async function asRole<T>(role: string, fn: () => Promise<T>): Promise<T> {
  await db.exec(`set role ${role}`);
  try {
    return await fn();
  } finally {
    await db.exec("reset role");
  }
}

async function insertOrder(o: {
  wallet: string;
  side: "buy" | "sell";
  price: bigint | number;
  quantity?: bigint | number;
  asset?: string;
  lot?: bigint | number;
  expiresIn?: string;
}): Promise<string> {
  nonce += 1;
  const r = await db.query<{ id: string }>(
    `insert into public.orders
       (chain_id, asset, side, quantity, lot_size, limit_price, payment_asset, wallet, nonce,
        expires_at, intent_version, intent_signature)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, now() + $10::interval, 1, 'test-signature')
     returning id`,
    [
      CHAIN,
      o.asset ?? EQUITY,
      o.side,
      String(o.quantity ?? 1000),
      String(o.lot ?? 100),
      String(o.price),
      USDT,
      o.wallet,
      nonce.toString(16).padStart(32, "0"),
      o.expiresIn ?? "1 day",
    ],
  );
  return r.rows[0]!.id;
}

async function insertMatch(m: {
  id?: string;
  buy: string;
  sell: string;
  price: bigint | number;
  quantity?: bigint | number;
  payment?: bigint | number;
}): Promise<void> {
  const quantity = BigInt(m.quantity ?? 100);
  const price = BigInt(m.price);
  await db.query(
    `insert into public.matches
       (id, chain_id, asset, buy_order, sell_order, maker_order, quantity, lot_size, price,
        payment_amount, expires_at)
     values ($1, $2, $3, $4, $5, $5, $6, 100, $7, $8,
             (select least(b.expires_at, s.expires_at) from public.orders b, public.orders s
               where b.id = $4 and s.id = $5))`,
    [
      m.id ?? crypto.randomUUID(),
      CHAIN,
      EQUITY,
      m.buy,
      m.sell,
      String(quantity),
      String(price),
      String(m.payment ?? (quantity / 100n) * price),
    ],
  );
}

beforeAll(async () => {
  db = await PGlite.create();
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    grant usage on schema public to anon, authenticated, service_role;
  `);
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    await db.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
  }
  await db.query(
    `insert into public.listings (chain_id, asset, issuer, asset_class, status, cashback_eligible,
       doc_hash, asset_decimals, lot_size) values
     ($1, $2, $5, 'equity', 'approved', true, repeat('ab', 32), 6, 100),
     ($1, $3, $5, 'fixed_income', 'approved', true, repeat('cd', 32), 6, 100),
     ($1, $4, $5, 'equity', 'suspended', true, repeat('ef', 32), 6, 100),
     ($1, $6, null, 'currency', 'approved', false, null, 6, 1)`,
    [CHAIN, EQUITY, BOND, SUSPENDED, ALICE, USDT],
  );
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  // Tests share one database; each starts without orders/matches.
  await db.exec(
    "delete from public.settlements; delete from public.match_reversals; delete from public.matches; delete from public.orders;",
  );
});

describe("chains", () => {
  it("seeds the five v1 chains with their CAIP-2 ids and nothing deployed", async () => {
    const r = await db.query<{ id: string; caip2: string; settlement_program: string | null }>(
      "select id, caip2, settlement_program from public.chains order by id",
    );
    expect(r.rows.map((c) => [c.id, c.caip2])).toEqual([
      ["base-sepolia", "eip155:84532"],
      ["hyperevm-testnet", "eip155:998"],
      ["robinhood-testnet", "eip155:46630"],
      ["solana-devnet", "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"],
      ["tempo-testnet", "eip155:42431"],
    ]);
    expect(r.rows.every((c) => c.settlement_program === null)).toBe(true);
  });

  it("refuses any other chain", async () => {
    await expect(
      db.query("insert into public.chains (id, kind, caip2, evm_chain_id) values ('sepolia', 'evm', 'eip155:11155111', 11155111)"),
    ).rejects.toThrow(/check/);
  });
});

describe("base_units", () => {
  it("accepts the uint256 range and rejects fractions, negatives and overflow", async () => {
    const max = (1n << 256n) - 1n;
    await expect(db.query(`select $1::public.base_units`, [max.toString()])).resolves.toBeDefined();
    await expect(db.query(`select $1::public.base_units`, [(max + 1n).toString()])).rejects.toThrow(/base_units/);
    await expect(db.query(`select '1.5'::public.base_units`)).rejects.toThrow(/base_units/);
    await expect(db.query(`select '-1'::public.base_units`)).rejects.toThrow(/base_units/);
  });

  it("stores quantities and prices as exact integers (no float)", async () => {
    const id = await insertOrder({ wallet: ALICE, side: "buy", price: 10n ** 30n + 7n, quantity: 10n ** 40n });
    const r = await db.query<{ limit_price: string; quantity: string }>(
      "select limit_price::text, quantity::text from public.orders where id = $1",
      [id],
    );
    expect(r.rows[0]).toEqual({ limit_price: (10n ** 30n + 7n).toString(), quantity: (10n ** 40n).toString() });
  });
});

describe("orders", () => {
  it("requires whole lots", async () => {
    await expect(insertOrder({ wallet: ALICE, side: "buy", price: 5, quantity: 150 })).rejects.toThrow(/check/);
  });

  it("refuses a second order with the same (chain, wallet, nonce)", async () => {
    await insertOrder({ wallet: ALICE, side: "buy", price: 5 });
    nonce -= 1;
    await expect(insertOrder({ wallet: ALICE, side: "buy", price: 5 })).rejects.toThrow(/unique|duplicate/);
  });

  it("refuses an unlisted asset (foreign key to listings)", async () => {
    await expect(
      insertOrder({ wallet: ALICE, side: "buy", price: 5, asset: "0x0000000000000000000000000000000000000000" }),
    ).rejects.toThrow(/foreign key/);
  });

  it("requires an expiry after creation", async () => {
    await expect(insertOrder({ wallet: ALICE, side: "buy", price: 5, expiresIn: "-1 second" })).rejects.toThrow(/check/);
  });

  it("keeps signed fields immutable", async () => {
    const id = await insertOrder({ wallet: ALICE, side: "buy", price: 5 });
    await expect(db.query("update public.orders set limit_price = 6 where id = $1", [id])).rejects.toThrow(/immutable/);
    await expect(db.query("update public.orders set wallet = $2 where id = $1", [id, BOB])).rejects.toThrow(/immutable/);
  });

  it("enforces status consistency, monotonic fills and terminal statuses", async () => {
    const id = await insertOrder({ wallet: ALICE, side: "buy", price: 5, quantity: 1000 });
    await expect(db.query("update public.orders set status = 'filled' where id = $1", [id])).rejects.toThrow(/check/);
    await db.query("update public.orders set filled_quantity = 300, status = 'partially_filled' where id = $1", [id]);
    await expect(
      db.query("update public.orders set filled_quantity = 1100, status = 'filled' where id = $1", [id]),
    ).rejects.toThrow(/check/);
    await expect(db.query("update public.orders set filled_quantity = 200 where id = $1", [id])).rejects.toThrow(
      /cannot decrease/,
    );
    await db.query("update public.orders set status = 'cancelled', cancel_reason = 'below_min_notional' where id = $1", [id]);
    await expect(db.query("update public.orders set status = 'open' where id = $1", [id])).rejects.toThrow(/terminal/);
  });
});

describe("matches", () => {
  it("accepts a valid match", async () => {
    const buy = await insertOrder({ wallet: ALICE, side: "buy", price: 10 });
    const sell = await insertOrder({ wallet: BOB, side: "sell", price: 9 });
    await insertMatch({ buy, sell, price: 9 });
    const r = await db.query<{ status: string }>("select status from public.matches");
    expect(r.rows).toEqual([{ status: "pending" }]);
  });

  it("rejects a self-trade", async () => {
    const buy = await insertOrder({ wallet: ALICE, side: "buy", price: 10 });
    const sell = await insertOrder({ wallet: ALICE, side: "sell", price: 9 });
    await expect(insertMatch({ buy, sell, price: 9 })).rejects.toThrow(/self-trade/);
  });

  it("rejects a price outside either limit", async () => {
    const buy = await insertOrder({ wallet: ALICE, side: "buy", price: 10 });
    const sell = await insertOrder({ wallet: BOB, side: "sell", price: 9 });
    await expect(insertMatch({ buy, sell, price: 11 })).rejects.toThrow(/limit prices/);
    await expect(insertMatch({ buy, sell, price: 8 })).rejects.toThrow(/limit prices/);
  });

  it("rejects swapped sides", async () => {
    const buy = await insertOrder({ wallet: ALICE, side: "buy", price: 10 });
    const sell = await insertOrder({ wallet: BOB, side: "sell", price: 9 });
    await expect(insertMatch({ buy: sell, sell: buy, price: 9 })).rejects.toThrow(/must be a buy/);
  });

  it("rejects a payment amount that is not quantity / lot * price", async () => {
    const buy = await insertOrder({ wallet: ALICE, side: "buy", price: 10 });
    const sell = await insertOrder({ wallet: BOB, side: "sell", price: 9 });
    await expect(insertMatch({ buy, sell, price: 9, payment: 10 })).rejects.toThrow(/check/);
  });

  it("requires a UUID v4 id, never all zeros", async () => {
    const buy = await insertOrder({ wallet: ALICE, side: "buy", price: 10 });
    const sell = await insertOrder({ wallet: BOB, side: "sell", price: 9 });
    await expect(insertMatch({ id: "00000000-0000-0000-0000-000000000000", buy, sell, price: 9 })).rejects.toThrow(
      /check/,
    );
    await expect(insertMatch({ id: "6f1c1d4e-2a3b-1c5d-8e6f-7a8b9c0d1e2f", buy, sell, price: 9 })).rejects.toThrow(
      /check/,
    );
  });

  it("lets only the status change, and keeps terminal statuses", async () => {
    const buy = await insertOrder({ wallet: ALICE, side: "buy", price: 10 });
    const sell = await insertOrder({ wallet: BOB, side: "sell", price: 9 });
    await insertMatch({ id: UUID_A, buy, sell, price: 9 });
    await expect(db.query("update public.matches set price = 10 where id = $1", [UUID_A])).rejects.toThrow(
      /only status/,
    );
    // Settling a match also settles its quantity on both orders (checked at commit).
    await db.transaction(async (tx) => {
      await tx.query("update public.matches set status = 'settled' where id = $1", [UUID_A]);
      await tx.query(
        "update public.orders set filled_quantity = 100, status = 'partially_filled', settled_quantity = 100 where id in ($1, $2)",
        [buy, sell],
      );
    });
    await expect(db.query("update public.matches set status = 'pending' where id = $1", [UUID_A])).rejects.toThrow(
      /terminal/,
    );
  });
});

describe("settlements", () => {
  it("allows at most one settlement per match, on the match's chain", async () => {
    const buy = await insertOrder({ wallet: ALICE, side: "buy", price: 10 });
    const sell = await insertOrder({ wallet: BOB, side: "sell", price: 9 });
    await insertMatch({ id: UUID_A, buy, sell, price: 9 });
    await expect(
      db.query("insert into public.settlements (match_id, chain_id) values ($1, 'tempo-testnet')", [UUID_A]),
    ).rejects.toThrow(/foreign key/);
    await db.query("insert into public.settlements (match_id, chain_id) values ($1, $2)", [UUID_A, CHAIN]);
    await expect(
      db.query("insert into public.settlements (match_id, chain_id) values ($1, $2)", [UUID_A, CHAIN]),
    ).rejects.toThrow(/unique|duplicate/);
  });

  it("requires a tx hash to confirm and an error to fail", async () => {
    const buy = await insertOrder({ wallet: ALICE, side: "buy", price: 10 });
    const sell = await insertOrder({ wallet: BOB, side: "sell", price: 9 });
    await insertMatch({ id: UUID_A, buy, sell, price: 9 });
    await expect(
      db.query("insert into public.settlements (match_id, chain_id, status) values ($1, $2, 'confirmed')", [UUID_A, CHAIN]),
    ).rejects.toThrow(/check/);
    await expect(
      db.query("insert into public.settlements (match_id, chain_id, status) values ($1, $2, 'failed')", [UUID_A, CHAIN]),
    ).rejects.toThrow(/check/);
  });
});

describe("foreign key indexes (20261116130000_fk_indexes)", () => {
  it("every foreign key of matches and settlements is covered by an index on its leading columns", async () => {
    // For each foreign key, look for an index whose first columns are the key's columns.
    const r = await db.query<{ tbl: string; fk: string; covered: boolean }>(
      `select c.conrelid::regclass::text as tbl, c.conname as fk,
              exists (
                select 1 from pg_index i
                 where i.indrelid = c.conrelid and i.indpred is null
                   and (i.indkey::int2[])[0:array_length(c.conkey, 1) - 1] = c.conkey
              ) as covered
         from pg_constraint c
        where c.contype = 'f' and c.conrelid in ('public.matches'::regclass, 'public.settlements'::regclass)
        order by 1, 2`,
    );
    expect(r.rows.length).toBeGreaterThanOrEqual(5);
    expect(r.rows.filter((row) => !row.covered)).toEqual([]);
  });

  it("creates the two indexes with the foreign keys' columns", async () => {
    const r = await db.query<{ indexname: string; indexdef: string }>(
      `select indexname, indexdef from pg_indexes
        where indexname in ('matches_chain_asset_idx', 'settlements_match_chain_idx') order by 1`,
    );
    expect(r.rows.map((i) => i.indexname)).toEqual(["matches_chain_asset_idx", "settlements_match_chain_idx"]);
    expect(r.rows[0]!.indexdef).toMatch(/\(chain_id, asset\)/);
    expect(r.rows[1]!.indexdef).toMatch(/\(match_id, chain_id\)/);
  });
});

describe("row level security", () => {
  it("is enabled on every table", async () => {
    const r = await db.query<{ relname: string; relrowsecurity: boolean }>(
      `select relname, relrowsecurity from pg_class
        where relnamespace = 'public'::regnamespace and relkind = 'r' order by relname`,
    );
    expect(r.rows).toEqual(
      ["chains", "listings", "match_reversals", "matches", "orders", "settlements"].map((relname) => ({
        relname,
        relrowsecurity: true,
      })),
    );
  });

  for (const role of ["anon", "authenticated"]) {
    describe(role, () => {
      it("reads chains and only approved equity/currency listings", async () => {
        await asRole(role, async () => {
          expect((await db.query("select id from public.chains")).rows).toHaveLength(5);
          const r = await db.query<{ asset: string }>("select asset from public.listings order by asset");
          expect(r.rows.map((l) => l.asset).sort()).toEqual([USDT, EQUITY].sort());
        });
      });

      it("reads the order book (live orders only) but never wallets, ids, nonces or signatures", async () => {
        await insertOrder({ wallet: ALICE, side: "buy", price: 10, quantity: 300 });
        await insertOrder({ wallet: BOB, side: "buy", price: 10, quantity: 200 });
        const cancelled = await insertOrder({ wallet: BOB, side: "sell", price: 12 });
        await db.query("update public.orders set status = 'cancelled', cancel_reason = 'self_trade_prevention' where id = $1", [cancelled]);
        await asRole(role, async () => {
          const book = await db.query<{ side: string; price: string; quantity: string; orders: number }>(
            "select side, price::text, quantity::text, orders::int from public.order_book",
          );
          expect(book.rows).toEqual([{ side: "buy", price: "10", quantity: "500", orders: 2 }]);
          for (const column of ["wallet", "id", "nonce", "intent_signature", "*"]) {
            await expect(db.query(`select ${column} from public.orders`)).rejects.toThrow(/permission denied/);
          }
        });
      });

      it("writes nothing", async () => {
        const id = await insertOrder({ wallet: ALICE, side: "buy", price: 10 });
        await asRole(role, async () => {
          await expect(
            db.query(
              `insert into public.orders (chain_id, asset, side, quantity, lot_size, limit_price, payment_asset,
                 wallet, nonce, expires_at, intent_version, intent_signature)
               values ($1, $2, 'buy', 100, 100, 1, $3, $4, repeat('0', 32), now() + interval '1 day', 1, 'x')`,
              [CHAIN, EQUITY, USDT, ALICE],
            ),
          ).rejects.toThrow(/permission denied/);
          await expect(db.query("update public.orders set status = 'cancelled' where id = $1", [id])).rejects.toThrow(
            /permission denied/,
          );
          await expect(db.query("delete from public.orders")).rejects.toThrow(/permission denied/);
          await expect(db.query("update public.listings set status = 'approved'")).rejects.toThrow(/permission denied/);
          await expect(db.query("insert into public.chains (id) values ('x')")).rejects.toThrow(/permission denied/);
        });
      });

      it("cannot read matches or settlements", async () => {
        await asRole(role, async () => {
          await expect(db.query("select * from public.matches")).rejects.toThrow(/permission denied/);
          await expect(db.query("select * from public.settlements")).rejects.toThrow(/permission denied/);
          await expect(db.query("select * from public.match_reversals")).rejects.toThrow(/permission denied/);
        });
      });
    });
  }

  it("service_role inserts orders and matches, and cannot delete", async () => {
    await asRole("service_role", async () => {
      const buy = await insertOrder({ wallet: ALICE, side: "buy", price: 10 });
      const sell = await insertOrder({ wallet: BOB, side: "sell", price: 10 });
      await insertMatch({ buy, sell, price: 10 });
      await expect(db.query("delete from public.orders")).rejects.toThrow(/permission denied/);
    });
  });

  it("suspended and P2P-class listings stay hidden from the public book listing read", async () => {
    await asRole("anon", async () => {
      const r = await db.query("select 1 from public.listings where asset in ($1, $2)", [SUSPENDED, BOND]);
      expect(r.rows).toHaveLength(0);
    });
  });
});
