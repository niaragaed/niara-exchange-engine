import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { UNIQUE_VIOLATION, pgErrorCode } from "../../src/db/database.ts";
import { pgDatabase, type PgClientLike } from "../../src/db/pg.ts";
import {
  acquireInstanceLock,
  asServiceRole,
  checkServiceRole,
  countOpenOrders,
  findOrderByNonce,
  insertMatch,
  insertOrder,
  loadChains,
  loadListings,
  loadMatches,
  loadOpenOrders,
  loadOrder,
  loadSequences,
  releaseInstanceLock,
  updateOrderState,
  type OrderRow,
  type StoredCancelReason,
} from "../../src/db/repository.ts";
import type { Match } from "../../src/engine/types.ts";
import { resetData, startPglite, type TestDb } from "./pglite.ts";

// Labeled test values: patterned addresses, not deployed contracts or real wallets.
const CHAIN = "base-sepolia" as const;
const SETTLEMENT = "0x00000000000000000000000000000000005E7701";
// Stored lowercase on purpose: orders and matches must reuse the listing's spelling.
const ASSET = "0x000000000000000000000000000000000000e001";
const USDT = "0x000000000000000000000000000000000000D001";
const ALICE = "0x00000000000000000000000000000000000A11CE";
const BOB = "0x0000000000000000000000000000000000000B0B";
const NOW = Math.floor(Date.now() / 1000);
const U256_MAX = (1n << 256n) - 1n;

let t: TestDb;
let nonce = 0;

function row(overrides: Partial<OrderRow> & Pick<OrderRow, "seq" | "wallet" | "side">): OrderRow {
  nonce += 1;
  return {
    id: randomUUID(),
    chain: CHAIN,
    asset: ASSET,
    quantity: 1_000n,
    lotSize: 100n,
    limitPrice: 10n,
    paymentAsset: USDT,
    nonce: nonce.toString(16).padStart(32, "0"),
    expiresAt: NOW + 86_400,
    intentVersion: 1,
    intentSignature: "test-signature",
    filledQuantity: 0n,
    settledQuantity: 0n,
    releasedQuantity: 0n,
    voidedQuantity: 0n,
    status: "open",
    ...overrides,
    // The reason the status needs (migration 20261120130000), unless the test sets one.
    cancelReason: overrides.cancelReason ?? defaultReason(overrides.status ?? "open"),
    cancelSignature: overrides.cancelSignature ?? null,
  };
}

function defaultReason(status: OrderRow["status"]): StoredCancelReason | null {
  if (status === "cancelled") return "below_min_notional";
  if (status === "expired" || status === "stale") return status;
  return null;
}

function matchOf(buy: OrderRow, sell: OrderRow, sequence: number, quantity: bigint, price: bigint): Match {
  return {
    id: randomUUID(),
    sequence,
    chain: CHAIN,
    asset: ASSET,
    paymentAsset: USDT,
    buyOrderId: buy.id,
    sellOrderId: sell.id,
    buyer: buy.wallet,
    seller: sell.wallet,
    makerOrderId: sell.id,
    takerSide: "buy",
    quantity,
    lotSize: 100n,
    price,
    paymentAmount: (quantity / 100n) * price,
    expiresAt: Math.min(buy.expiresAt, sell.expiresAt),
  };
}

beforeAll(async () => {
  t = await startPglite();
});

afterAll(async () => {
  await t.pglite.close();
});

beforeEach(async () => {
  await resetData(t.pglite);
  await t.pglite.query(
    `update public.chains set settlement_program = $1, quote_asset = $2, min_order_notional = 5000 where id = $3`,
    [SETTLEMENT, USDT, CHAIN],
  );
  await t.pglite.query(
    `insert into public.listings (chain_id, asset, issuer, asset_class, status, cashback_eligible, doc_hash,
       asset_decimals, lot_size) values ($1, $2, $3, 'equity', 'approved', true, repeat('ab', 32), 6, 100)`,
    [CHAIN, ASSET, ALICE],
  );
});

describe("service role", () => {
  it("runs every write transaction as service_role, whose grants forbid deletes", async () => {
    expect(await checkServiceRole(t.db)).toBe(true);
    await asServiceRole(t.db, async (tx) => {
      const r = await tx.query<{ current_user: string }>("select current_user");
      expect(r.rows[0]!.current_user).toBe("service_role");
    });
    await expect(asServiceRole(t.db, (tx) => tx.query("delete from public.orders"))).rejects.toThrow(/permission denied/);
    // The role is local to the transaction.
    const after = await t.db.query<{ current_user: string }>("select current_user");
    expect(after.rows[0]!.current_user).not.toBe("service_role");
  });
});

