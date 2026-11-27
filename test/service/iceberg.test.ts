import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadOrder } from "../../src/db/repository.ts";
import { randomMatchId } from "../../src/engine/random-id.ts";
import type { OrderIntent } from "../../src/intents/types.ts";
import { createApp } from "../../src/service/http.ts";
import { OrderService, type OrderServiceDeps } from "../../src/service/order-service.ts";
import { resetData, startPglite, type TestDb } from "../db/pglite.ts";
import { DAY, SOL_ASSET, SOL_PROGRAM, SOL_USDT, cancelOf, solanaIntent, solanaSigner, type SolanaSigner } from "../intents/fixtures.ts";

/**
 * Iceberg orders through the order service on PGlite (real migrations), signed v3
 * intents (keys generated per run), HTTP through the Hono app in process. The privacy
 * audit: no public read path shows an iceberg's hidden quantity. Patterned test
 * addresses only. TESTNET ONLY.
 */

const LOT = 1_000_000n;
const PRICE = 5_000_000n; // per lot; the minimum (10 test-USDT) is 2 lots
const MIN_NOTIONAL = 10_000_000n;
// A distinctive total, so a leak of it (or of what is left of it) is easy to find.
const TOTAL_LOTS = 9_137n;
const DISPLAY_LOTS = 3n;

let t: TestDb;
const clock = () => Math.floor(Date.now() / 1000);
let fatal: unknown[] = [];
let service: OrderService;
let app: ReturnType<typeof createApp>;
let alice: SolanaSigner;
let bob: SolanaSigner;

function deps(): OrderServiceDeps {
  return {
    db: t.db,
    clock,
    newOrderId: randomUUID,
    newMatchId: randomMatchId,
    settlementMarginSecs: 60,
    maxOpenOrdersPerWallet: 5,
    onFatal: (e) => fatal.push(e),
  };
}

const json = (i: OrderIntent): Record<string, unknown> => ({
  ...i,
  quantity: i.quantity.toString(),
  lotSize: i.lotSize.toString(),
  limitPrice: i.limitPrice.toString(),
  ...(i.displayQuantity !== undefined && { displayQuantity: i.displayQuantity.toString() }),
});

async function call(path: string, body?: unknown): Promise<{ status: number; body: any; text: string }> {
  const res = await app.request(
    path,
    body === undefined ? { method: "GET" } : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
  );
  const text = await res.text();
  return { status: res.status, body: JSON.parse(text), text };
}

function intent(signer: SolanaSigner, over: Partial<OrderIntent>): OrderIntent {
  return solanaIntent(signer.wallet, {
    nonce: randomBytes(16).toString("hex"),
    expiresAt: clock() + DAY,
    limitPrice: PRICE,
    version: 2,
    timeInForce: "GTC",
    ...over,
  });
}

const icebergIntent = (over: Partial<OrderIntent> = {}) =>
  intent(alice, { version: 3, side: "sell", quantity: TOTAL_LOTS * LOT, displayQuantity: DISPLAY_LOTS * LOT, ...over });

async function submit(signer: SolanaSigner, i: OrderIntent) {
  return call("/v1/orders", { intent: json(i), signature: await signer.sign(i) });
}

beforeAll(async () => {
  t = await startPglite();
  alice = await solanaSigner();
  bob = await solanaSigner();
});

afterAll(async () => {
  await t.pglite.close();
});

beforeEach(async () => {
  fatal = [];
  await resetData(t.pglite);
  await t.pglite.query(
    `update public.chains set settlement_program = $1, quote_asset = $2, min_order_notional = $3 where id = 'solana-devnet'`,
    [SOL_PROGRAM, SOL_USDT, MIN_NOTIONAL.toString()],
  );
  await t.pglite.query(
    `insert into public.listings (chain_id, asset, issuer, asset_class, status, cashback_eligible, doc_hash, asset_decimals, lot_size)
     values ('solana-devnet', $1, 'TEST-ISSUER', 'equity', 'approved', true, repeat('ab', 32), 6, $2)`,
    [SOL_ASSET, LOT.toString()],
  );
  service = await OrderService.start(deps());
  app = createApp(service, { maxBodyBytes: 4096 });
});

