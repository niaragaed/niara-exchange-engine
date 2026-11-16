import type { SettlementAdapter } from "../adapters/settlement-adapter.ts";
import type { ChainId } from "../chains.ts";
import type { Database } from "../db/database.ts";
import { asServiceRole } from "../db/repository.ts";
import { nextMatchToSettle, setMatchStatus, writeSettlement, type MatchToSettle } from "../db/settlements.ts";
import type { Match } from "../engine/types.ts";
import { matchNeeds, type CoverageChecker } from "../solana/coverage.ts";
import { SettlementFailure } from "../solana/errors.ts";

/**
 * Settlement worker. TESTNET ONLY.
 *
 * Runs inside the order service process, so the service's single-instance advisory
 * lock makes it the only worker. It takes the oldest match still to settle (`pending`,
 * or `settling` after a crash), in `seq` order, one at a time, and for it:
 *
 * 1. asks the chain whether the match is already settled (replay guard): if so, records
 *    it confirmed with that transaction and sends nothing;
 * 2. fails it if `expires_at` has passed, or is too close to land a transaction before
 *    it (spec §2: a match never settles after `expiresAt`);
 * 3. checks both legs' on-chain delegations (spec §3.5): an uncovered order is marked
 *    stale and the match fails;
 * 4. sets `settling`, records the attempt, and calls the chain adapter;
 * 5. records the outcome: `settled` + `confirmed` with the tx hash, or `failed` with a
 *    readable error. Transient RPC errors are retried with an exponential, bounded
 *    backoff (`maxAttempts`), each retry starting again at step 1.
 *
 * Never twice: one worker (advisory lock), the record check before every send, the
 * adapter's own check, the program's `init` of `["settled", match_id]`, and the unique
 * `settlements.match_id`.
 */

export interface WorkerOptions {
  db: Database;
  adapters: Partial<Record<ChainId, SettlementAdapter>>;
  coverage?: Partial<Record<ChainId, CoverageChecker>>;
  /** OrderService.markStale: takes orders out of the live book. */
  markStale: (orderIds: string[]) => Promise<unknown>;
  /** Unix seconds. */
  clock: () => number;
  sleep: (ms: number) => Promise<void>;
  maxAttempts: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  /** A settlement is not sent unless it can land this long before expires_at. */
  deadlineMarginSecs: number;
  log?: (event: string, data?: Record<string, unknown>) => void;
}

export type WorkerResult = "idle" | "settled" | "already_settled" | "failed";

export class SettlementWorker {
  private readonly o: WorkerOptions;
  private running = false;
  private timer: NodeJS.Timeout | undefined;

  constructor(options: WorkerOptions) {
    if (options.maxAttempts < 1) throw new RangeError("maxAttempts must be at least 1");
    this.o = options;
  }

  private get chains(): ChainId[] {
    return Object.keys(this.o.adapters) as ChainId[];
  }

  /** Processes the next match to settle, to its end (retries included). */
  async runOnce(): Promise<WorkerResult> {
    const next = await asServiceRole(this.o.db, (tx) => nextMatchToSettle(tx, this.chains));
    if (!next) return "idle";
    return this.process(next);
  }

  /** Processes matches until none is left. */
  async drain(): Promise<WorkerResult[]> {
    const out: WorkerResult[] = [];
    for (;;) {
      const r = await this.runOnce();
      if (r === "idle") return out;
      out.push(r);
    }
  }

