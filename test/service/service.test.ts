import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../../src/db/database.ts";
import { loadMatches, loadOrder } from "../../src/db/repository.ts";
import { randomMatchId } from "../../src/engine/random-id.ts";
import type { OrderIntent } from "../../src/intents/types.ts";
import type { CoverageChecker } from "../../src/solana/coverage.ts";
import { createApp } from "../../src/service/http.ts";
import {
  NotSingleInstanceError,
  OrderService,
  ServiceRoleError,
  type OrderServiceDeps,
} from "../../src/service/order-service.ts";
import { resetData, startPglite, type TestDb } from "../db/pglite.ts";
import {
  DAY,
  EVM_ASSET,
  EVM_SETTLEMENT,
  EVM_USDT,
  SOL_ASSET,
  SOL_PROGRAM,
  SOL_USDT,
  cancelOf,
  evmIntent,
  evmSigner,
  patternedSolanaAddress,
  solanaIntent,
  solanaSigner,
  type EvmSigner,
  type SolanaSigner,
} from "../intents/fixtures.ts";

/**
 * The order service end to end on PGlite with the real migrations: signed intents
 * (Solana ed25519 and EVM EIP-712, keys generated per run), HTTP through the Hono app
 * (in process, no socket), every write as service_role. Addresses are patterned test
 * values, not deployed programs or tokens. TESTNET ONLY.
 */

const MIN_NOTIONAL = 10_000_000n; // 10 test-USDT (6 decimals) per order and per match
const MAX_OPEN = 3;
const MAX_BODY = 4096;
const SOL_LOT = 1_000_000n;

let t: TestDb;
let offset = 0;
const clock = () => Math.floor(Date.now() / 1000) + offset;
let fatal: unknown[] = [];
let service: OrderService;
let app: ReturnType<typeof createApp>;
let alice: SolanaSigner;
let bob: SolanaSigner;
let mallory: SolanaSigner;
let evmA: EvmSigner;
let evmB: EvmSigner;

const nonce = () => randomBytes(16).toString("hex");

function deps(db: Database = t.db): OrderServiceDeps {
  return {
    db,
    clock,
    newOrderId: randomUUID,
    newMatchId: randomMatchId,
    settlementMarginSecs: 60,
    maxOpenOrdersPerWallet: MAX_OPEN,
    onFatal: (e) => fatal.push(e),
  };
}

function json(i: OrderIntent): Record<string, unknown> {
  return { ...i, quantity: i.quantity.toString(), lotSize: i.lotSize.toString(), limitPrice: i.limitPrice.toString() };
}

async function call(path: string, body?: unknown, raw?: string): Promise<{ status: number; body: any }> {
  const init: RequestInit =
    body === undefined && raw === undefined
      ? { method: "GET" }
      : { method: "POST", headers: { "content-type": "application/json" }, body: raw ?? JSON.stringify(body) };
  const res = await app.request(path, init);
  return { status: res.status, body: await res.json() };
}

function sol(signer: SolanaSigner, over: Partial<OrderIntent> = {}): OrderIntent {
  return solanaIntent(signer.wallet, { nonce: nonce(), expiresAt: clock() + DAY, ...over });
}

async function submit(signer: SolanaSigner | EvmSigner, intent: OrderIntent) {
  return call("/v1/orders", { intent: json(intent), signature: await signer.sign(intent) });
}