describe("configuration reads", () => {
  it("reads the chains' config and the listings, amounts as bigint", async () => {
    const chains = await asServiceRole(t.db, loadChains);
    expect(chains.find((c) => c.id === CHAIN)).toEqual({
      id: CHAIN,
      settlementProgram: SETTLEMENT,
      quoteAsset: USDT,
      minOrderNotional: 5000n,
      maxIntentValiditySecs: 2_592_000,
    });
    expect(chains.find((c) => c.id === "solana-devnet")?.settlementProgram).toBeNull();
    expect(await asServiceRole(t.db, loadListings)).toEqual([
      { chain: CHAIN, asset: ASSET, assetClass: "equity", status: "approved", lotSize: 100n },
    ]);
  });
});

describe("orders and matches", () => {
  it("writes an order, its matches and the maker's new state in one transaction", async () => {
    const maker = row({ seq: 1, wallet: ALICE, side: "sell", limitPrice: 9n });
    await asServiceRole(t.db, (tx) => insertOrder(tx, maker));
    const taker = row({ seq: 2, wallet: BOB, side: "buy", quantity: 400n, filledQuantity: 400n, status: "filled" });
    const m = matchOf(taker, maker, 1, 400n, 9n);
    await asServiceRole(t.db, async (tx) => {
      await insertOrder(tx, taker);
      await insertMatch(tx, m, ASSET);
      await updateOrderState(tx, maker.id, 400n, "partially_filled");
    });
    expect(await loadOrder(t.db, maker.id)).toEqual({ ...maker, filledQuantity: 400n, status: "partially_filled" });
    expect(await loadOrder(t.db, taker.id)).toEqual(taker);
    expect(await loadMatches(t.db)).toEqual([
      {
        id: m.id,
        seq: 1,
        chain: CHAIN,
        asset: ASSET,
        buyOrderId: taker.id,
        sellOrderId: maker.id,
        makerOrderId: maker.id,
        quantity: 400n,
        lotSize: 100n,
        price: 9n,
        paymentAmount: 36n,
        expiresAt: m.expiresAt,
        status: "pending",
      },
    ]);
  });

  it("rolls the whole transaction back when one write fails: no order without its matches", async () => {
    const maker = row({ seq: 1, wallet: ALICE, side: "sell", limitPrice: 9n });
    await asServiceRole(t.db, (tx) => insertOrder(tx, maker));
    // Same wallet: the matches trigger refuses the self-trade.
    const taker = row({ seq: 2, wallet: ALICE, side: "buy", quantity: 400n, filledQuantity: 400n, status: "filled" });
    await expect(
      asServiceRole(t.db, async (tx) => {
        await insertOrder(tx, taker);
        await insertMatch(tx, matchOf(taker, maker, 1, 400n, 9n), ASSET);
      }),
    ).rejects.toThrow(/self-trade/);
    expect(await loadOrder(t.db, taker.id)).toBeNull();
    expect(await loadMatches(t.db)).toEqual([]);
  });

  it("stores the engine's sequences as seq, and reports the highest ones", async () => {
    expect(await loadSequences(t.db)).toEqual({ lastOrderSeq: 0, lastMatchSeq: 0 });
    const a = row({ seq: 7, wallet: ALICE, side: "sell", limitPrice: 9n });
    const b = row({ seq: 9, wallet: BOB, side: "buy", quantity: 100n, filledQuantity: 100n, status: "filled" });
    await asServiceRole(t.db, async (tx) => {
      await insertOrder(tx, a);
      await insertOrder(tx, b);
      await insertMatch(tx, matchOf(b, a, 4, 100n, 9n), ASSET);
      await updateOrderState(tx, a.id, 100n, "partially_filled");
    });
    expect(await loadSequences(t.db)).toEqual({ lastOrderSeq: 9, lastMatchSeq: 4 });
  });

  it("loads the non-terminal orders in their original sequence", async () => {
    const rows = [
      row({ seq: 5, wallet: ALICE, side: "sell" }),
      row({ seq: 2, wallet: BOB, side: "buy" }),
      row({ seq: 3, wallet: ALICE, side: "sell", status: "cancelled" }),
      row({ seq: 4, wallet: BOB, side: "buy", status: "stale" }),
      row({ seq: 6, wallet: ALICE, side: "sell", status: "expired" }),
      row({ seq: 1, wallet: BOB, side: "buy", filledQuantity: 300n, status: "partially_filled" }),
    ];
    await asServiceRole(t.db, async (tx) => {
      for (const r of rows) await insertOrder(tx, r);
    });
    const open = await asServiceRole(t.db, loadOpenOrders);
    expect(open.map((o) => [o.seq, o.status])).toEqual([
      [1, "partially_filled"],
      [2, "open"],
      [4, "stale"],
      [5, "open"],
    ]);
    expect(open[0]).toEqual(rows[5]);
  });

  it("orders by numeric seq, not by its text (10 after 9, not after 1)", async () => {
    await asServiceRole(t.db, async (tx) => {
      for (const seq of [12, 1, 10, 2, 11, 9]) await insertOrder(tx, row({ seq, wallet: ALICE, side: "sell" }));
    });
    expect((await asServiceRole(t.db, loadOpenOrders)).map((o) => o.seq)).toEqual([1, 2, 9, 10, 11, 12]);
  });

  it("keeps uint256 amounts exact", async () => {
    const big = row({ seq: 1, wallet: ALICE, side: "sell", quantity: 100n, lotSize: 100n, limitPrice: U256_MAX });
    await asServiceRole(t.db, (tx) => insertOrder(tx, big));
    expect((await loadOrder(t.db, big.id))?.limitPrice).toBe(U256_MAX);
  });

  it("finds an order by (chain, wallet, nonce), and the nonce is unique per (chain, wallet)", async () => {
    const a = row({ seq: 1, wallet: ALICE, side: "sell" });
    await asServiceRole(t.db, (tx) => insertOrder(tx, a));
    expect(await findOrderByNonce(t.db, CHAIN, ALICE, a.nonce)).toEqual({ id: a.id, status: "open" });
    expect(await findOrderByNonce(t.db, CHAIN, BOB, a.nonce)).toBeNull();
    const again = { ...row({ seq: 2, wallet: ALICE, side: "sell" }), nonce: a.nonce };
    const err = await asServiceRole(t.db, (tx) => insertOrder(tx, again)).catch((e: unknown) => e);
    expect(pgErrorCode(err)).toBe(UNIQUE_VIOLATION);
  });

  it("counts a wallet's open orders: non-terminal and unexpired only", async () => {
    await asServiceRole(t.db, async (tx) => {
      await insertOrder(tx, row({ seq: 1, wallet: ALICE, side: "sell" }));
      await insertOrder(tx, row({ seq: 2, wallet: ALICE, side: "sell", status: "stale" }));
      await insertOrder(tx, row({ seq: 3, wallet: ALICE, side: "sell", status: "cancelled" }));
      await insertOrder(tx, row({ seq: 4, wallet: ALICE, side: "sell", expiresAt: NOW + 100 }));
      await insertOrder(tx, row({ seq: 5, wallet: BOB, side: "buy" }));
    });
    expect(await countOpenOrders(t.db, CHAIN, ALICE, NOW)).toBe(3);
    expect(await countOpenOrders(t.db, CHAIN, ALICE, NOW + 200)).toBe(2);
    expect(await countOpenOrders(t.db, "tempo-testnet", ALICE, NOW)).toBe(0);
  });

  it("refuses an order state change the schema forbids (terminal status)", async () => {
    const a = row({ seq: 1, wallet: ALICE, side: "sell", status: "cancelled" });
    await asServiceRole(t.db, (tx) => insertOrder(tx, a));
    await expect(asServiceRole(t.db, (tx) => updateOrderState(tx, a.id, 0n, "open"))).rejects.toThrow(/terminal/);
  });
});

