import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { SettleOutcome, SettlementAdapter } from "../../src/adapters/settlement-adapter.ts";
import { SolanaSettlementAdapter } from "../../src/adapters/solana-adapter.ts";
import { asServiceRole, insertMatch, insertOrder, loadOrder } from "../../src/db/repository.ts";
import { loadSettlement } from "../../src/db/settlements.ts";
import type { Match } from "../../src/engine/types.ts";
import type { CoverageChecker } from "../../src/solana/coverage.ts";
import { solanaCoverageChecker } from "../../src/solana/coverage.ts";
import { SettlementFailure } from "../../src/solana/errors.ts";
import { PROGRAM_ID } from "../../src/solana/idl.ts";
import { randomMatchId } from "../../src/engine/random-id.ts";
import { OrderService } from "../../src/service/order-service.ts";
import { SettlementWorker, type WorkerOptions } from "../../src/worker/worker.ts";
import { resetData, startPglite, type TestDb } from "../db/pglite.ts";
import { world, type World } from "../solana/world.ts";

/**
 * Settlement worker on PGlite (real migrations) with a mocked chain: a scripted fake
 * adapter for the decision logic, and the real SolanaSettlementAdapter over a mocked
 * RPC. Nothing touches a network.
 */

let t: TestDb;
let w: World;
let seq = 0;
let failures: { matchId: string; fault: string; reason: string }[];
let sleeps: number[];

const now = () => Math.floor(Date.now() / 1000);

/** A filled buy and sell order and their match, stored as the order service would. */
async function seedMatch(over: { expiresIn?: number } = {}): Promise<Match> {
  const expiresAt = now() + (over.expiresIn ?? 3600);
  const base = {
    chain: "solana-devnet" as const,
    asset: w.asset.toBase58(),
    quantity: 10n,
    lotSize: 1n,
    limitPrice: 25_000_000n,
    paymentAsset: w.usdt.toBase58(),
    expiresAt,
    intentVersion: 1,
    intentSignature: "TEST-SIGNATURE",
    filledQuantity: 10n,
    status: "filled" as const,
  };
  const sell = { ...base, id: randomUUID(), seq: ++seq, side: "sell" as const, wallet: w.seller.publicKey.toBase58(), nonce: seq.toString(16).padStart(32, "0") };
  const buy = { ...base, id: randomUUID(), seq: ++seq, side: "buy" as const, wallet: w.buyer.publicKey.toBase58(), nonce: seq.toString(16).padStart(32, "0") };
  const match = w.match({ id: randomUUID(), sequence: seq, buyOrderId: buy.id, sellOrderId: sell.id, makerOrderId: sell.id, expiresAt });
  await asServiceRole(t.db, async (tx) => {
    await insertOrder(tx, sell);
    await insertOrder(tx, buy);
    await insertMatch(tx, match, w.asset.toBase58());
  });
  return match;
}

interface FakeAdapter extends SettlementAdapter {
  settled: Map<string, string>;
  settleCalls: string[];
  /** Scripted settle results, consumed in order; default: success. */
  script: (SettleOutcome | Error)[];
  findFailures: Error[];
}

function fakeAdapter(): FakeAdapter {
  const a: FakeAdapter = {
    chain: "solana-devnet",
    settled: new Map(),
    settleCalls: [],
    script: [],
    findFailures: [],
    findSettlement: async (m) => {
      const f = a.findFailures.shift();
      if (f) throw f;
      return a.settled.get(m.id) ?? null;
    },
    settle: async (m) => {
      a.settleCalls.push(m.id);
      const r = a.script.shift() ?? { txHash: `TEST-TX-${a.settleCalls.length}`, alreadySettled: false };
      if (r instanceof Error) throw r;
      a.settled.set(m.id, r.txHash);
      return r;
    },
    isListed: async () => true,
  };
  return a;
}

function worker(adapter: SettlementAdapter, over: Partial<WorkerOptions> = {}): SettlementWorker {
  return new SettlementWorker({
    db: t.db,
    adapters: { "solana-devnet": adapter },
    failMatch: async (f) => {
      failures.push({ matchId: f.match.id, fault: f.fault, reason: f.reason });
      return { status: 200 };
    },
    clock: now,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    maxAttempts: 4,
    backoffBaseMs: 2_000,
    backoffMaxMs: 5_000,
    deadlineMarginSecs: 90,
    ...over,
  });
}

