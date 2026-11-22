import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
