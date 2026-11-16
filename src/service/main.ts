import { randomUUID } from "node:crypto";
import { serve } from "@hono/node-server";
import { ConfigError, describeConfig, loadConfig } from "../config.ts";
import { connectPg } from "../db/pg.ts";
import { randomMatchId } from "../engine/random-id.ts";
import { createApp } from "./http.ts";
import { NotSingleInstanceError, OrderService, ServiceRoleError } from "./order-service.ts";

/**
 * Order service entry point: `npm start` (node --env-file=.env src/service/main.ts).
 * TESTNET ONLY. Run exactly ONE instance: a second one finds the Postgres advisory lock
 * taken and exits. If the database connection drops, the lock is gone with it, so the
 * process exits and must be restarted (by the supervisor); it rebuilds its books from
 * the database on start.
 */

function log(event: string, data: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...data }));
}

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (e) {
    if (e instanceof ConfigError) {
      log("config_error", { error: e.message });
      process.exit(2);
    }
    throw e;
  }
  log("starting", { notice: "TESTNET ONLY: no real assets, no real money; matches are not settled", ...describeConfig(config) });

  let stopping = false;
  const die = (event: string, err: unknown): never => {
    log(event, { error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  };
  const db = await connectPg(config.databaseUrl, (err) => {
    if (!stopping) die("database_connection_lost", err);
  });

  let service: OrderService;
  try {
    service = await OrderService.start({
      db,
      clock: () => Math.floor(Date.now() / 1000),
      newOrderId: randomUUID,
      newMatchId: randomMatchId,
      settlementMarginSecs: config.settlementMarginSecs,
      maxOpenOrdersPerWallet: config.maxOpenOrdersPerWallet,
      onFatal: (err) => {
        // Engine and database may differ: exit; the restart rebuilds from the database.
        setImmediate(() => die("fatal_persist_failure", err));
      },
      log,
    });
  } catch (e) {
    if (e instanceof NotSingleInstanceError || e instanceof ServiceRoleError) die("refused_to_start", e);
    throw e;
  }

  const app = createApp(service, { maxBodyBytes: config.maxBodyBytes, log });
  const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) =>
    log("listening", { host: info.address, port: info.port }),
  );

  const timers = [
    setInterval(() => void service.sweepExpired(), config.expirySweepSecs * 1000),
    setInterval(() => void service.refreshMarkets(), config.marketRefreshSecs * 1000),
  ];

  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log("stopping", { signal });
    for (const t of timers) clearInterval(t);
    server.close(() => {
      // Closing the connection ends the session and releases the advisory lock.
      void db.close().finally(() => process.exit(0));
    });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((e: unknown) => {
  log("startup_failed", { error: e instanceof Error ? e.message : String(e) });
  process.exit(1);
});