async function seed(): Promise<void> {
  await resetData(t.pglite);
  await t.pglite.query(
    `update public.chains set settlement_program = $1, quote_asset = $2, min_order_notional = $3 where id = 'solana-devnet'`,
    [SOL_PROGRAM, SOL_USDT, MIN_NOTIONAL.toString()],
  );
  // EVM addresses stored lowercase: the service checksums for the engine and keeps the
  // stored spelling for the foreign keys.
  await t.pglite.query(
    `update public.chains set settlement_program = $1, quote_asset = $2 where id = 'base-sepolia'`,
    [EVM_SETTLEMENT.toLowerCase(), EVM_USDT.toLowerCase()],
  );
  await t.pglite.query(
    `insert into public.listings (chain_id, asset, issuer, asset_class, status, cashback_eligible, doc_hash,
       asset_decimals, lot_size) values
     ('solana-devnet', $1, 'TEST-ISSUER', 'equity', 'approved', true, repeat('ab', 32), 6, $2),
     ('base-sepolia', $3, 'TEST-ISSUER', 'equity', 'approved', true, repeat('cd', 32), 18, $4)`,
    [SOL_ASSET, SOL_LOT.toString(), EVM_ASSET.toLowerCase(), (10n ** 18n).toString()],
  );
}

beforeAll(async () => {
  t = await startPglite();
  alice = await solanaSigner();
  bob = await solanaSigner();
  mallory = await solanaSigner();
  evmA = evmSigner();
  evmB = evmSigner();
});

afterAll(async () => {
  await t.pglite.close();
});

beforeEach(async () => {
  offset = 0;
  fatal = [];
  await seed();
  service = await OrderService.start(deps());
  app = createApp(service, { maxBodyBytes: MAX_BODY });
});

describe("submit an order", () => {
  it("admits a signed Solana intent, persists it with its signature, and shows it in the public book", async () => {
    const intent = sol(alice, { side: "sell" });
    const signature = await alice.sign(intent);
    const r = await call("/v1/orders", { intent: json(intent), signature });
    expect(r.status).toBe(201);
    expect(r.body.order).toMatchObject({ status: "open", quantity: "5000000", remaining: "5000000", seq: 1 });
    expect(r.body.matches).toEqual([]);
    const row = await loadOrder(t.db, r.body.order.id);
    expect(row).toMatchObject({ nonce: intent.nonce, intentSignature: signature, status: "open", seq: 1, wallet: alice.wallet });

    const book = await call(`/v1/books/solana-devnet/${SOL_ASSET}`);
    expect(book.status).toBe(200);
    expect(book.body).toMatchObject({ lotSize: "1000000", minOrderNotional: "10000000", bids: [] });
    expect(book.body.asks).toEqual([{ price: "25000000", quantity: "5000000", orders: 1 }]);
    expect(JSON.stringify(book.body)).not.toContain(alice.wallet);
  });

  it("matches a crossing order and writes the order, the match and the maker's fill in one transaction", async () => {
    const maker = (await submit(alice, sol(alice, { side: "sell" }))).body.order;
    const r = await submit(bob, sol(bob, { side: "buy", quantity: 2n * SOL_LOT, limitPrice: 30_000_000n }));
    expect(r.status).toBe(201);
    expect(r.body.order).toMatchObject({ status: "filled", filledQuantity: "2000000" });
    expect(r.body.matches).toEqual([
      expect.objectContaining({
        sellOrderId: maker.id,
        buyOrderId: r.body.order.id,
        quantity: "2000000",
        price: "25000000",
        paymentAmount: "50000000",
        status: "pending",
      }),
    ]);
    expect(await loadOrder(t.db, maker.id)).toMatchObject({ filledQuantity: 2n * SOL_LOT, status: "partially_filled" });
    const matches = await loadMatches(t.db);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ id: r.body.matches[0].id, seq: 1, status: "pending", paymentAmount: 50_000_000n });
  });

  it("matches EVM intents (EIP-712), storing the listing's spelling of the asset", async () => {
    const sell = evmIntent(evmA.wallet, { nonce: nonce(), expiresAt: clock() + DAY });
    const buy = evmIntent(evmB.wallet, { nonce: nonce(), expiresAt: clock() + DAY, side: "buy" });
    expect((await submit(evmA, sell)).status).toBe(201);
    const r = await submit(evmB, buy);
    expect(r.status).toBe(201);
    expect(r.body.matches).toHaveLength(1);
    const row = await loadOrder(t.db, r.body.order.id);
    expect(row).toMatchObject({ asset: EVM_ASSET.toLowerCase(), wallet: evmB.wallet, status: "filled" });
    expect((await loadMatches(t.db))[0]!.asset).toBe(EVM_ASSET.toLowerCase());
  });

  it("refuses a bad signature, another program, an expired intent and the wrong payment asset", async () => {
    const intent = sol(alice);
    expect((await call("/v1/orders", { intent: json(intent), signature: await mallory.sign(intent) })).body.error).toBe(
      "bad_signature",
    );
    const other = sol(alice, { settlement: patternedSolanaAddress(0x09) });
    expect((await submit(alice, other)).body.error).toBe("wrong_settlement");
    const expired = sol(alice, { expiresAt: clock() - 1 });
    expect((await submit(alice, expired)).body.error).toBe("expired");
    const brl = sol(alice, { paymentAsset: patternedSolanaAddress(0x0b) });
    expect((await submit(alice, brl)).body.error).toBe("wrong_payment_asset");
    expect(await t.pglite.query("select 1 from public.orders")).toMatchObject({ rows: [] });
  });
});

