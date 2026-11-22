import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { addSettledQuantity, asServiceRole, loadMatches } from "../../src/db/repository.ts";
import { setMatchStatus, writeSettlement } from "../../src/db/settlements.ts";
import { randomMatchId } from "../../src/engine/random-id.ts";
import type { OrderIntent } from "../../src/intents/types.ts";
import { createApp } from "../../src/service/http.ts";
import { OrderService, type OrderServiceDeps } from "../../src/service/order-service.ts";
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
  solanaIntent,
  solanaSigner,
  type EvmSigner,
  type SolanaSigner,
} from "../intents/fixtures.ts";

/**
 * The site's read endpoints (wallet orders, one order, wallet matches, market trades,
 * markets) on PGlite with the real migrations, through the Hono app in process.
 * Signers are generated per run; addresses are patterned test values, not deployments;
 * transaction hashes are made-up test values. TESTNET ONLY.
 */

const SOL_LOT = 1_000_000n;
const TEST_TX = (n: number) => `TEST-TX-${n}`; // a made-up hash, not a real transaction

let t: TestDb;
let service: OrderService;
let app: ReturnType<typeof createApp>;
let alice: SolanaSigner;
let bob: SolanaSigner;
let carol: SolanaSigner;
let evmA: EvmSigner;

const clock = () => Math.floor(Date.now() / 1000);
const nonce = () => randomBytes(16).toString("hex");

function deps(): OrderServiceDeps {
  return {
    db: t.db,
    clock,
    newOrderId: randomUUID,
    newMatchId: randomMatchId,
    settlementMarginSecs: 60,
    maxOpenOrdersPerWallet: 50,
    onFatal: (e) => {
      throw e;
    },
  };
}

function json(i: OrderIntent): Record<string, unknown> {
  return { ...i, quantity: i.quantity.toString(), lotSize: i.lotSize.toString(), limitPrice: i.limitPrice.toString() };
}

async function get(path: string): Promise<{ status: number; body: any }> {
  const res = await app.request(path);
  return { status: res.status, body: await res.json() };
}

