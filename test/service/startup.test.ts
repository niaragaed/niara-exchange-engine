import { describe, expect, it } from "vitest";
import { createStandbyApp } from "../../src/service/http.ts";
import { startWhenLockFree } from "../../src/service/startup.ts";

/** Waiting for the single-instance lock during a redeploy (simulated clock; no database). */

class Busy extends Error {}

function harness(busyAttempts: number, opts: { waitMs: number; failWith?: Error }) {
  let t = 0;
  let attempts = 0;
  const waited: number[] = [];
  let stopping = false;
  const run = () =>
    startWhenLockFree({
      attempt: async () => {
        attempts++;
        if (opts.failWith) throw opts.failWith;
        if (attempts <= busyAttempts) throw new Busy("lock taken");
        return "started";
      },
      lockBusy: (e) => e instanceof Busy,
      waitMs: opts.waitMs,
      retryMs: 2_000,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
      onWaiting: (ms) => waited.push(ms),
      reportEveryMs: 10_000,
      stopped: () => stopping,
    });
  return { run, attempts: () => attempts, waited, stop: () => (stopping = true) };
}

describe("startWhenLockFree", () => {
  it("starts at once when the lock is free", async () => {
    const h = harness(0, { waitMs: 600_000 });
    expect(await h.run()).toBe("started");
    expect(h.attempts()).toBe(1);
    expect(h.waited).toEqual([]);
  });

  it("waits while the previous instance holds the lock, reporting every so often, then starts", async () => {
    const h = harness(12, { waitMs: 600_000 });
    expect(await h.run()).toBe("started");
    expect(h.attempts()).toBe(13);
    expect(h.waited).toEqual([0, 10_000, 20_000]);
  });

  it("gives up after waitMs with the lock error; waitMs 0 refuses at once (the local default)", async () => {
    const h = harness(1_000, { waitMs: 10_000 });
    await expect(h.run()).rejects.toBeInstanceOf(Busy);
    expect(h.attempts()).toBe(6); // t = 0, 2, 4, 6, 8, 10 s; the next try would pass 10 s
    const local = harness(1, { waitMs: 0 });
    await expect(local.run()).rejects.toBeInstanceOf(Busy);
    expect(local.attempts()).toBe(1);
  });

  it("does not wait on any other error (schema, role, database)", async () => {
    const h = harness(0, { waitMs: 600_000, failWith: new Error("schema not ready") });
    await expect(h.run()).rejects.toThrow(/schema not ready/);
    expect(h.attempts()).toBe(1);
  });

  it("stops waiting when the process is shutting down", async () => {
    const h = harness(1_000, { waitMs: 600_000 });
    const p = h.run();
    h.stop();
    expect(await p).toBeNull();
  });
});

describe("standby app", () => {
  const SITE = "https://niaraglobal.com";
  const app = createStandbyApp({ corsOrigins: [SITE] });

  it("answers /health 200 standby (so the platform can retire the previous deployment)", async () => {
    const r = await app.request("/health", { headers: { origin: SITE } });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ status: "standby", testnet: true });
    expect(r.headers.get("access-control-allow-origin")).toBe(SITE);
  });

  it("answers every API path 503 starting with Retry-After, reads and writes alike", async () => {
    for (const [path, method] of [
      ["/v1/markets", "GET"],
      ["/v1/orders", "POST"],
      ["/v1/books/solana-devnet/x", "GET"],
    ] as const) {
      const r = await app.request(path, { method, headers: { origin: SITE } });
      expect(r.status, path).toBe(503);
      expect(r.headers.get("retry-after")).toBe("5");
      expect(r.headers.get("access-control-allow-origin")).toBe(SITE);
      expect(await r.json()).toMatchObject({ error: "starting" });
    }
  });
});
