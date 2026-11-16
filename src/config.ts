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
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

type Env = Readonly<Record<string, string | undefined>>;

const SECRET_NAME = /SERVICE_ROLE|SECRET|PASSWORD|PRIVATE|DATABASE_URL|OPERATOR|KEYPAIR|JWT/i;

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
  checkNoPublicSecrets(env, [databaseUrl, password, env["SUPABASE_SERVICE_ROLE_KEY"] ?? ""]);
  return {
    databaseUrl,
    host: env["HOST"] || "127.0.0.1",
    port: int(env, "PORT", 8787, 1, 65535),
    maxBodyBytes: int(env, "MAX_BODY_BYTES", 16 * 1024, 1024, 1024 * 1024),
    maxOpenOrdersPerWallet: int(env, "MAX_OPEN_ORDERS_PER_WALLET", 50, 1, 10_000),
    settlementMarginSecs: int(env, "SETTLEMENT_MARGIN_SECS", 60, 0, 86_400),
    expirySweepSecs: int(env, "EXPIRY_SWEEP_SECS", 30, 1, 3_600),
    marketRefreshSecs: int(env, "MARKET_REFRESH_SECS", 60, 1, 86_400),
  };
}

/**
 * The configuration as safe to log: no part of the database URL (user, host, port,
 * database, password) and no RPC URL, which may hold an API key.
 */
export function describeConfig(c: ServiceConfig): Record<string, string | number> {
  const { databaseUrl: _db, ...rest } = c;
  return { ...rest, databaseUrl: "(set, not shown)" };
}

/**
 * Removes every secret-bearing value from a text before it is logged: the database
 * URL and each of its parts, the Solana RPC URL and its path/query (API keys), and the
 * Supabase service role key. Error messages from drivers can quote any of them.
 */
export function redactSecrets(text: string, env: Readonly<Record<string, string | undefined>> = process.env): string {
  const secrets: string[] = [];
  for (const name of ["DATABASE_URL", "SOLANA_RPC_URL"]) {
    const raw = env[name];
    if (!raw) continue;
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
  let out = text;
  for (const s of secrets.filter((x) => x.length >= 3).sort((a, b) => b.length - a.length)) out = out.split(s).join("***");
  return out;
}
