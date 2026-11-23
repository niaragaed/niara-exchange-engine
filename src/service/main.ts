import { randomUUID } from "node:crypto";
import { serve } from "@hono/node-server";
import { getConnInfo } from "@hono/node-server/conninfo";
import { ConfigError, describeConfig, loadConfig, redactSecrets } from "../config.ts";
import { connectPg } from "../db/pg.ts";
import { randomMatchId } from "../engine/random-id.ts";
import { solanaCoverageChecker } from "../solana/coverage.ts";
import { PROGRAM_ID } from "../solana/idl.ts";
import { connectDevnet } from "../solana/rpc.ts";
import { SolanaSettlementAdapter } from "../adapters/solana-adapter.ts";
import { EvmSettlementAdapter } from "../adapters/evm-adapter.ts";
import type { SettlementAdapter } from "../adapters/settlement-adapter.ts";
import type { ChainId } from "../chains.ts";
import { connectEvm, httpTransport, rpcUrlFor, type EvmClient } from "../evm/client.ts";
import { evmCoverageChecker } from "../evm/coverage.ts";
import { loadKeystoreSource } from "../evm/keystore.ts";
import { deployedChain, loadEvmSettings, type DeployedEvmChain } from "../evm/settings.ts";
import type { CoverageChecker } from "../solana/coverage.ts";
import { loadKeypairSource } from "../solana/keypair.ts";
import { SettlementWorker } from "../worker/worker.ts";
import { createApp } from "./http.ts";
import { clientKey } from "./rate-limit.ts";
import { NotSingleInstanceError, OrderService, SchemaNotReadyError, ServiceRoleError } from "./order-service.ts";

/**
 * Order service entry point: `npm start` (node --env-file=.env src/service/main.ts)
 * locally; on Railway `node src/service/main.ts` (Dockerfile), with variables from the
 * service settings.
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
  const settledOn = ["solana-devnet", ...config.evmSettlementChains].join(", ");
  log("starting", { notice: `TESTNET ONLY: no real assets, no real money; settlement on ${settledOn}`, ...describeConfig(config) });

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
  // EVM testnets (chain id checked; the config file must mark each one reviewed).
  const evmSettings = loadEvmSettings();
  const evm: { chain: DeployedEvmChain; client: EvmClient }[] = [];
  for (const id of config.evmSettlementChains) {
    const chain = deployedChain(evmSettings, id, { requireReviewed: true });
    evm.push({ chain, client: await connectEvm(id, httpTransport(rpcUrlFor(id))) });
  }

  const coverage: Partial<Record<ChainId, CoverageChecker>> = {};
  if (config.delegateCheck) {
    coverage["solana-devnet"] = solanaCoverageChecker(solana, PROGRAM_ID);
    for (const e of evm) coverage[e.chain.chain] = evmCoverageChecker(e.client, e.chain.contracts.settlement);
  } else {
    log("delegate_check_disabled", { notice: "orders are matched without on-chain delegate checks" });
  }

  // The chains the worker holds an adapter for, set once the worker is built (GET /v1/markets).
  let settlementChains: ChainId[] = [];
  let service: OrderService;
  try {
    service = await OrderService.start({
      settlementChains: () => settlementChains,
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
    if (e instanceof NotSingleInstanceError || e instanceof ServiceRoleError || e instanceof SchemaNotReadyError) {
      die("refused_to_start", e);
    }
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

  const app = createApp(service, {
    maxBodyBytes: config.maxBodyBytes,
    corsOrigins: config.corsOrigins,
    rateLimit: {
      readsPerMinute: config.rateLimitReadsPerMin,
      writesPerMinute: config.rateLimitWritesPerMin,
      // Railway: its edge's X-Real-IP; locally: the TCP peer. Never X-Forwarded-For.
      key: (c) => clientKey(config.trustProxy, c.req.header("x-real-ip"), getConnInfo(c).remote.address),
    },
    log,
  });
  const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) =>
    log("listening", { host: info.address, port: info.port }),
  );

  // Settlement worker: in this process, so the advisory lock makes it the only one.
  let worker: SettlementWorker | undefined;
  if (config.workerEnabled && config.solanaOperatorKeypair) {
    // From a file (local) or SOLANA_OPERATOR_KEYPAIR_JSON (Railway); never logged.
    const operator = loadKeypairSource(config.solanaOperatorKeypair, "settlement operator");
    const adapters: Partial<Record<ChainId, SettlementAdapter>> = {
      "solana-devnet": await SolanaSettlementAdapter.create({ rpc: solana, operator }),
    };
    log("worker_starting", { chain: "solana-devnet", operator: operator.publicKey.toBase58() });
    if (evm.length > 0) {
      // The EVM operator: decrypted once, in memory only; its key and password are never logged.
      const evmOperator = loadKeystoreSource(config.evmOperatorKeystore!, config.evmOperatorKeystorePassword!, "EVM settlement operator");
      for (const e of evm) {
        adapters[e.chain.chain] = await EvmSettlementAdapter.create({ client: e.client, settings: e.chain, operator: evmOperator });
        log("worker_starting", { chain: e.chain.chain, operator: evmOperator.address });
      }
    }
    settlementChains = Object.keys(adapters) as ChainId[];
    worker = new SettlementWorker({
      db,
      adapters,
      coverage,
      failMatch: (failed) => service.failMatch(failed),
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
