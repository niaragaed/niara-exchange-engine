import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { SettleOutcome, SettlementAdapter } from "../../src/adapters/settlement-adapter.ts";
import { SolanaSettlementAdapter } from "../../src/adapters/solana-adapter.ts";
import { asServiceRole, insertMatch, insertOrder, loadOrder } from "../../src/db/repository.ts";
import { loadSettlement } from "../../src/db/settlements.ts";
import { uuidToBytes } from "../../src/engine/ids.ts";
import type { Match } from "../../src/engine/types.ts";
import { pdas } from "../../src/solana/accounts.ts";
import type { CoverageChecker } from "../../src/solana/coverage.ts";
import { solanaCoverageChecker } from "../../src/solana/coverage.ts";
import { SettlementFailure } from "../../src/solana/errors.ts";
import { PROGRAM_ID } from "../../src/solana/idl.ts";
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
let staleCalls: string[][];
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
    markStale: async (ids) => {
      staleCalls.push(ids);
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
  staleCalls = [];
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
    const late = worker(adapter, { clock: () => now() + 3601 });
    expect(await late.runOnce()).toBe("failed");
    expect((await loadSettlement(t.db, expired.id))?.error).toMatch(/expired before settlement/);
    const close = await seedMatch({ expiresIn: 60 });
    expect(await worker(adapter).runOnce()).toBe("failed");
    expect((await loadSettlement(t.db, close.id))?.error).toMatch(/too close to expires_at/);
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
    const s = await loadSettlement(t.db, m.id);
    expect(s).toMatchObject({ matchStatus: "failed", status: "failed", attempts: 4 });
    expect(s?.error).toMatch(/gave up after 4 attempts: RPC: 429/);
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
    expect(await worker(adapter).runOnce()).toBe("failed");
    expect(sleeps).toEqual([]);
    expect(await loadSettlement(t.db, m.id)).toMatchObject({
      status: "failed",
      attempts: 1,
      error: "InsufficientDelegation (6026): Delegated amount is lower than the settlement amount",
    });
  });

  it("checks both delegations before settling: an uncovered order is marked stale and the match fails", async () => {
    const m = await seedMatch();
    const adapter = fakeAdapter();
    const coverage: CoverageChecker = { check: async (needs) => needs.map((n) => (n.wallet === m.seller ? "delegated 0 < needed 10" : null)) };
    expect(await worker(adapter, { coverage: { "solana-devnet": coverage } }).runOnce()).toBe("failed");
    expect(staleCalls).toEqual([[m.sellOrderId]]);
    expect(adapter.settleCalls).toEqual([]);
    expect((await loadSettlement(t.db, m.id))?.error).toMatch(/seller: delegated 0 < needed 10.*marked stale/);
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
    // Even if the database row were reset to pending, the chain's record stops a second send.
    await t.pglite.query("update public.settlements set status = 'pending' where match_id = $1", [m.id]);
    await t.pglite.query("alter table public.matches disable trigger matches_guard_update");
    await t.pglite.query("update public.matches set status = 'pending' where id = $1", [m.id]);
    await t.pglite.query("alter table public.matches enable trigger matches_guard_update");
    w.rpc.signaturesFor.set(pdas().settlementRecord(uuidToBytes(m.id)).toBase58(), ["TEST-SIG-1"]);
    expect(await worker(adapter, { coverage }).runOnce()).toBe("already_settled");
    expect(w.rpc.sent).toHaveLength(1);
  });

  it("marks the seller's order stale when the on-chain delegation was revoked, and sends nothing", async () => {
    const m = await seedMatch();
    // The order service keeps a live remainder of this seller's order; here: just the match.
    w.setTokens(w.asset, w.seller.publicKey, 900n, 0n);
    const adapter = await SolanaSettlementAdapter.create({ rpc: w.rpc, operator: w.operator });
    const r = await worker(adapter, { coverage: { "solana-devnet": solanaCoverageChecker(w.rpc, PROGRAM_ID) } }).runOnce();
    expect(r).toBe("failed");
    expect(staleCalls).toEqual([[m.sellOrderId]]);
    expect(w.rpc.sent).toEqual([]);
    expect((await loadOrder(t.db, m.sellOrderId))?.status).toBe("filled");
  });

  it("maps a refused simulation to a failed match with the program's error, and sends nothing", async () => {
    const m = await seedMatch();
    w.rpc.simulateResults = [{ err: { InstructionError: [0, { Custom: 6031 }] }, logs: [] }];
    const adapter = await SolanaSettlementAdapter.create({ rpc: w.rpc, operator: w.operator });
    expect(await worker(adapter).runOnce()).toBe("failed");
    expect((await loadSettlement(t.db, m.id))?.error).toMatch(/^ZeroSellerProceeds \(6031\)/);
    expect(w.rpc.sent).toEqual([]);
  });
});