async function post(path: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

function sol(signer: SolanaSigner, over: Partial<OrderIntent> = {}): OrderIntent {
  return solanaIntent(signer.wallet, { nonce: nonce(), expiresAt: clock() + DAY, ...over });
}

async function submit(signer: SolanaSigner | EvmSigner, intent: OrderIntent) {
  return post("/v1/orders", { intent: json(intent), signature: await signer.sign(intent) });
}

/** What the worker writes when a match settles (src/worker/worker.ts), with a made-up tx hash. */
async function settle(matchId: string, txHash: string): Promise<void> {
  const m = (await loadMatches(t.db)).find((x) => x.id === matchId)!;
  await asServiceRole(t.db, async (tx) => {
    await writeSettlement(tx, { matchId, chain: m.chain, status: "confirmed", attempts: 1, txHash, error: null });
    await setMatchStatus(tx, matchId, "settled");
    await addSettledQuantity(tx, [m.buyOrderId, m.sellOrderId], m.quantity);
  });
}

beforeAll(async () => {
  t = await startPglite();
  alice = await solanaSigner();
  bob = await solanaSigner();
  carol = await solanaSigner();
  evmA = evmSigner();
});

afterAll(async () => {
  await t.pglite.close();
});

beforeEach(async () => {
  await resetData(t.pglite);
  await t.pglite.query(`update public.chains set settlement_program = $1, quote_asset = $2 where id = 'solana-devnet'`, [
    SOL_PROGRAM,
    SOL_USDT,
  ]);
  // EVM addresses stored lowercase: the endpoints answer them checksummed.
  await t.pglite.query(`update public.chains set settlement_program = $1, quote_asset = $2 where id = 'base-sepolia'`, [
    EVM_SETTLEMENT.toLowerCase(),
    EVM_USDT.toLowerCase(),
  ]);
  await t.pglite.query(
    `insert into public.listings (chain_id, asset, issuer, asset_class, status, cashback_eligible, doc_hash, asset_decimals, lot_size) values
     ('solana-devnet', $1, 'TEST-ISSUER', 'equity', 'approved', true, repeat('ab', 32), 6, $2),
     ('base-sepolia', $3, 'TEST-ISSUER', 'equity', 'approved', true, repeat('cd', 32), 18, $4)`,
    [SOL_ASSET, SOL_LOT.toString(), EVM_ASSET.toLowerCase(), (10n ** 18n).toString()],
  );
  service = await OrderService.start(deps());
  app = createApp(service, { maxBodyBytes: 4096 });
});

describe("GET /v1/orders?chain=&wallet= (a wallet's orders)", () => {
  it("lists every status of the wallet's orders on that chain, newest first, with nonce and cancel reason", async () => {
    const first = sol(alice, { side: "sell", quantity: 2n * SOL_LOT });
    await submit(alice, first);
    await submit(bob, sol(bob, { side: "buy", quantity: SOL_LOT })); // fills half of alice's first
    const second = sol(alice, { side: "sell", limitPrice: 30_000_000n });
    await submit(alice, second);
    const cancel = cancelOf(second);
    expect((await post("/v1/orders/cancel", { cancel, signature: await alice.signCancel(cancel) })).status).toBe(200);

    const r = await get(`/v1/orders?chain=solana-devnet&wallet=${alice.wallet}`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ chain: "solana-devnet", wallet: alice.wallet, next: null });
    expect(r.body.orders).toHaveLength(2);
    expect(r.body.orders[0]).toMatchObject({
      nonce: second.nonce,
      status: "cancelled",
      cancelReason: "by_wallet",
      remaining: "5000000",
      limitPrice: "30000000",
    });
    expect(r.body.orders[1]).toMatchObject({
      nonce: first.nonce,
      status: "partially_filled",
      cancelReason: null,
      quantity: "2000000",
      filledQuantity: "1000000",
      settledQuantity: "0",
      remaining: "1000000",
      wallet: alice.wallet,
      asset: SOL_ASSET,
      paymentAsset: SOL_USDT,
    });
    expect(r.body.orders[0].seq).toBeGreaterThan(r.body.orders[1].seq);
    expect(Date.parse(r.body.orders[0].createdAt)).not.toBeNaN();
    // Never the signatures.
    expect(JSON.stringify(r.body)).not.toMatch(/ignature/);
    // Another wallet's orders are not mixed in.
    expect((await get(`/v1/orders?chain=solana-devnet&wallet=${bob.wallet}`)).body.orders).toHaveLength(1);
    expect((await get(`/v1/orders?chain=solana-devnet&wallet=${carol.wallet}`)).body.orders).toEqual([]);
  });

  it("pages with limit and before", async () => {
    for (let i = 0; i < 5; i++) await submit(alice, sol(alice, { side: "sell" }));
    const p1 = await get(`/v1/orders?chain=solana-devnet&wallet=${alice.wallet}&limit=2`);
    expect(p1.body.orders).toHaveLength(2);
    expect(p1.body.next).toBe(p1.body.orders[1].seq);
    const p2 = await get(`/v1/orders?chain=solana-devnet&wallet=${alice.wallet}&limit=2&before=${p1.body.next}`);
    const p3 = await get(`/v1/orders?chain=solana-devnet&wallet=${alice.wallet}&limit=2&before=${p2.body.next}`);
    expect(p3.body.orders).toHaveLength(1);
    expect(p3.body.next).toBeNull();
    const seqs = [...p1.body.orders, ...p2.body.orders, ...p3.body.orders].map((o: { seq: number }) => o.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => b - a));
    expect(new Set(seqs).size).toBe(5);
  });

  it("finds an EVM wallet whatever its spelling, and answers checksummed addresses", async () => {
    await submit(evmA, evmIntent(evmA.wallet, { nonce: nonce(), expiresAt: clock() + DAY }));
    const r = await get(`/v1/orders?chain=base-sepolia&wallet=${evmA.wallet.toLowerCase()}`);
    expect(r.body.wallet).toBe(evmA.wallet);
    expect(r.body.orders).toHaveLength(1);
    expect(r.body.orders[0]).toMatchObject({ asset: EVM_ASSET, paymentAsset: EVM_USDT, wallet: evmA.wallet });
    // The same wallet has no orders on another chain.
    expect((await get(`/v1/orders?chain=tempo-testnet&wallet=${evmA.wallet}`)).body.orders).toEqual([]);
  });

  it("refuses an unknown chain, a wallet of the wrong kind, and bad paging", async () => {
    const bad = async (q: string) => (await get(`/v1/orders?${q}`)).body.error;
    expect(await bad(`chain=ethereum&wallet=${alice.wallet}`)).toBe("invalid_chain");
    expect(await bad(`wallet=${alice.wallet}`)).toBe("invalid_chain");
    expect(await bad("chain=solana-devnet")).toBe("invalid_wallet");
    expect(await bad(`chain=solana-devnet&wallet=${evmA.wallet}`)).toBe("invalid_wallet");
    expect(await bad(`chain=base-sepolia&wallet=${alice.wallet}`)).toBe("invalid_wallet");
    expect(await bad(`chain=solana-devnet&wallet=${alice.wallet}&limit=0`)).toBe("invalid_limit");
    expect(await bad(`chain=solana-devnet&wallet=${alice.wallet}&limit=101`)).toBe("invalid_limit");
    expect(await bad(`chain=solana-devnet&wallet=${alice.wallet}&before=-1`)).toBe("invalid_cursor");
    expect((await get(`/v1/orders?chain=ethereum&wallet=x`)).status).toBe(400);
  });
});