describe("minimum notional (spec §9.12 item 1)", () => {
  it("refuses an order below the chain's minimum at admission", async () => {
    const r = await submit(alice, sol(alice, { quantity: SOL_LOT, limitPrice: 5_000_000n }));
    expect([r.status, r.body.error]).toEqual([422, "below_min_notional"]);
  });

  it("cancels a resting remainder that falls below the minimum, in the same transaction", async () => {
    const maker = (await submit(alice, sol(alice, { side: "sell", quantity: 3n * SOL_LOT, limitPrice: 5_000_000n }))).body
      .order;
    const r = await submit(bob, sol(bob, { side: "buy", quantity: 2n * SOL_LOT, limitPrice: 5_000_000n }));
    expect(r.body.matches.map((m: { paymentAmount: string }) => m.paymentAmount)).toEqual(["10000000"]);
    expect(await loadOrder(t.db, maker.id)).toMatchObject({ status: "cancelled", filledQuantity: 2n * SOL_LOT });
    expect((await call(`/v1/books/solana-devnet/${SOL_ASSET}`)).body.asks).toEqual([]);
  });
});

describe("abuse limits", () => {
  it("refuses a nonce the wallet already used on this chain", async () => {
    const intent = sol(alice, { side: "sell" });
    expect((await submit(alice, intent)).status).toBe(201);
    const again = await submit(alice, intent);
    expect([again.status, again.body.error]).toEqual([409, "duplicate_nonce"]);
    // Even with other terms: the nonce is spent.
    const other = await submit(alice, { ...intent, limitPrice: 26_000_000n });
    expect(other.body.error).toBe("duplicate_nonce");
  });

  it(`limits a wallet to ${MAX_OPEN} open orders per chain`, async () => {
    const ids: string[] = [];
    for (let i = 0; i < MAX_OPEN; i++) ids.push((await submit(alice, sol(alice, { side: "sell" }))).body.order.id);
    const over = await submit(alice, sol(alice, { side: "sell" }));
    expect([over.status, over.body.error]).toEqual([429, "too_many_open_orders"]);
    expect((await submit(bob, sol(bob, { side: "sell" }))).status).toBe(201);
    // Cancelling one frees a slot.
    const first = (await loadOrder(t.db, ids[0]!))!;
    const cancel = cancelOf(sol(alice, { nonce: first.nonce }));
    expect((await call("/v1/orders/cancel", { cancel, signature: await alice.signCancel(cancel) })).status).toBe(200);
    expect((await submit(alice, sol(alice, { side: "sell" }))).status).toBe(201);
  });

  it("refuses bodies over the size limit before parsing them, and malformed bodies", async () => {
    const big = await call("/v1/orders", undefined, JSON.stringify({ pad: "x".repeat(MAX_BODY) }));
    expect([big.status, big.body.error]).toEqual([413, "body_too_large"]);
    expect((await call("/v1/orders", undefined, "{not json")).body.error).toBe("malformed_json");
    expect((await call("/v1/orders", { intent: json(sol(alice)) })).body.error).toBe("malformed");
    const intent = sol(alice);
    const extra = await call("/v1/orders", { intent: json(intent), signature: await alice.sign(intent), admin: true });
    expect([extra.status, extra.body.error]).toEqual([400, "malformed"]);
    const float = await call("/v1/orders", { intent: { ...json(intent), quantity: 5000000 }, signature: "x" });
    expect([float.status, float.body.error]).toEqual([400, "invalid_amount"]);
  });
});

