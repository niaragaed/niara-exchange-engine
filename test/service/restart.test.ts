import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asServiceRole, loadMatches, loadOpenOrders, loadOrder } from "../../src/db/repository.ts";
import type { MatchingEngine } from "../../src/engine/engine.ts";
import { persistEvents, persistPlacement } from "../../src/service/persist.ts";
import { rebuildEngine } from "../../src/service/rebuild.ts";
import type { Catalog } from "../../src/service/catalog.ts";
import { resetData, startPglite, type TestDb } from "../db/pglite.ts";
import { CHAIN_MIN, LOT, MARGIN, MARKETS, QUOTE, apply, commandArb, type Command, type Context, type Sink } from "../engine/commands.ts";
import { seededUuidV4 } from "../engine/helpers.ts";

/**
 * Step 3 proof, through the real migrations on PGlite: run random commands through the
 * engine and persist every outcome as the service does; restart (a new engine rebuilt
 * from the database only); the rebuilt state must equal the state before the restart,
 * and both engines must then answer the same commands identically.
 */

let t: TestDb;

async function seed(): Promise<void> {
  await resetData(t.pglite);
  for (const chain of Object.keys(QUOTE) as (keyof typeof QUOTE)[]) {
    await t.pglite.query(
      `update public.chains set settlement_program = $2, quote_asset = $3, min_order_notional = $4 where id = $1`,
      [
        chain,
        chain === "solana-devnet" ? "TEST-PROGRAM" : "0x00000000000000000000000000000000005E7701",
        QUOTE[chain],
        CHAIN_MIN[chain].toString(),
      ],
    );
  }
  for (const m of MARKETS) {
    // EVM listings stored lowercase on purpose: the service must keep the stored spelling.
    const stored = m.chain === "base-sepolia" ? m.asset.toLowerCase() : m.asset;
    await t.pglite.query(
      `insert into public.listings (chain_id, asset, issuer, asset_class, status, cashback_eligible, doc_hash,
         asset_decimals, lot_size) values ($1, $2, 'TEST-ISSUER', 'equity', 'approved', true, repeat('ab', 32), 0, $3)`,
      [m.chain, stored, LOT.toString()],
    );
  }
}

let nonceCounter = 0;

function dbSink(engine: () => MatchingEngine, catalog: () => Catalog): Sink {
  return {
    placed: (result) =>
      asServiceRole(t.db, (tx) =>
        persistPlacement(tx, engine(), catalog(), result, {
          nonce: (++nonceCounter).toString(16).padStart(32, "0"),
          intentVersion: 1,
          intentSignature: "TEST-SIGNATURE",
        }),
      ),
    changed: (events) => {
      // Wallet cancellations carry the wallet's signature (labeled test value here).
      const signatures = new Map<string, string>();
      for (const e of events) if (e.type === "order_cancelled" && e.reason === "by_wallet") signatures.set(e.orderId, "TEST-CANCEL-SIGNATURE");
      return asServiceRole(t.db, (tx) => persistEvents(tx, engine(), events, new Set(), signatures));
    },
  };
}

beforeAll(async () => {
  t = await startPglite();
});

afterAll(async () => {
  await t.pglite.close();
});

describe("restart from the database (PGlite, real migrations)", () => {
  it("rebuilds an engine whose state equals the state before the restart, then behaves identically", async () => {
    const prefixArb = fc.array(commandArb, { minLength: 1, maxLength: 40 });
    const tailArb = fc.array(commandArb, { minLength: 1, maxLength: 25 });
    await fc.assert(
      fc.asyncProperty(prefixArb, tailArb, fc.nat(), async (prefix: Command[], tail: Command[], s: number) => {
        await seed();
        // The schema requires expires_at > created_at (the real now): each run's clock starts now.
        const start = Math.floor(Date.now() / 1000);
        let matchIds = seededUuidV4(s);
        const boot = await rebuildEngine(t.db, { newMatchId: () => matchIds(), settlementMarginSecs: MARGIN });
        const before = boot.engine;
        const ctx: Context = { now: start, placed: [], newOrderId: seededUuidV4(s + 1_000_000) };
        const sink = dbSink(() => before, () => boot.catalog);
        for (const c of prefix) await apply(before, c, ctx, sink);

        // The database holds exactly the engine's view of every order.
        for (const input of ctx.placed) {
          const view = before.getOrder(input.id)!;
          const row = (await loadOrder(t.db, input.id))!;
          expect([row.seq, row.filledQuantity, row.status]).toEqual([view.seq, view.filledQuantity, view.status]);
        }

        // Restart: a new engine from the database only.
        matchIds = seededUuidV4(s + 2_000_000);
        const rebuilt = await rebuildEngine(t.db, { newMatchId: seededUuidV4(s + 2_000_000), settlementMarginSecs: MARGIN });
        const after = rebuilt.engine;
        expect(after.exportState()).toEqual(before.exportState());

        // Same commands on both: identical outputs. Only the rebuilt engine persists.
        const tailIds = s + 3_000_000;
        const ctxBefore: Context = { now: ctx.now, placed: [...ctx.placed], newOrderId: seededUuidV4(tailIds) };
        const ctxAfter: Context = { now: ctx.now, placed: [...ctx.placed], newOrderId: seededUuidV4(tailIds) };
        const live = new Set(before.exportState().orders.map((o) => o.id));
        const afterSink = dbSink(() => after, () => rebuilt.catalog);
        for (const c of tail) {
          const a = (await apply(before, c, ctxBefore)) as { reason?: string } | null;
          const b = (await apply(after, c, ctxAfter, afterSink)) as { reason?: string } | null;
          const target = c.kind === "cancel" ? ctxBefore.placed[c.pick % Math.max(ctxBefore.placed.length, 1)] : undefined;
          if (target && !live.has(target.id) && b?.reason === "unknown_order") {
            expect(["not_live", "not_owner"]).toContain(a?.reason);
            continue;
          }
          expect(b).toEqual(a);
        }
        expect(after.exportState()).toEqual(before.exportState());

        // A second restart after the tail still matches.
        const again = await rebuildEngine(t.db, { newMatchId: seededUuidV4(s + 4_000_000), settlementMarginSecs: MARGIN });
        expect(again.engine.exportState()).toEqual(after.exportState());
        const open = await loadOpenOrders(t.db);
        expect(open.map((o) => o.seq)).toEqual([...open.map((o) => o.seq)].sort((x, y) => x - y));
        const matches = await loadMatches(t.db);
        expect(matches.every((m) => m.status === "pending")).toBe(true);
      }),
      { numRuns: 15 },
    );
  }, 600_000);
});