const transient = () => new SettlementFailure("transient", "RPC: 429 Too Many Requests");

beforeAll(async () => {
  t = await startPglite();
});

afterAll(async () => {
  await t.pglite.close();
});

beforeEach(async () => {
  await resetData(t.pglite);
  w = world();
  failures = [];
  sleeps = [];
  await t.pglite.query(`update public.chains set settlement_program = $1, quote_asset = $2 where id = 'solana-devnet'`, [
    PROGRAM_ID.toBase58(),
    w.usdt.toBase58(),
  ]);
  await t.pglite.query(
    `insert into public.listings (chain_id, asset, issuer, asset_class, status, cashback_eligible, doc_hash, asset_decimals, lot_size)
     values ('solana-devnet', $1, 'TEST-ISSUER', 'equity', 'approved', true, repeat('ab', 32), 0, 1)`,
    [w.asset.toBase58()],
  );
});

describe("settlement worker (fake adapter)", () => {
  it("settles pending matches in seq order and records the tx hash", async () => {
    const first = await seedMatch();
    const second = await seedMatch();
    const adapter = fakeAdapter();
    expect(await worker(adapter).drain()).toEqual(["settled", "settled"]);
    expect(adapter.settleCalls).toEqual([first.id, second.id]);
    expect(await loadSettlement(t.db, first.id)).toEqual({
      matchId: first.id,
      matchStatus: "settled",
      status: "confirmed",
      attempts: 1,
      txHash: "TEST-TX-1",
      error: null,
    });
    expect(await worker(adapter).runOnce()).toBe("idle");
    // The match's quantity is settled on both orders, in the same transaction.
    expect((await loadOrder(t.db, first.buyOrderId))?.settledQuantity).toBe(10n);
    expect((await loadOrder(t.db, first.sellOrderId))?.settledQuantity).toBe(10n);
  });

  it("never settles twice: a match already settled on-chain is confirmed without a send", async () => {
    const m = await seedMatch();
    const adapter = fakeAdapter();
    adapter.settled.set(m.id, "TEST-EARLIER-TX");
    expect(await worker(adapter).runOnce()).toBe("already_settled");
    expect(adapter.settleCalls).toEqual([]);
    expect(await loadSettlement(t.db, m.id)).toMatchObject({ matchStatus: "settled", txHash: "TEST-EARLIER-TX", attempts: 0 });
  });

  it("resumes a match left settling by a crash: checks the chain first, sends nothing if it landed", async () => {
    const m = await seedMatch();
    await t.pglite.query("update public.matches set status = 'settling' where id = $1", [m.id]);
    await t.pglite.query("insert into public.settlements (match_id, chain_id, status, attempts) values ($1, 'solana-devnet', 'submitted', 1)", [m.id]);
    const adapter = fakeAdapter();
    adapter.settled.set(m.id, "TEST-LANDED-BEFORE-CRASH");
    expect(await worker(adapter).runOnce()).toBe("already_settled");
    expect(adapter.settleCalls).toEqual([]);
    expect(await loadSettlement(t.db, m.id)).toMatchObject({ status: "confirmed", attempts: 1, txHash: "TEST-LANDED-BEFORE-CRASH" });
  });

  it("fails a match whose expires_at has passed, or is too close to land in time, without sending", async () => {
    const expired = await seedMatch({ expiresIn: 3600 });
    const adapter = fakeAdapter();
    expect(await worker(adapter, { clock: () => now() + 3601 }).runOnce()).toBe("failed");
    expect(failures).toEqual([{ matchId: expired.id, fault: "expired", reason: "expired before settlement (expires_at has passed)" }]);
    await t.pglite.query("delete from public.matches where id = $1", [expired.id]);
    const close = await seedMatch({ expiresIn: 60 });
    expect(await worker(adapter).runOnce()).toBe("failed");
    expect(failures[1]).toMatchObject({ matchId: close.id, fault: "expired", reason: expect.stringMatching(/too close to expires_at/) });
    expect(adapter.settleCalls).toEqual([]);
  });

  it("retries transient RPC errors with a bounded exponential backoff, then settles", async () => {
    const m = await seedMatch();
    const adapter = fakeAdapter();
    adapter.script = [transient(), transient()];
    expect(await worker(adapter).runOnce()).toBe("settled");
    expect(sleeps).toEqual([2_000, 4_000]);
    expect(await loadSettlement(t.db, m.id)).toMatchObject({ status: "confirmed", attempts: 3, txHash: "TEST-TX-3", error: null });
  });

  it("gives up after maxAttempts transient failures (backoff capped), checking the chain one last time", async () => {
    const m = await seedMatch();
    const adapter = fakeAdapter();
    adapter.script = [transient(), transient(), transient(), transient()];
    expect(await worker(adapter).runOnce()).toBe("failed");
    expect(sleeps).toEqual([2_000, 4_000, 5_000]);
    expect(failures).toEqual([{ matchId: m.id, fault: "none", reason: expect.stringMatching(/gave up after 4 attempts: RPC: 429/) }]);
    expect(await loadSettlement(t.db, m.id)).toMatchObject({ attempts: 4 });
  });

  it("counts transient failures before any send too (reading the record)", async () => {
    await seedMatch();
    const adapter = fakeAdapter();
    adapter.findFailures = [transient(), transient()];
    expect(await worker(adapter).runOnce()).toBe("settled");
    expect(sleeps).toEqual([2_000, 4_000]);
  });

  it("fails at once on a chain refusal, with the readable error", async () => {
    const m = await seedMatch();
    const adapter = fakeAdapter();
    adapter.script = [new SettlementFailure("program", "InsufficientDelegation (6026): Delegated amount is lower than the settlement amount", { code: 6026 })];
    // A refusal about delegation: both legs are re-checked to find the side at fault.
    // Covered before the send; the buyer revoked by the time the chain refused.
    let checks = 0;
    const coverage: CoverageChecker = {
      check: async (needs) => needs.map((n) => (checks++ >= 2 && n.wallet === m.buyer ? "delegated 0 < needed 250000000" : null)),
    };
    expect(await worker(adapter, { coverage: { "solana-devnet": coverage } }).runOnce()).toBe("failed");
    expect(sleeps).toEqual([]);
    expect(failures).toEqual([
      { matchId: m.id, fault: "buyer", reason: "InsufficientDelegation (6026): Delegated amount is lower than the settlement amount" },
    ]);
  });

  it("checks both delegations before settling: an uncovered order is marked stale and the match fails", async () => {
    const m = await seedMatch();
    const adapter = fakeAdapter();
    const coverage: CoverageChecker = { check: async (needs) => needs.map((n) => (n.wallet === m.seller ? "delegated 0 < needed 10" : null)) };
    expect(await worker(adapter, { coverage: { "solana-devnet": coverage } }).runOnce()).toBe("failed");
    expect(failures).toEqual([{ matchId: m.id, fault: "seller", reason: expect.stringMatching(/seller: delegated 0 < needed 10/) }]);
    expect(adapter.settleCalls).toEqual([]);
  });

  it("leaves matches of chains without an adapter pending", async () => {
    const m = await seedMatch();
    expect(await worker(fakeAdapter(), { adapters: {} }).runOnce()).toBe("idle");
    expect((await loadSettlement(t.db, m.id))?.matchStatus).toBe("pending");
  });
});