describe("cancel an order", () => {
  it("cancels with the wallet's signed cancellation, persists it, and refuses a second cancel", async () => {
    const intent = sol(alice, { side: "sell" });
    const order = (await submit(alice, intent)).body.order;
    const cancel = cancelOf(intent);
    const r = await call("/v1/orders/cancel", { cancel, signature: await alice.signCancel(cancel) });
    expect(r.status).toBe(200);
    expect(r.body.order).toMatchObject({ id: order.id, status: "cancelled", cancelReason: "by_wallet" });
    expect((await loadOrder(t.db, order.id))?.status).toBe("cancelled");
    expect((await call(`/v1/books/solana-devnet/${SOL_ASSET}`)).body.asks).toEqual([]);
    const again = await call("/v1/orders/cancel", { cancel, signature: await alice.signCancel(cancel) });
    expect([again.status, again.body.error]).toEqual([409, "not_live"]);
  });

  it("refuses another wallet's signature, and finds nothing under another wallet's name", async () => {
    const intent = sol(alice, { side: "sell" });
    await submit(alice, intent);
    const cancel = cancelOf(intent);
    const forged = await call("/v1/orders/cancel", { cancel, signature: await mallory.signCancel(cancel) });
    expect([forged.status, forged.body.error]).toEqual([401, "bad_signature"]);
    const own = { ...cancel, wallet: mallory.wallet };
    const missing = await call("/v1/orders/cancel", { cancel: own, signature: await mallory.signCancel(own) });
    expect([missing.status, missing.body.error]).toEqual([404, "unknown_order"]);
    expect((await call(`/v1/books/solana-devnet/${SOL_ASSET}`)).body.asks).toHaveLength(1);
  });

  it("answers not_live for an order that was filled before a restart", async () => {
    const intent = sol(alice, { side: "sell", quantity: 2n * SOL_LOT });
    await submit(alice, intent);
    await submit(bob, sol(bob, { side: "buy", quantity: 2n * SOL_LOT }));
    service = await OrderService.start(deps());
    app = createApp(service, { maxBodyBytes: MAX_BODY });
    const cancel = cancelOf(intent);
    const r = await call("/v1/orders/cancel", { cancel, signature: await alice.signCancel(cancel) });
    expect([r.status, r.body.error]).toEqual([409, "not_live"]);
  });
});

describe("expiry", () => {
  it("hides unmatchable orders from the book and stores them expired on the sweep", async () => {
    const order = (await submit(alice, sol(alice, { side: "sell", expiresAt: clock() + 120 }))).body.order;
    expect((await call(`/v1/books/solana-devnet/${SOL_ASSET}`)).body.asks).toHaveLength(1);
    offset = 70; // 50 s left: inside the 60 s settlement margin.
    expect((await call(`/v1/books/solana-devnet/${SOL_ASSET}`)).body.asks).toEqual([]);
    expect((await service.sweepExpired()).body).toEqual({ expired: 1 });
    expect((await loadOrder(t.db, order.id))?.status).toBe("expired");
  });
});