  start(pollMs: number): void {
    const tick = async () => {
      if (this.running) return;
      this.running = true;
      try {
        await this.drain();
      } catch (e) {
        this.o.log?.("worker_error", { error: e instanceof Error ? e.message : String(e) });
      } finally {
        this.running = false;
      }
    };
    this.timer = setInterval(() => void tick(), pollMs);
    void tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async process(next: MatchToSettle): Promise<WorkerResult> {
    const { match } = next;
    const adapter = this.o.adapters[match.chain];
    if (!adapter) throw new Error(`no adapter for ${match.chain}`);
    // `attempts`: sends handed to the chain (stored); `tries`: rounds of this run,
    // including those that failed before sending. Both bound the retries.
    let attempts = next.attempts;
    let tries = 0;
    let lastError = "";

    for (;;) {
      tries += 1;
      try {
        // 1. Already settled on-chain? (Also after a crash in the middle of a send.)
        const existing = await adapter.findSettlement(match);
        if (existing) return this.confirm(match, attempts, existing, true);

        // 2. Expiry.
        const now = this.o.clock();
        if (now >= match.expiresAt) return this.fail(match, attempts, "expired before settlement (expires_at has passed)");
        if (match.expiresAt - now < this.o.deadlineMarginSecs) {
          return this.fail(match, attempts, `too close to expires_at to settle in time (< ${this.o.deadlineMarginSecs} s left)`);
        }

        // 3. Both legs still delegated and funded (spec §3.5).
        const checker = this.o.coverage?.[match.chain];
        if (checker) {
          const needs = matchNeeds(match);
          const [seller, buyer] = await checker.check([needs.seller, needs.buyer]);
          const stale = [...(seller ? [match.sellOrderId] : []), ...(buyer ? [match.buyOrderId] : [])];
          if (stale.length > 0) {
            await this.o.markStale(stale);
            const why = [seller && `seller: ${seller}`, buyer && `buyer: ${buyer}`].filter(Boolean).join("; ");
            return this.fail(match, attempts, `delegation no longer covers the match (${why}); order marked stale`);
          }
        }

        // 4. Send.
        attempts += 1;
        await asServiceRole(this.o.db, async (tx) => {
          await setMatchStatus(tx, match.id, "settling");
          await writeSettlement(tx, { matchId: match.id, chain: match.chain, status: "submitted", attempts, txHash: null, error: null });
        });
        this.o.log?.("settle_attempt", { matchId: match.id, attempt: attempts });
        const outcome = await adapter.settle(match);
        return this.confirm(match, attempts, outcome.txHash, outcome.alreadySettled);
      } catch (e) {
        const failure = e instanceof SettlementFailure ? e : null;
        lastError = e instanceof Error ? e.message : String(e);
        // Unknown exceptions are treated as transient: bounded retries, then a final check.
        if (failure && !failure.transient) return this.fail(match, attempts, lastError);
        if (tries >= this.o.maxAttempts || attempts >= this.o.maxAttempts) {
          return this.giveUp(adapter, match, attempts, lastError);
        }
        await asServiceRole(this.o.db, (tx) =>
          writeSettlement(tx, { matchId: match.id, chain: match.chain, status: "pending", attempts, txHash: null, error: lastError }),
        );
        const delay = Math.min(this.o.backoffMaxMs, this.o.backoffBaseMs * 2 ** (tries - 1));
        this.o.log?.("settle_retry", { matchId: match.id, attempts, tries, delayMs: delay, error: lastError });
        await this.o.sleep(delay);
      }
    }
  }

  /** After the last attempt: settled anyway (an ambiguous send that landed)? Else failed. */
  private async giveUp(adapter: SettlementAdapter, match: Match, attempts: number, lastError: string): Promise<WorkerResult> {
    try {
      const existing = await adapter.findSettlement(match);
      if (existing) return this.confirm(match, attempts, existing, true);
    } catch {
      // Unknown: leave the match `settling` for the next run rather than fail it blindly.
      this.o.log?.("settle_unknown", { matchId: match.id, attempts, error: lastError });
      await asServiceRole(this.o.db, (tx) =>
        writeSettlement(tx, { matchId: match.id, chain: match.chain, status: "pending", attempts, txHash: null, error: lastError }),
      );
      throw new Error(`match ${match.id}: chain unreachable after ${attempts} attempts; will retry on the next run`);
    }
    return this.fail(match, attempts, `gave up after ${attempts} attempts: ${lastError}`);
  }

  private async confirm(match: Match, attempts: number, txHash: string, already: boolean): Promise<WorkerResult> {
    await asServiceRole(this.o.db, async (tx) => {
      await writeSettlement(tx, { matchId: match.id, chain: match.chain, status: "confirmed", attempts, txHash, error: null });
      await setMatchStatus(tx, match.id, "settled");
    });
    this.o.log?.("settled", { matchId: match.id, txHash, alreadySettled: already, attempts });
    return already ? "already_settled" : "settled";
  }

  private async fail(match: Match, attempts: number, error: string): Promise<WorkerResult> {
    await asServiceRole(this.o.db, async (tx) => {
      await writeSettlement(tx, { matchId: match.id, chain: match.chain, status: "failed", attempts, txHash: null, error });
      await setMatchStatus(tx, match.id, "failed");
    });
    this.o.log?.("settle_failed", { matchId: match.id, attempts, error });
    return "failed";
  }
}
