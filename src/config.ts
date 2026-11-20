import { EVM_CHAIN_IDS, isEvmChainId, type EvmChainId } from "./evm/settings.ts";

/**
 * Order service configuration: environment variables only (no config file, no
 * defaults for secrets). See `.env.example`. TESTNET ONLY.
 *
 * Secrets are server-only. `DATABASE_URL` holds the database password; the Supabase
 * service role key is not used by this service (it connects to Postgres directly and
 * switches to `service_role` per transaction). The service refuses to start when a
 * `NEXT_PUBLIC_*` variable (which Next.js ships to browsers) looks like, or contains,
 * a server secret.
 */

export interface ServiceConfig {
  /** Postgres connection string (direct or session mode, never the 6543 pooler). Secret. */
  databaseUrl: string;
  host: string;
  port: number;
  /** Request body limit, bytes. */
  maxBodyBytes: number;
  /** Non-terminal, unexpired orders one wallet may have on one chain. */
  maxOpenOrdersPerWallet: number;
  /** An order is matchable only while it has more than this left before expiry. */
  settlementMarginSecs: number;
  /** How often expired orders are swept from the books and marked expired. */
  expirySweepSecs: number;
  /** How often chains and listings are re-read (listing status, minimums). */
  marketRefreshSecs: number;
  /** Solana devnet RPC (may hold an API key: never logged). Devnet is enforced by genesis hash. */
  solanaRpcUrl: string;
  /** On-chain delegate checks before matching and settling (spec §3.5). */
  delegateCheck: boolean;
  /** The settlement worker runs in this process (it needs the operator keypair). */
  workerEnabled: boolean;
  /** Path of the settlement operator's keypair file, outside the repository (mode 600). */
  operatorKeypairPath: string | null;
  workerPollSecs: number;
  workerMaxAttempts: number;
  /** A settlement is sent only if it can land at least this long before expires_at. */
  settleDeadlineMarginSecs: number;
  /** EVM testnets the worker settles on (and checks allowances on); empty = none. */
  evmSettlementChains: EvmChainId[];
  /** Path of the EVM operator's encrypted Foundry keystore, outside the repository. */
  evmOperatorKeystore: string | null;
  /** Its password. Secret. */
  evmOperatorKeystorePassword: string | null;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

type Env = Readonly<Record<string, string | undefined>>;

const SECRET_NAME = /SERVICE_ROLE|SECRET|PASSWORD|PRIVATE|DATABASE_URL|OPERATOR|KEYPAIR|KEYSTORE|JWT/i;

/** EVM RPC variables (same names as niara-contracts' .env); a private URL may carry an API key. */
const EVM_RPC_VARS = ["BASE_SEPOLIA_RPC_URL", "ROBINHOOD_TESTNET_RPC_URL", "TEMPO_TESTNET_RPC_URL", "HYPEREVM_TESTNET_RPC_URL"] as const;
const PUBLIC_RPCS = new Set([
  "https://api.devnet.solana.com",
  "https://sepolia.base.org",
  "https://rpc.testnet.chain.robinhood.com",
  "https://rpc.moderato.tempo.xyz",
  "https://rpc.hyperliquid-testnet.xyz/evm",
]);

/** Every variable whose value is a password (the EVM operator's and the e2e wallets' keystores). */
function passwordValues(env: Env): string[] {
  return Object.entries(env)
    .filter(([name, v]) => /PASSWORD/i.test(name) && !name.startsWith("NEXT_PUBLIC_") && v)
    .map(([, v]) => v!);
}

function privateRpcValues(env: Env): string[] {
  return ["SOLANA_RPC_URL", ...EVM_RPC_VARS].map((n) => env[n] ?? "").filter((v) => v && !PUBLIC_RPCS.has(v));
}

function int(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^[0-9]+$/.test(raw)) throw new ConfigError(`${name} must be a whole number`);
  const v = Number(raw);
  if (v < min || v > max) throw new ConfigError(`${name} must be between ${min} and ${max}`);
  return v;
}

function checkDatabaseUrl(raw: string | undefined): string {
  if (!raw) throw new ConfigError("DATABASE_URL is required");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError("DATABASE_URL is not a URL");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new ConfigError("DATABASE_URL must be a postgres:// or postgresql:// URL");
  }
  if (url.port === "6543") {
    throw new ConfigError(
      "DATABASE_URL uses port 6543 (Supabase transaction pooler), which cannot hold the single-instance " +
        "advisory lock: use the direct or session-mode connection (port 5432)",
    );
  }
  return raw;
}

/** Refuses any NEXT_PUBLIC_* variable that names or carries a server secret. */
function checkNoPublicSecrets(env: Env, secrets: readonly string[]): void {
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith("NEXT_PUBLIC_")) continue;
    if (SECRET_NAME.test(name)) {
      throw new ConfigError(`${name}: server secrets must never be NEXT_PUBLIC_* variables`);
    }
    if (value && secrets.some((s) => s.length >= 8 && value.includes(s))) {
      throw new ConfigError(`${name} contains a server secret (database URL, password or service key)`);
    }
  }
}