describe("restart and failure", () => {
  it("a restarted service has the same engine state", async () => {
    await submit(alice, sol(alice, { side: "sell", quantity: 4n * SOL_LOT }));
    await submit(bob, sol(bob, { side: "buy", quantity: SOL_LOT * 2n, limitPrice: 20_000_000n }));
    await submit(bob, sol(bob, { side: "buy", quantity: SOL_LOT, limitPrice: 25_000_000n }));
    await submit(mallory, sol(mallory, { side: "sell", limitPrice: 26_000_000n }));
    const before = service.state();
    const restarted = await OrderService.start(deps());
    expect(restarted.state()).toEqual(before);
  });

  it("stops on a failed write: nothing is half-written, later requests get 503, and a restart recovers", async () => {
    await submit(alice, sol(alice, { side: "sell" }));
    // A database whose match inserts fail.
    const failing: Database = {
      ...t.db,
      query: t.db.query,
      transaction: (fn) =>
        t.db.transaction((tx) =>
          fn({
            query: (sql, params) =>
              sql.includes("insert into public.matches") ? Promise.reject(new Error("TEST: injected failure")) : tx.query(sql, params),
          }),
        ),
    };
    const broken = await OrderService.start(deps(failing));
    app = createApp(broken, { maxBodyBytes: MAX_BODY });
    const intent = sol(bob, { side: "buy", quantity: SOL_LOT });
    const signature = await bob.sign(intent);
    const r = await call("/v1/orders", { intent: json(intent), signature });
    expect(r.status).toBe(503);
    expect(fatal).toHaveLength(1);
    expect((await submit(bob, sol(bob, { side: "sell" }))).status).toBe(503);
    expect((await t.pglite.query("select 1 from public.orders")).rows).toHaveLength(1);
    expect(await loadMatches(t.db)).toEqual([]);

    // Restart: the books come back from the database; the same signed intent goes through.
    service = await OrderService.start(deps());
    app = createApp(service, { maxBodyBytes: MAX_BODY });
    const retry = await call("/v1/orders", { intent: json(intent), signature });
    expect(retry.status).toBe(201);
    expect(retry.body.matches).toHaveLength(1);
  });
});

describe("single instance", () => {
  const stub = (answers: { locked: boolean; member: boolean }): Database => ({
    query: async <T>(sql: string) => {
      if (sql.includes("pg_try_advisory_lock")) return { rows: [{ locked: answers.locked }] as T[] };
      if (sql.includes("pg_has_role")) return { rows: [{ ok: answers.member }] as T[] };
      if (sql.includes("match_reversals")) return { rows: [{ ok: true }] as T[] };
      throw new Error(`unexpected query: ${sql}`);
    },
    transaction: async () => {
      throw new Error("no transaction expected");
    },
    close: async () => undefined,
  });

  it("refuses to start when another instance holds the advisory lock", async () => {
    await expect(OrderService.start(deps(stub({ locked: false, member: true })))).rejects.toThrow(NotSingleInstanceError);
  });

  it("refuses to start when the login role cannot act as service_role", async () => {
    await expect(OrderService.start(deps(stub({ locked: true, member: false })))).rejects.toThrow(ServiceRoleError);
  });

  it("holds the lock on the real database after starting", async () => {
    const r = await t.db.query<{ n: string }>(
      "select count(*)::text as n from pg_locks where locktype = 'advisory' and pid = pg_backend_pid() and granted",
    );
    expect(Number(r.rows[0]!.n)).toBeGreaterThanOrEqual(1);
  });
});

describe("public endpoints", () => {
  it("reports a match's settlement status without wallets, and 404 for unknown ids", async () => {
    await submit(alice, sol(alice, { side: "sell" }));
    const r = await submit(bob, sol(bob, { side: "buy", quantity: SOL_LOT }));
    const id = r.body.matches[0].id;
    const status = await call(`/v1/matches/${id}`);
    expect(status.body).toEqual({ matchId: id, status: "pending", settlement: null });
    expect(JSON.stringify(status.body)).not.toContain(alice.wallet);
    expect((await call(`/v1/matches/${randomUUID()}`)).status).toBe(404);
    expect((await call("/v1/matches/not-a-uuid")).status).toBe(404);
  });

  it("answers health with the testnet notice, and 404 for unknown chains, markets and routes", async () => {
    expect((await call("/health")).body).toMatchObject({ status: "ok", testnet: true });
    expect((await call(`/v1/books/sepolia/${SOL_ASSET}`)).status).toBe(404);
    expect((await call(`/v1/books/solana-devnet/${SOL_USDT}`)).body.error).toBe("unknown_market");
    expect((await call("/v1/nothing")).status).toBe(404);
  });
});

