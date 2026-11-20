import type { SettlementAdapter } from "../adapters/settlement-adapter.ts";
import type { ChainId } from "../chains.ts";
import type { Database } from "../db/database.ts";
import { addSettledQuantity, asServiceRole } from "../db/repository.ts";
import { nextMatchToSettle, setMatchStatus, writeSettlement, type MatchToSettle } from "../db/settlements.ts";
import type { MatchFault } from "../engine/engine.ts";
import type { Match } from "../engine/types.ts";
import { matchNeeds, type CoverageChecker } from "../solana/coverage.ts";
import { SettlementFailure } from "../adapters/failure.ts";
import { EVM_COVERAGE_ERRORS } from "../evm/errors.ts";

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
 * 3. checks both legs' on-chain delegations (Solana) or allowances (EVM) and balances
 *    (spec §3.5): if one does not cover the match, the match fails with that side at fault;
 * 4. sets `settling`, records the attempt, and calls the chain adapter;
 * 5. records the outcome: `settled` + `confirmed` with the tx hash (and the match's
 *    quantity settled on both orders), or a failure. Transient RPC errors are retried
 *    with an exponential, bounded backoff (`maxAttempts`), each retry starting again
 *    at step 1.
 *
 * A failure goes to `failMatch` (OrderService.failMatch) with a fault: `expired`; the
 * side(s) whose delegation or balance does not cover the match (`seller`, `buyer`,
 * `both`; for a chain refusal about delegation or funds, both legs are re-checked to
 * find which); otherwise `none`. The innocent side's quantity returns to the book.
 *
 * Never twice: one worker (advisory lock), the record check before every send, the
 * adapter's own check, the program's `init` of `["settled", match_id]`, and the unique
 * `settlements.match_id`.
 */

export interface WorkerOptions {
  db: Database;
  adapters: Partial<Record<ChainId, SettlementAdapter>>;
  coverage?: Partial<Record<ChainId, CoverageChecker>>;
  /** OrderService.failMatch: fails the match and returns the innocent side's quantity. */
  failMatch: (failed: { match: Match; fault: MatchFault; reason: string; attempts: number }) => Promise<{ status: number }>;
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
        if (now >= match.expiresAt) {
          return this.fail(match, attempts, "expired before settlement (expires_at has passed)", "expired");
        }
        if (match.expiresAt - now < this.o.deadlineMarginSecs) {
          return this.fail(
            match,
            attempts,
            `too close to expires_at to settle in time (< ${this.o.deadlineMarginSecs} s left)`,
            "expired",
          );
        }

        // 3. Both legs still delegated and funded (spec §3.5).
        const uncovered = await this.uncovered(match);
        if (uncovered) {
          return this.fail(match, attempts, `delegation no longer covers the match (${uncovered.why})`, uncovered.fault);
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
        if (failure && !failure.transient) {
          // A refusal about delegation, allowance or funds: find the side at fault on-chain.
          // Solana: DelegateNotSet (6025), InsufficientDelegation (6026), or a token transfer
          // short of funds. EVM: the token's ERC20InsufficientAllowance/Balance, or
          // SafeERC20FailedOperation.
          const aboutCoverage =
            failure.code === 6025 ||
            failure.code === 6026 ||
            failure.errorName === "DelegateNotSet" ||
            failure.errorName === "InsufficientDelegation" ||
            (failure.errorName !== undefined && EVM_COVERAGE_ERRORS.has(failure.errorName)) ||
            /insufficient funds/i.test(lastError);
          const uncovered = aboutCoverage ? await this.uncovered(match).catch(() => null) : null;
          return this.fail(match, attempts, lastError, uncovered?.fault ?? "none");
        }
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
    return this.fail(match, attempts, `gave up after ${attempts} attempts: ${lastError}`, "none");
  }

  /** The side(s) whose on-chain delegation or balance does not cover the match, if any. */
  private async uncovered(match: Match): Promise<{ fault: "seller" | "buyer" | "both"; why: string } | null> {
    const checker = this.o.coverage?.[match.chain];
    if (!checker) return null;
    const needs = matchNeeds(match);
    const [seller, buyer] = await checker.check([needs.seller, needs.buyer]);
    if (!seller && !buyer) return null;
    const why = [seller && `seller: ${seller}`, buyer && `buyer: ${buyer}`].filter(Boolean).join("; ");
    return { fault: seller && buyer ? "both" : seller ? "seller" : "buyer", why };
  }

  private async confirm(match: Match, attempts: number, txHash: string, already: boolean): Promise<WorkerResult> {
    await asServiceRole(this.o.db, async (tx) => {
      await writeSettlement(tx, { matchId: match.id, chain: match.chain, status: "confirmed", attempts, txHash, error: null });
      await setMatchStatus(tx, match.id, "settled");
      await addSettledQuantity(tx, [match.buyOrderId, match.sellOrderId], match.quantity);
    });
    this.o.log?.("settled", { matchId: match.id, txHash, alreadySettled: already, attempts });
    return already ? "already_settled" : "settled";
  }

  private async fail(match: Match, attempts: number, error: string, fault: MatchFault): Promise<WorkerResult> {
    const r = await this.o.failMatch({ match, fault, reason: error, attempts });
    if (r.status !== 200) throw new Error(`match ${match.id}: could not record the failure (status ${r.status}); will retry`);
    this.o.log?.("settle_failed", { matchId: match.id, attempts, fault, error });
    return "failed";
  }
}