describe("GET /v1/orders/:id (one order's current state)", () => {
  it("shows a resting order filled later by another taker, its matches, then their settlement", async () => {
    const maker = (await submit(alice, sol(alice, { side: "sell", quantity: 3n * SOL_LOT }))).body.order;
    const before = await get(`/v1/orders/${maker.id}`);
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({ order: { id: maker.id, status: "open", remaining: "3000000" }, matchIds: [], matches: [] });

    const m1 = (await submit(bob, sol(bob, { side: "buy", quantity: SOL_LOT }))).body.matches[0];
    const m2 = (await submit(carol, sol(carol, { side: "buy", quantity: 2n * SOL_LOT, limitPrice: 26_000_000n }))).body.matches[0];
    const filled = await get(`/v1/orders/${maker.id}`);
    expect(filled.body.order).toMatchObject({ status: "filled", filledQuantity: "3000000", remaining: "0", settledQuantity: "0" });
    expect(filled.body.matchIds).toEqual([m1.id, m2.id]);
    expect(filled.body.matches[1]).toMatchObject({
      id: m2.id,
      sellOrderId: maker.id,
      makerOrderId: maker.id,
      takerSide: "buy",
      quantity: "2000000",
      price: "25000000",
      paymentAmount: "50000000",
      status: "pending",
      settlement: null,
    });

    await settle(m1.id, TEST_TX(1));
    const settled = await get(`/v1/orders/${maker.id}`);
    expect(settled.body.order.settledQuantity).toBe("1000000");
    expect(settled.body.matches[0]).toMatchObject({
      status: "settled",
      settlement: { status: "confirmed", attempts: 1, txHash: TEST_TX(1), error: null },
    });
    expect(Date.parse(settled.body.matches[0].settlement.settledAt)).not.toBeNaN();
    expect(settled.body.matches[1].settlement).toBeNull();
    // No wallets in matches, and never the signatures.
    expect(JSON.stringify(settled.body.matches)).not.toContain(bob.wallet);
    expect(JSON.stringify(settled.body)).not.toMatch(/ignature/);
  });

  it("answers orders the engine no longer holds after a restart, from the database", async () => {
    const intent = sol(alice, { side: "sell" });
    const order = (await submit(alice, intent)).body.order;
    const cancel = cancelOf(intent);
    await post("/v1/orders/cancel", { cancel, signature: await alice.signCancel(cancel) });
    service = await OrderService.start(deps());
    app = createApp(service, { maxBodyBytes: 4096 });
    expect((await get(`/v1/orders/${order.id}`)).body.order).toMatchObject({ status: "cancelled", cancelReason: "by_wallet" });
  });

  it("answers 404 for an unknown or malformed id", async () => {
    expect((await get(`/v1/orders/${randomUUID()}`)).body.error).toBe("unknown_order");
    expect((await get("/v1/orders/not-a-uuid")).status).toBe(404);
    expect((await get("/v1/orders/cancel")).status).toBe(404);
  });
});