describe("single-instance advisory lock", () => {
  it("is taken by this session and visible in pg_locks", async () => {
    expect(await acquireInstanceLock(t.db)).toBe(true);
    const r = await t.db.query<{ n: string }>(
      "select count(*)::text as n from pg_locks where locktype = 'advisory' and pid = pg_backend_pid() and granted",
    );
    expect(r.rows[0]!.n).toBe("1");
    await releaseInstanceLock(t.db);
    const after = await t.db.query<{ n: string }>(
      "select count(*)::text as n from pg_locks where locktype = 'advisory' and pid = pg_backend_pid()",
    );
    expect(after.rows[0]!.n).toBe("0");
  });
});

describe("pg adapter (fake client, no server)", () => {
  function fakeClient(failOn?: string) {
    const log: string[] = [];
    const client: PgClientLike = {
      query: async (sql: string) => {
        log.push(sql);
        if (failOn && sql === failOn) throw new Error(`fail: ${sql}`);
        return { rows: [] };
      },
      end: async () => {
        log.push("end");
      },
    };
    return { log, db: pgDatabase(client) };
  }

  it("wraps a transaction in begin/commit, and rolls back when it throws", async () => {
    const ok = fakeClient();
    await ok.db.transaction(async (tx) => {
      await tx.query("a");
    });
    expect(ok.log).toEqual(["begin", "a", "commit"]);
    const bad = fakeClient("b");
    await expect(bad.db.transaction((tx) => tx.query("b"))).rejects.toThrow(/fail: b/);
    expect(bad.log).toEqual(["begin", "b", "rollback"]);
  });

  it("never interleaves a query into a running transaction", async () => {
    const { log, db } = fakeClient();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const tx = db.transaction(async (q) => {
      await q.query("t1");
      await gate;
      await q.query("t2");
    });
    const outside = db.query("outside");
    await Promise.resolve();
    release();
    await Promise.all([tx, outside]);
    expect(log).toEqual(["begin", "t1", "t2", "commit", "outside"]);
  });
});
