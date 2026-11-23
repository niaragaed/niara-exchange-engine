import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { base58, base64, hex } from "@scure/base";
import { EVM_CHAIN_IDS, isEvmChainId, type EvmChainId } from "./evm/settings.ts";
import { describeKeySource, type KeySource } from "./key-source.ts";
import type { ProxyTrust } from "./service/rate-limit.ts";

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
  /**
   * Postgres connection string (direct or session mode, never the 6543 pooler), with
   * sslmode=verify-full and an absolute sslrootcert (by default the committed Supabase
   * CA, config/supabase-ca.crt). Secret.
   */
  databaseUrl: string;
  /** True when the server is verified against the committed config/supabase-ca.crt. */
  databaseCaCommitted: boolean;
  /** Where the service runs: `railway` when Railway's injected variables are present. */
  platform: "railway" | "local";
  /** Bind address: HOST, else 0.0.0.0 on Railway (its proxy must reach it), else 127.0.0.1. */
  host: string;
  /** PORT (Railway injects it), else 8787. */
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
  /**
   * The settlement operator's keypair: SOLANA_OPERATOR_KEYPAIR (path of a file outside
   * the repository, mode 600) or SOLANA_OPERATOR_KEYPAIR_JSON (its content). Secret.
   */
  solanaOperatorKeypair: KeySource | null;
  workerPollSecs: number;
  workerMaxAttempts: number;
  /** A settlement is sent only if it can land at least this long before expires_at. */
  settleDeadlineMarginSecs: number;
  /** EVM testnets the worker settles on (and checks allowances on); empty = none. */
  evmSettlementChains: EvmChainId[];
  /**
   * The EVM operator's encrypted Foundry keystore: EVM_OPERATOR_KEYSTORE (path, outside
   * the repository) or EVM_OPERATOR_KEYSTORE_JSON (its content).
   */
  evmOperatorKeystore: KeySource | null;
  /** Its password. Secret. */
  evmOperatorKeystorePassword: string | null;
  /**
   * Browser origins allowed to call the HTTP API (CORS), exact matches; empty = none.
   * Never `*`: the API is for the Niara site only.
   */
  corsOrigins: string[];
  /** Requests per minute per client IP: reads (GET, OPTIONS) and writes (POST, stricter). */
  rateLimitReadsPerMin: number;
  rateLimitWritesPerMin: number;
  /**
   * Where the client IP comes from: `railway` = the X-Real-IP header Railway's edge
   * sets (the default there, and the only value allowed there: every request reaches
   * the container from the proxy); `none` = the TCP peer (the local default).
   */
  trustProxy: ProxyTrust;
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

/** Variables that hold key material itself (hosted deployments, where no file can be uploaded). */
const KEY_JSON_VARS = ["SOLANA_OPERATOR_KEYPAIR_JSON", "EVM_OPERATOR_KEYSTORE_JSON"] as const;

/**
 * Every form in which a key variable's content could reach a log line: the raw text,
 * re-serialized JSON, and for a 64-byte Solana keypair its base58, hex and base64
 * encodings (whole key and 32-byte seed); for a keystore, each of its secret fields.
 */
function keyMaterialValues(env: Env): string[] {
  const out: string[] = [];
  for (const name of KEY_JSON_VARS) {
    const raw = env[name];
    if (!raw) continue;
    out.push(raw, raw.trim());
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    out.push(JSON.stringify(parsed), JSON.stringify(parsed, null, 2));
    if (Array.isArray(parsed) && parsed.length === 64 && parsed.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) {
      const bytes = Uint8Array.from(parsed as number[]);
      out.push(parsed.join(", "), parsed.join(","));
      for (const b of [bytes, bytes.subarray(0, 32)]) out.push(base58.encode(b), hex.encode(b), `0x${hex.encode(b)}`, base64.encode(b));
    } else if (parsed && typeof parsed === "object") {
      const crypto = (parsed as { crypto?: unknown; Crypto?: unknown }).crypto ?? (parsed as { Crypto?: unknown }).Crypto;
      const walk = (v: unknown): void => {
        if (typeof v === "string" && v.length >= 16) {
          const bare = v.replace(/^0x/i, "");
          out.push(v, bare, `0x${bare}`);
        }
        else if (v && typeof v === "object") Object.values(v).forEach(walk);
      };
      walk(crypto);
    }
  }
  return out.filter((v) => v !== "");
}