describe("placing an iceberg (intent v3)", () => {
  it("rests the visible slice; its wallet's placement answer shows the total, the public book the slice only", async () => {
    const i = icebergIntent();
    const r = await submit(alice, i);
    expect(r.status).toBe(201);
    expect(r.body.order).toMatchObject({
      quantity: (TOTAL_LOTS * LOT).toString(),
      remaining: (TOTAL_LOTS * LOT).toString(),
      displayQuantity: (DISPLAY_LOTS * LOT).toString(),
      visibleQuantity: (DISPLAY_LOTS * LOT).toString(),
      status: "open",
    });
    const book = await call(`/v1/books/solana-devnet/${SOL_ASSET}`);
    expect(book.body.asks).toEqual([{ price: PRICE.toString(), quantity: (DISPLAY_LOTS * LOT).toString(), orders: 1 }]);
    expect(await loadOrder(t.db, r.body.order.id)).toMatchObject({ intentVersion: 3, displayQuantity: DISPLAY_LOTS * LOT, visibleQuantity: DISPLAY_LOTS * LOT });
  });

  it("refuses an IOC iceberg (400 iceberg_requires_gtc) and a display below the minimum (422 display_below_min_notional)", async () => {
    // Refused while parsing, before any signature check (a wallet's signer refuses to build it).
    const placeholder = "1".repeat(64); // TEST placeholder, not a signature
    const ioc = await call("/v1/orders", { intent: json(icebergIntent({ timeInForce: "IOC" })), signature: placeholder });
    expect(ioc).toMatchObject({ status: 400, body: { error: "iceberg_requires_gtc" } });
    const small = await submit(alice, icebergIntent({ displayQuantity: 1n * LOT })); // 1 lot = 5 test-USDT < 10
    expect(small).toMatchObject({ status: 422, body: { error: "display_below_min_notional" } });
    const bad = await call("/v1/orders", { intent: json(icebergIntent({ displayQuantity: TOTAL_LOTS * LOT })), signature: placeholder });
    expect(bad).toMatchObject({ status: 400, body: { error: "invalid_display_quantity" } });
  });

  it("a taker fills two slices in one pass; the slice is refreshed and the restart keeps it with its priority", async () => {
    const placed = await submit(alice, icebergIntent());
    const plain = await submit(bob, intent(bob, { side: "sell", quantity: 2n * LOT })); // rests after the first slice
    expect(plain.status).toBe(201);
    const buyer = await solanaSigner();
    const taken = await submit(buyer, intent(buyer, { side: "buy", quantity: 8n * LOT }));
    expect(taken.status).toBe(201);
    expect(taken.body.matches.map((m: any) => [m.makerOrderId, m.quantity])).toEqual([
      [placed.body.order.id, (3n * LOT).toString()],
      [plain.body.order.id, (2n * LOT).toString()],
      [placed.body.order.id, (3n * LOT).toString()],
    ]);
    const before = service.state();
    const ice = before.orders.find((o) => o.id === placed.body.order.id)!;
    expect(ice).toMatchObject({ visibleQuantity: 3n * LOT, remaining: (TOTAL_LOTS - 6n) * LOT });
    expect(ice.prioritySeq).toBeGreaterThan(ice.seq);

    const restarted = await OrderService.start(deps());
    expect(restarted.state()).toEqual(before);
    expect(fatal).toEqual([]);
  });

  it("a cancellation mid-iceberg takes it out whole; the wallet's signed answer shows what was left", async () => {
    const i = icebergIntent();
    const placed = await submit(alice, i);
    const buyer = await solanaSigner();
    await submit(buyer, intent(buyer, { side: "buy", quantity: 3n * LOT }));
    const c = await call("/v1/orders/cancel", { cancel: cancelOf(i), signature: await alice.signCancel(cancelOf(i)) });
    expect(c.status).toBe(200);
    expect(c.body.order).toMatchObject({ status: "cancelled", remaining: ((TOTAL_LOTS - 3n) * LOT).toString() });
    expect((await call(`/v1/books/solana-devnet/${SOL_ASSET}`)).body.asks).toEqual([]);
    const after = await call(`/v1/orders/${placed.body.order.id}`);
    expect(after.body.order).toMatchObject({ status: "cancelled", quantity: null, remaining: null, visibleQuantity: "0" });
  });
});

describe("privacy audit: no public read path shows an iceberg's hidden quantity", () => {
  it("book, orders (by wallet and by id), matches (by wallet and by id), trades and markets", async () => {
    const placed = await submit(alice, icebergIntent());
    const buyer = await solanaSigner();
    const taken = await submit(buyer, intent(buyer, { side: "buy", quantity: 3n * LOT }));
    expect(taken.status).toBe(201);
    const matchId = taken.body.matches[0].id;
    const aliceId = placed.body.order.id;

    // Every amount that would reveal the hidden part: the total, the remainder, the hidden
    // remainder (in base units: 10 digits, which random ids and addresses do not contain by chance).
    const secrets = [TOTAL_LOTS * LOT, (TOTAL_LOTS - 3n) * LOT, (TOTAL_LOTS - 6n) * LOT].map(String);
    const reads = [
      `/v1/books/solana-devnet/${SOL_ASSET}`,
      `/v1/orders?chain=solana-devnet&wallet=${alice.wallet}`,
      `/v1/orders/${aliceId}`,
      `/v1/orders/${taken.body.order.id}`, // the counterparty's order lists the iceberg's id in its matches
      `/v1/matches?chain=solana-devnet&wallet=${alice.wallet}`,
      `/v1/matches?chain=solana-devnet&wallet=${buyer.wallet}`,
      `/v1/matches/${matchId}`,
      `/v1/trades/solana-devnet/${SOL_ASSET}`,
      "/v1/markets",
    ];
    for (const path of reads) {
      const r = await call(path);
      expect(r.status, path).toBe(200);
      for (const s of secrets) expect(r.text.includes(s), `${path} shows ${s}`).toBe(false);
    }

    // What the public order view shows instead.
    const listed = (await call(`/v1/orders?chain=solana-devnet&wallet=${alice.wallet}`)).body.orders[0];
    expect(listed).toMatchObject({
      id: aliceId,
      quantity: null,
      remaining: null,
      displayQuantity: (DISPLAY_LOTS * LOT).toString(),
      visibleQuantity: (DISPLAY_LOTS * LOT).toString(), // refreshed after the first slice filled
      filledQuantity: (3n * LOT).toString(),
      status: "partially_filled",
    });
    // Orders shown whole are unchanged.
    const plain = (await call(`/v1/orders/${taken.body.order.id}`)).body.order;
    expect(plain).toMatchObject({ quantity: (3n * LOT).toString(), remaining: "0", displayQuantity: null, visibleQuantity: null });
  });
});