describe("settlement worker with the Solana adapter over a mocked RPC", () => {
  it("simulates, sends once and records the transaction; a second run sends nothing", async () => {
    const m = await seedMatch();
    const adapter = await SolanaSettlementAdapter.create({ rpc: w.rpc, operator: w.operator });
    const coverage = { "solana-devnet": solanaCoverageChecker(w.rpc, PROGRAM_ID) };
    expect(await worker(adapter, { coverage }).runOnce()).toBe("settled");
    expect(w.rpc.calls.filter((c) => c === "simulate" || c === "send")).toEqual(["simulate", "send"]);
    expect(await loadSettlement(t.db, m.id)).toMatchObject({ status: "confirmed", txHash: "TEST-SIG-1", attempts: 1 });
    // The match is settled: a second run has nothing to do and sends nothing.
    expect(await worker(adapter, { coverage }).runOnce()).toBe("idle");
    expect(w.rpc.sent).toHaveLength(1);
    expect((await loadOrder(t.db, m.sellOrderId))?.settledQuantity).toBe(10n);
  });

  it("puts the fault on the seller when its on-chain delegation was revoked, and sends nothing", async () => {
    await seedMatch();
    w.setTokens(w.asset, w.seller.publicKey, 900n, 0n);
    const adapter = await SolanaSettlementAdapter.create({ rpc: w.rpc, operator: w.operator });
    const r = await worker(adapter, { coverage: { "solana-devnet": solanaCoverageChecker(w.rpc, PROGRAM_ID) } }).runOnce();
    expect(r).toBe("failed");
    expect(failures.map((f) => f.fault)).toEqual(["seller"]);
    expect(w.rpc.sent).toEqual([]);
  });

  it("maps a refused simulation to a failed match with the program's error, and sends nothing", async () => {
    const m = await seedMatch();
    w.rpc.simulateResults = [{ err: { InstructionError: [0, { Custom: 6031 }] }, logs: [] }];
    const adapter = await SolanaSettlementAdapter.create({ rpc: w.rpc, operator: w.operator });
    expect(await worker(adapter).runOnce()).toBe("failed");
    expect(failures).toEqual([{ matchId: m.id, fault: "none", reason: expect.stringMatching(/^ZeroSellerProceeds \(6031\)/) }]);
    expect(w.rpc.sent).toEqual([]);
  });
});