describe("on-chain delegate check (spec §3.5), with a fake checker", () => {
  // Wallets listed here are "not covered" on-chain; `down` simulates RPC trouble.
  const uncovered = new Map<string, string>();
  let down = false;
  const fake: CoverageChecker = {
    check: async (needs) => {
      if (down) throw new Error("TEST: RPC down");
      return needs.map((n) => uncovered.get(n.wallet) ?? null);
    },
  };

  beforeEach(async () => {
    uncovered.clear();
    down = false;
    service = await OrderService.start({ ...deps(), coverage: { "solana-devnet": fake } });
    app = createApp(service, { maxBodyBytes: MAX_BODY });
  });

  it("refuses a new order its wallet has not delegated, and stores nothing", async () => {
    uncovered.set(alice.wallet, "the token account does not delegate to the vault");
    const r = await submit(alice, sol(alice, { side: "sell" }));
    expect([r.status, r.body.error, r.body.detail]).toEqual([422, "delegate_not_covered", "the token account does not delegate to the vault"]);
    expect((await t.pglite.query("select 1 from public.orders")).rows).toEqual([]);
  });

  it("marks a resting order stale when its delegation was revoked before matching, and does not match it", async () => {
    const maker = (await submit(alice, sol(alice, { side: "sell" }))).body.order;
    uncovered.set(alice.wallet, "delegated 0 < needed 5000000");
    const r = await submit(bob, sol(bob, { side: "buy", quantity: 2n * SOL_LOT, limitPrice: 30_000_000n }));
    expect(r.status).toBe(201);
    expect(r.body.matches).toEqual([]);
    expect(r.body.order.status).toBe("open");
    expect(await loadOrder(t.db, maker.id)).toMatchObject({ status: "stale" });
    expect((await call(`/v1/books/solana-devnet/${SOL_ASSET}`)).body.asks).toEqual([]);
    // The stale order can still be cancelled by its wallet.
    const intent = (await loadOrder(t.db, maker.id))!;
    const cancel = cancelOf(sol(alice, { nonce: intent.nonce }));
    expect((await call("/v1/orders/cancel", { cancel, signature: await alice.signCancel(cancel) })).status).toBe(200);
  });

  it("matches the covered orders behind an uncovered one", async () => {
    const stale = (await submit(alice, sol(alice, { side: "sell", limitPrice: 24_000_000n }))).body.order;
    const good = (await submit(mallory, sol(mallory, { side: "sell", limitPrice: 25_000_000n }))).body.order;
    uncovered.set(alice.wallet, "the token account does not delegate to the vault");
    const r = await submit(bob, sol(bob, { side: "buy", quantity: 2n * SOL_LOT, limitPrice: 30_000_000n }));
    expect(r.body.matches.map((m: { sellOrderId: string }) => m.sellOrderId)).toEqual([good.id]);
    expect((await loadOrder(t.db, stale.id))?.status).toBe("stale");
  });

  it("refuses to match when the chain cannot be read (503), and lets markStale take orders out", async () => {
    const maker = (await submit(alice, sol(alice, { side: "sell" }))).body.order;
    down = true;
    const r = await submit(bob, sol(bob, { side: "buy" }));
    expect([r.status, r.body.error]).toEqual([503, "chain_unavailable"]);
    expect((await loadOrder(t.db, maker.id))?.status).toBe("open");
    expect((await service.markStale([maker.id])).body).toEqual({ stale: 1 });
    expect((await loadOrder(t.db, maker.id))?.status).toBe("stale");
  });
});