function int(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^[0-9]+$/.test(raw)) throw new ConfigError(`${name} must be a whole number`);
  const v = Number(raw);
  if (v < min || v > max) throw new ConfigError(`${name} must be between ${min} and ${max}`);
  return v;
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Supabase's root CA (public; the dashboard's Database settings, SSL), committed so no file has to be uploaded to a host. */
export const SUPABASE_CA_PATH = join(REPO_ROOT, "config", "supabase-ca.crt");

/**
 * TLS of the database connection: the server is always verified (sslmode=verify-full;
 * a weaker mode is refused, and an absent one is set). sslrootcert defaults to the
 * committed Supabase CA; a relative sslrootcert is resolved against the repository
 * (node-postgres would read it relative to the working directory).
 */
function withVerifiedTls(raw: string, url: URL): { databaseUrl: string; databaseCaCommitted: boolean } {
  const mode = url.searchParams.get("sslmode");
  if (mode !== null && mode !== "verify-full") {
    throw new ConfigError("DATABASE_URL: sslmode must be verify-full (or absent, then set): the server certificate is always verified");
  }
  const given = url.searchParams.get("sslrootcert");
  const ca = given ? (isAbsolute(given) ? given : resolve(REPO_ROOT, given)) : SUPABASE_CA_PATH;
  if (!existsSync(ca)) throw new ConfigError("DATABASE_URL: the sslrootcert file does not exist");
  if (mode === "verify-full" && given === ca) return { databaseUrl: raw, databaseCaCommitted: ca === SUPABASE_CA_PATH };
  url.searchParams.set("sslmode", "verify-full");
  url.searchParams.set("sslrootcert", ca);
  return { databaseUrl: url.toString(), databaseCaCommitted: ca === SUPABASE_CA_PATH };
}

function checkDatabaseUrl(raw: string | undefined): { databaseUrl: string; databaseCaCommitted: boolean } {
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
  return withVerifiedTls(raw, url);
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
  const { databaseUrl, databaseCaCommitted } = checkDatabaseUrl(env["DATABASE_URL"]);
  const password = decodeURIComponent(new URL(databaseUrl).password);
  // A private RPC URL can carry an API key; the public RPCs are not secrets.
  checkNoPublicSecrets(env, [
    databaseUrl,
    password,
    env["SUPABASE_SERVICE_ROLE_KEY"] ?? "",
    ...privateRpcValues(env),
    ...passwordValues(env),
    ...keyMaterialValues(env),
  ]);
  const platform = onRailway(env) ? "railway" : "local";
  return {
    databaseUrl,
    databaseCaCommitted,
    platform,
    host: listenHost(env["HOST"], platform),
    port: int(env, "PORT", 8787, 1, 65535),
    maxBodyBytes: int(env, "MAX_BODY_BYTES", 16 * 1024, 1024, 1024 * 1024),
    maxOpenOrdersPerWallet: int(env, "MAX_OPEN_ORDERS_PER_WALLET", 50, 1, 10_000),
    settlementMarginSecs: int(env, "SETTLEMENT_MARGIN_SECS", 60, 0, 86_400),
    expirySweepSecs: int(env, "EXPIRY_SWEEP_SECS", 30, 1, 3_600),
    marketRefreshSecs: int(env, "MARKET_REFRESH_SECS", 60, 1, 86_400),
    solanaRpcUrl: rpcUrl(env["SOLANA_RPC_URL"]),
    delegateCheck: bool(env, "DELEGATE_CHECK", true),
    corsOrigins: corsOrigins(env["CORS_ORIGINS"]),
    rateLimitReadsPerMin: int(env, "RATE_LIMIT_READS_PER_MIN", 300, 1, 100_000),
    rateLimitWritesPerMin: int(env, "RATE_LIMIT_WRITES_PER_MIN", 30, 1, 10_000),
    trustProxy: trustProxy(env["TRUST_PROXY"], platform),
    ...workerConfig(env),
    ...evmConfig(env),
  };
}

