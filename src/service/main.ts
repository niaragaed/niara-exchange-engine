import { randomUUID } from "node:crypto";
import { serve } from "@hono/node-server";
import { ConfigError, describeConfig, loadConfig, redactSecrets } from "../config.ts";
import { connectPg } from "../db/pg.ts";
import { randomMatchId } from "../engine/random-id.ts";
import { solanaCoverageChecker } from "../solana/coverage.ts";
import { PROGRAM_ID } from "../solana/idl.ts";
import { connectDevnet } from "../solana/rpc.ts";
import { SolanaSettlementAdapter } from "../adapters/solana-adapter.ts";
import { loadKeypairFile } from "../solana/keypair.ts";
import { SettlementWorker } from "../worker/worker.ts";
import { createApp } from "./http.ts";
import { NotSingleInstanceError, OrderService, ServiceRoleError } from "./order-service.ts";

/**
 * Order service entry point: `npm start` (node --env-file=.env src/service/main.ts).
 * TESTNET ONLY. Run exactly ONE instance: a second one finds the Postgres advisory lock
 * taken and exits. If the database connection drops, the lock is gone with it, so the
 * process exits and must be restarted (by the supervisor); it rebuilds its books from
 * the database on start.
 */

/** Every log line goes through redactSecrets: driver errors can quote the database URL. */
function log(event: string, data: Record<string, unknown> = {}): void {
  console.log(redactSecrets(JSON.stringify({ at: new Date().toISOString(), event, ...data })));
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
  log("starting", { notice: "TESTNET ONLY: no real assets, no real money; settlement on Solana devnet only", ...describeConfig(config) });

  let stopping = false;
  const die = (event: string, err: unknown): never => {
    log(event, { error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  };
  const db = await connectPg(config.databaseUrl, (err) => {
    if (!stopping) die("database_connection_lost", err);
  });

  // Solana devnet (genesis-checked): on-chain delegate checks (spec §3.5).
  const solana = await connectDevnet(config.solanaRpcUrl);
  const coverage = config.delegateCheck ? { "solana-devnet": solanaCoverageChecker(solana, PROGRAM_ID) } : {};
  if (!config.delegateCheck) log("delegate_check_disabled", { notice: "orders are matched without on-chain delegate checks" });

  let service: OrderService;
  try {
    service = await OrderService.start({
      db,
      clock: () => Math.floor(Date.now() / 1000),
      newOrderId: randomUUID,
      newMatchId: randomMatchId,
      settlementMarginSecs: config.settlementMarginSecs,
      maxOpenOrdersPerWallet: config.maxOpenOrdersPerWallet,
      coverage,
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

  const program = service.chainConfig("solana-devnet")?.settlementProgram;
  if (program !== PROGRAM_ID.toBase58()) {
    log("solana_program_mismatch", {
      notice: "chains.settlement_program for solana-devnet is not the IDL's program; run the listing sync",
      configured: program ?? null,
      idl: PROGRAM_ID.toBase58(),
    });
  }

  const app = createApp(service, { maxBodyBytes: config.maxBodyBytes, log });
  const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) =>
    log("listening", { host: info.address, port: info.port }),
  );

  // Settlement worker: in this process, so the advisory lock makes it the only one.
  let worker: SettlementWorker | undefined;
  if (config.workerEnabled && config.operatorKeypairPath) {
    const operator = loadKeypairFile(config.operatorKeypairPath, "settlement operator");
    const adapter = await SolanaSettlementAdapter.create({ rpc: solana, operator });
    log("worker_starting", { chain: "solana-devnet", operator: operator.publicKey.toBase58() });
    worker = new SettlementWorker({
      db,
      adapters: { "solana-devnet": adapter },
      coverage,
      markStale: (ids) => service.markStale(ids),
      clock: () => Math.floor(Date.now() / 1000),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      maxAttempts: config.workerMaxAttempts,
      backoffBaseMs: 2_000,
      backoffMaxMs: 60_000,
      deadlineMarginSecs: config.settleDeadlineMarginSecs,
      log,
    });
    worker.start(config.workerPollSecs * 1000);
  } else {
    log("worker_disabled", { notice: "matches stay pending: WORKER_ENABLED is off" });
  }

  const timers = [
    setInterval(() => void service.sweepExpired(), config.expirySweepSecs * 1000),
    setInterval(() => void service.refreshMarkets(), config.marketRefreshSecs * 1000),
  ];

  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log("stopping", { signal });
    for (const t of timers) clearInterval(t);
    worker?.stop();
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