describe("a match that fails after both orders were filled (real OrderService)", () => {
  async function serviceAndWorker(coverage: CoverageChecker, adapter: SettlementAdapter = fakeAdapter()) {
    const service = await OrderService.start({
      db: t.db,
      clock: now,
      newOrderId: randomUUID,
      newMatchId: randomMatchId,
      settlementMarginSecs: 60,
      maxOpenOrdersPerWallet: 50,
      onFatal: (e) => {
        throw e;
      },
    });
    const wk = worker(adapter, {
      coverage: { "solana-devnet": coverage },
      failMatch: (f) => service.failMatch(f),
    });
    return { service, wk };
  }
  const reversals = async (matchId: string) =>
    (
      await t.pglite.query<{ order_id: string; kind: string; fault: string; quantity: string }>(
        "select order_id::text, kind::text, fault::text, quantity::text from public.match_reversals where match_id = $1 order by kind",
        [matchId],
      )
    ).rows;

  it("seller at fault: the buyer's quantity returns to the book, the seller's is voided, with one audit row each", async () => {
    const m = await seedMatch();
    const sellerOut: CoverageChecker = { check: async (needs) => needs.map((n) => (n.wallet === m.seller ? "delegated 0 < needed 10" : null)) };
    const { service, wk } = await serviceAndWorker(sellerOut);
    expect(await wk.runOnce()).toBe("failed");

    expect(await loadSettlement(t.db, m.id)).toMatchObject({ matchStatus: "failed", status: "failed" });
    expect(await reversals(m.id)).toEqual([
      { order_id: m.buyOrderId, kind: "released", fault: "seller", quantity: "10" },
      { order_id: m.sellOrderId, kind: "voided", fault: "seller", quantity: "10" },
    ]);
    // filled_quantity never decreased; the buy is open again, the sell is stale.
    expect(await loadOrder(t.db, m.buyOrderId)).toMatchObject({ status: "open", filledQuantity: 10n, releasedQuantity: 10n, voidedQuantity: 0n });
    expect(await loadOrder(t.db, m.sellOrderId)).toMatchObject({ status: "stale", filledQuantity: 10n, releasedQuantity: 0n, voidedQuantity: 10n, cancelReason: "stale" });
    expect((await service.book("solana-devnet", w.asset.toBase58())).body).toMatchObject({
      bids: [{ price: "25000000", quantity: "10", orders: 1 }],
      asks: [],
    });
    // The rebuilt engine after a restart holds the same state.
    const again = await OrderService.start({
      db: t.db,
      clock: now,
      newOrderId: randomUUID,
      newMatchId: randomMatchId,
      settlementMarginSecs: 60,
      maxOpenOrdersPerWallet: 50,
      onFatal: () => undefined,
    });
    expect(again.state()).toEqual(service.state());
  });

  it("the released quantity re-enters through matching: it trades with a resting order that now crosses it", async () => {
    const m = await seedMatch();
    // While the buy was out of the book, another seller rested at a crossing price.
    const resting = { id: randomUUID(), seq: ++seq, chain: "solana-devnet" as const, asset: w.asset.toBase58(), side: "sell" as const,
      quantity: 10n, lotSize: 1n, limitPrice: 24_000_000n, paymentAsset: w.usdt.toBase58(), wallet: "TEST-OTHER-SELLER",
      nonce: seq.toString(16).padStart(32, "0"), expiresAt: now() + 3600, intentVersion: 1, intentSignature: "TEST-SIGNATURE",
      filledQuantity: 0n, status: "open" as const };
    await asServiceRole(t.db, (tx) => insertOrder(tx, resting));
    const sellerOut: CoverageChecker = { check: async (needs) => needs.map((n) => (n.wallet === m.seller ? "revoked" : null)) };
    const { service } = await serviceAndWorker(sellerOut);
    const r = await service.failMatch({ match: m, fault: "seller", reason: "TEST: seller delegation revoked", attempts: 1 });
    expect(r.status).toBe(200);
    expect(r.body["matches"]).toEqual([expect.objectContaining({ sellOrderId: resting.id, buyOrderId: m.buyOrderId, price: "24000000", quantity: "10" })]);
    expect(await loadOrder(t.db, m.buyOrderId)).toMatchObject({ status: "filled", filledQuantity: 20n, releasedQuantity: 10n });
    expect(await loadOrder(t.db, resting.id)).toMatchObject({ status: "filled", filledQuantity: 10n });
    // The new match is pending for the worker.
    const pending = await t.pglite.query<{ status: string }>("select status::text from public.matches where sell_order = $1", [resting.id]);
    expect(pending.rows).toEqual([{ status: "pending" }]);
  });

  it("no attributable fault: both quantities are released but stay out of the book (stale), so they do not rematch", async () => {
    const m = await seedMatch();
    const fine: CoverageChecker = { check: async (needs) => needs.map(() => null) };
    const adapter = fakeAdapter();
    adapter.script = [new SettlementFailure("program", "ZeroSellerProceeds (6031): seller proceeds are zero", { code: 6031 })];
    const { service, wk } = await serviceAndWorker(fine, adapter);
    expect(await wk.runOnce()).toBe("failed");
    expect((await reversals(m.id)).map((r) => [r.kind, r.fault])).toEqual([["released", "none"], ["released", "none"]]);
    expect((await loadOrder(t.db, m.buyOrderId))?.status).toBe("stale");
    expect((await loadOrder(t.db, m.sellOrderId))?.status).toBe("stale");
    expect((await service.book("solana-devnet", w.asset.toBase58())).body).toMatchObject({ bids: [], asks: [] });
    expect(await wk.runOnce()).toBe("idle");
  });

  it("expired: both released; the order expiring with the match expires, a longer-lived one returns to the book", async () => {
    const m = await seedMatch({ expiresIn: 3600 });
    // Make the buy live longer than the match (the match expiry is the sell's).
    await t.pglite.query("alter table public.orders disable trigger orders_guard_update");
    await t.pglite.query("update public.orders set expires_at = expires_at + interval '1 day' where id = $1", [m.buyOrderId]);
    await t.pglite.query("alter table public.orders enable trigger orders_guard_update");
    const { service } = await serviceAndWorker({ check: async (needs) => needs.map(() => null) });
    expect((await service.failMatch({ match: m, fault: "expired", reason: "TEST: too close to expires_at", attempts: 0 })).status).toBe(200);
    expect(await loadOrder(t.db, m.sellOrderId)).toMatchObject({ status: "expired", cancelReason: "expired" });
    expect(await loadOrder(t.db, m.buyOrderId)).toMatchObject({ status: "open", releasedQuantity: 10n });
  });
});