/** Railway injects these into every deployment (and `railway run`). */
const RAILWAY_VARS = ["RAILWAY_ENVIRONMENT_ID", "RAILWAY_PROJECT_ID", "RAILWAY_SERVICE_ID"] as const;

export function onRailway(env: Env): boolean {
  return RAILWAY_VARS.some((n) => (env[n] ?? "") !== "");
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

/**
 * The bind address. Locally the default stays loopback (a reverse proxy in front).
 * On Railway the edge proxy reaches the container over its network interface, so the
 * default is 0.0.0.0, and a loopback HOST (unreachable there) is refused.
 */
function listenHost(raw: string | undefined, platform: "railway" | "local"): string {
  const host = (raw ?? "").trim();
  if (host === "") return platform === "railway" ? "0.0.0.0" : "127.0.0.1";
  if (/\s|\/|^\[/.test(host)) throw new ConfigError("HOST must be a bare IP address or host name (e.g. 0.0.0.0, ::, 127.0.0.1)");
  if (platform === "railway" && LOOPBACK_HOSTS.has(host)) {
    throw new ConfigError(`HOST=${host} is unreachable from Railway's proxy: unset HOST (0.0.0.0 is the default there) or set 0.0.0.0 or ::`);
  }
  return host;
}

/**
 * TRUST_PROXY: which forwarded header names the client. Only Railway's X-Real-IP is
 * ever trusted (never X-Forwarded-For). On Railway every request arrives from the edge
 * proxy, so `none` would put all clients in one bucket: refused there.
 */
function trustProxy(raw: string | undefined, platform: "railway" | "local"): ProxyTrust {
  const v = (raw ?? "").trim();
  if (v === "") return platform === "railway" ? "railway" : "none";
  if (v !== "railway" && v !== "none") throw new ConfigError("TRUST_PROXY must be railway or none");
  if (platform === "railway" && v === "none") {
    throw new ConfigError("TRUST_PROXY=none on Railway would rate-limit every client as the proxy's address: unset it or set railway");
  }
  return v;
}

const LOOPBACK_ORIGIN_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * `CORS_ORIGINS`: comma-separated origins (`scheme://host[:port]`, no path, no trailing
 * slash, lowercase host), https, or http for localhost only. `*`, any wildcard and
 * anything that is not exactly an origin are refused. Production:
 * `https://niaraglobal.com,https://www.niaraglobal.com`.
 */
function corsOrigins(raw: string | undefined): string[] {
  const list = (raw ?? "").split(",").map((o) => o.trim()).filter((o) => o !== "");
  for (const o of list) {
    if (o.includes("*")) throw new ConfigError("CORS_ORIGINS: wildcards are not allowed; list each origin");
    let url: URL;
    try {
      url = new URL(o);
    } catch {
      throw new ConfigError(`CORS_ORIGINS: ${o} is not an origin`);
    }
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.origin !== o) {
      throw new ConfigError(`CORS_ORIGINS: ${o} is not an origin (scheme://host[:port], no path or trailing slash)`);
    }
    // Plain http only for a local dev site; a deployed site is https.
    if (url.protocol === "http:" && !LOOPBACK_ORIGIN_HOSTS.has(url.hostname)) {
      throw new ConfigError(`CORS_ORIGINS: ${o} must be https (http is allowed only for localhost)`);
    }
  }
  return [...new Set(list)];
}

function evmConfig(env: Env) {
  const raw = (env["EVM_SETTLEMENT_CHAINS"] ?? "").trim();
  const chains = raw === "" ? [] : raw.split(",").map((c) => c.trim());
  for (const c of chains) {
    if (!isEvmChainId(c)) throw new ConfigError(`EVM_SETTLEMENT_CHAINS: unknown EVM chain ${c} (one of ${EVM_CHAIN_IDS.join(", ")})`);
  }
  const keystore = keySource(env, "EVM_OPERATOR_KEYSTORE", "EVM_OPERATOR_KEYSTORE_JSON");
  const password = env["EVM_OPERATOR_KEYSTORE_PASSWORD"] || null;
  if (chains.length > 0 && bool(env, "WORKER_ENABLED", true) && (!keystore || !password)) {
    throw new ConfigError(
      "EVM_SETTLEMENT_CHAINS is set but the operator keystore (EVM_OPERATOR_KEYSTORE or EVM_OPERATOR_KEYSTORE_JSON) " +
        "or EVM_OPERATOR_KEYSTORE_PASSWORD is not",
    );
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
  const solanaOperatorKeypair = keySource(env, "SOLANA_OPERATOR_KEYPAIR", "SOLANA_OPERATOR_KEYPAIR_JSON");
  if (workerEnabled && !solanaOperatorKeypair) {
    throw new ConfigError(
      "WORKER_ENABLED is on but neither SOLANA_OPERATOR_KEYPAIR (file path) nor SOLANA_OPERATOR_KEYPAIR_JSON (content) is set " +
        "(or set WORKER_ENABLED=off)",
    );
  }
  return {
    workerEnabled,
    solanaOperatorKeypair,
    workerPollSecs: int(env, "WORKER_POLL_SECS", 5, 1, 3_600),
    workerMaxAttempts: int(env, "WORKER_MAX_ATTEMPTS", 6, 1, 20),
    settleDeadlineMarginSecs: int(env, "SETTLE_DEADLINE_MARGIN_SECS", 90, 30, 3_600),
  };
}

/** A key from a file path variable or a content variable; both set is ambiguous and refused. */
function keySource(env: Env, pathVar: string, jsonVar: string): KeySource | null {
  const path = (env[pathVar] ?? "").trim();
  const json = env[jsonVar] ?? "";
  if (path !== "" && json.trim() !== "") throw new ConfigError(`set ${pathVar} (file path) or ${jsonVar} (content), not both`);
  if (json.trim() !== "") return { from: "env", variable: jsonVar, json };
  return path !== "" ? { from: "file", path } : null;
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
  const {
    databaseUrl: _db,
    databaseCaCommitted,
    solanaRpcUrl,
    evmOperatorKeystorePassword: pw,
    evmSettlementChains,
    corsOrigins,
    solanaOperatorKeypair,
    evmOperatorKeystore,
    ...rest
  } = c;
  return {
    ...rest,
    // Key sources: a file's path, or only the NAME of the variable holding the key.
    solanaOperatorKeypair: describeKeySource(solanaOperatorKeypair),
    evmOperatorKeystore: describeKeySource(evmOperatorKeystore),
    corsOrigins: corsOrigins.join(",") || "(none)",
    evmSettlementChains: evmSettlementChains.join(",") || "(none)",
    evmOperatorKeystorePassword: pw ? "(set, not shown)" : null,
    databaseUrl: "(set, not shown)",
    databaseTls: databaseCaCommitted ? "verify-full, committed config/supabase-ca.crt" : "verify-full, custom sslrootcert (not shown)",
    solanaRpcUrl: solanaRpcUrl === "https://api.devnet.solana.com" ? solanaRpcUrl : "(custom, not shown)",
  };
}

/**
 * Removes every secret-bearing value from a text before it is logged: the database
 * URL and each of its parts, private Solana and EVM RPC URLs and their path/query (API
 * keys), every *PASSWORD* variable (keystore passwords), the Supabase service role key,
 * and the operator keys given as content (SOLANA_OPERATOR_KEYPAIR_JSON,
 * EVM_OPERATOR_KEYSTORE_JSON) in each form they could be printed in. Error messages
 * from drivers can quote any of them.
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
  secrets.push(...passwordValues(env), ...keyMaterialValues(env));
  let out = text;
  for (const s of secrets.filter((x) => x.length >= 3).sort((a, b) => b.length - a.length)) out = out.split(s).join("***");
  return out;
}
