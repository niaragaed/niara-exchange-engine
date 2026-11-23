/**
 * Waiting for the single-instance lock during a redeploy. TESTNET ONLY.
 *
 * Railway starts the new deployment while the previous one still runs, and stops the
 * previous one only once the new one passes its healthcheck. The previous one holds
 * the Postgres advisory lock until it stops, so a new instance that refused to start
 * on a taken lock would fail every redeploy. Instead it waits in standby (its /health
 * answers "standby", the API 503) and starts as soon as the lock is free, for at most
 * `waitMs`; with `waitMs` 0 a taken lock refuses the start at once (the local default).
 *
 * This never lets two instances serve: the lock is still the only way to start.
 */
export interface LockWaitOptions<T> {
  /** One start attempt (OrderService.start): takes the lock or throws. */
  attempt: () => Promise<T>;
  /** True when the attempt failed only because another instance holds the lock. */
  lockBusy: (e: unknown) => boolean;
  waitMs: number;
  retryMs: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Called on the first busy attempt, then about every `reportEveryMs`. */
  onWaiting: (waitedMs: number) => void;
  reportEveryMs?: number;
  /** The process is shutting down: stop waiting. */
  stopped: () => boolean;
}

/** The started value, or null if the process began stopping while it waited. Other errors propagate. */
export async function startWhenLockFree<T>(o: LockWaitOptions<T>): Promise<T | null> {
  const since = o.now();
  const every = o.reportEveryMs ?? 30_000;
  let reported = -Infinity;
  for (;;) {
    if (o.stopped()) return null;
    try {
      return await o.attempt();
    } catch (e) {
      if (!o.lockBusy(e)) throw e;
      const waited = o.now() - since;
      if (waited + o.retryMs > o.waitMs) throw e;
      if (waited - reported >= every) {
        o.onWaiting(waited);
        reported = waited;
      }
    }
    await o.sleep(o.retryMs);
  }
}