export function loadConfig(env: Env = process.env): ServiceConfig {
  const databaseUrl = checkDatabaseUrl(env["DATABASE_URL"]);
  const password = decodeURIComponent(new URL(databaseUrl).password);
  // A private RPC URL can carry an API key; the public RPCs are not secrets.
  checkNoPublicSecrets(env, [databaseUrl, password, env["SUPABASE_SERVICE_ROLE_KEY"] ?? "", ...privateRpcValues(env), ...passwordValues(env)]);
  return {
    databaseUrl,
    host: env["HOST"] || "127.0.0.1",
    port: int(env, "PORT", 8787, 1, 65535),
    maxBodyBytes: int(env, "MAX_BODY_BYTES", 16 * 1024, 1024, 1024 * 1024),
    maxOpenOrdersPerWallet: int(env, "MAX_OPEN_ORDERS_PER_WALLET", 50, 1, 10_000),
    settlementMarginSecs: int(env, "SETTLEMENT_MARGIN_SECS", 60, 0, 86_400),
    expirySweepSecs: int(env, "EXPIRY_SWEEP_SECS", 30, 1, 3_600),
    marketRefreshSecs: int(env, "MARKET_REFRESH_SECS", 60, 1, 86_400),
    solanaRpcUrl: rpcUrl(env["SOLANA_RPC_URL"]),
    delegateCheck: bool(env, "DELEGATE_CHECK", true),
    ...workerConfig(env),
    ...evmConfig(env),
  };
}

function evmConfig(env: Env) {
  const raw = (env["EVM_SETTLEMENT_CHAINS"] ?? "").trim();
  const chains = raw === "" ? [] : raw.split(",").map((c) => c.trim());
  for (const c of chains) {
    if (!isEvmChainId(c)) throw new ConfigError(`EVM_SETTLEMENT_CHAINS: unknown EVM chain ${c} (one of ${EVM_CHAIN_IDS.join(", ")})`);
  }
  const keystore = env["EVM_OPERATOR_KEYSTORE"] || null;
  const password = env["EVM_OPERATOR_KEYSTORE_PASSWORD"] || null;
  if (chains.length > 0 && bool(env, "WORKER_ENABLED", true) && (!keystore || !password)) {
    throw new ConfigError("EVM_SETTLEMENT_CHAINS is set but EVM_OPERATOR_KEYSTORE or EVM_OPERATOR_KEYSTORE_PASSWORD is not");
  }
  for (const name of EVM_RPC_VARS) {
    const v = env[name];
    if (v && !/^https?:\/\//.test(v)) throw new ConfigError(`${name} must be an http(s) URL`);
  }
  return {
    evmSettlementChains: [...new Set(chains)] as EvmChainId[],
    evmOperatorKeystore: keystore,
    evmOperatorKeystorePassword: password,
  };
}

function workerConfig(env: Env) {
  const workerEnabled = bool(env, "WORKER_ENABLED", true);
  const operatorKeypairPath = env["SOLANA_OPERATOR_KEYPAIR"] || null;
  if (workerEnabled && !operatorKeypairPath) {
    throw new ConfigError("WORKER_ENABLED is on but SOLANA_OPERATOR_KEYPAIR is not set (or set WORKER_ENABLED=off)");
  }
  return {
    workerEnabled,
    operatorKeypairPath,
    workerPollSecs: int(env, "WORKER_POLL_SECS", 5, 1, 3_600),
    workerMaxAttempts: int(env, "WORKER_MAX_ATTEMPTS", 6, 1, 20),
    settleDeadlineMarginSecs: int(env, "SETTLE_DEADLINE_MARGIN_SECS", 90, 30, 3_600),
  };
}

function rpcUrl(raw: string | undefined): string {
  if (!raw) return "https://api.devnet.solana.com";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError("SOLANA_RPC_URL is not a URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new ConfigError("SOLANA_RPC_URL must be http(s)");
  return raw;
}

function bool(env: Env, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (raw === "on" || raw === "true" || raw === "1") return true;
  if (raw === "off" || raw === "false" || raw === "0") return false;
  throw new ConfigError(`${name} must be on or off`);
}

/**
 * The configuration as safe to log: no part of the database URL (user, host, port,
 * database, password) and no RPC URL, which may hold an API key.
 */
export function describeConfig(c: ServiceConfig): Record<string, string | number | boolean | null> {
  const { databaseUrl: _db, solanaRpcUrl, evmOperatorKeystorePassword: pw, evmSettlementChains, ...rest } = c;
  return {
    ...rest,
    evmSettlementChains: evmSettlementChains.join(",") || "(none)",
    evmOperatorKeystorePassword: pw ? "(set, not shown)" : null,
    databaseUrl: "(set, not shown)",
    solanaRpcUrl: solanaRpcUrl === "https://api.devnet.solana.com" ? solanaRpcUrl : "(custom, not shown)",
  };
}

/**
 * Removes every secret-bearing value from a text before it is logged: the database
 * URL and each of its parts, private Solana and EVM RPC URLs and their path/query (API
 * keys), every *PASSWORD* variable (keystore passwords), and the Supabase service role key. Error messages from drivers can quote any of them.
 */
export function redactSecrets(text: string, env: Readonly<Record<string, string | undefined>> = process.env): string {
  const secrets: string[] = [];
  for (const name of ["DATABASE_URL", "SOLANA_RPC_URL", ...EVM_RPC_VARS]) {
    const raw = env[name];
    if (!raw || PUBLIC_RPCS.has(raw)) continue;
    secrets.push(raw);
    try {
      const u = new URL(raw);
      secrets.push(
        decodeURIComponent(u.password),
        u.password,
        decodeURIComponent(u.username),
        u.username,
        u.host,
        u.hostname,
        u.pathname.length > 1 ? u.pathname : "",
        u.search,
        ...u.searchParams.values(),
      );
    } catch {
      // not a URL: the raw value is redacted
    }
  }
  if (env["SUPABASE_SERVICE_ROLE_KEY"]) secrets.push(env["SUPABASE_SERVICE_ROLE_KEY"]);
  secrets.push(...passwordValues(env));
  let out = text;
  for (const s of secrets.filter((x) => x.length >= 3).sort((a, b) => b.length - a.length)) out = out.split(s).join("***");
  return out;
}
