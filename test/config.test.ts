import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, describeConfig, loadConfig, redactSecrets } from "../src/config.ts";

// TEST ONLY: a placeholder URL, not a real database or password.
const URL_OK = "postgresql://test_login:test-password-123@db.example.invalid:5432/postgres";
// Most cases run without the worker (it needs an operator keypair path).
const NO_WORKER = { WORKER_ENABLED: "off" };

describe("loadConfig", () => {
  it("reads env vars with defaults", () => {
    expect(loadConfig({ DATABASE_URL: URL_OK, WORKER_ENABLED: "off" })).toEqual({
      databaseUrl: URL_OK,
      host: "127.0.0.1",
      port: 8787,
      maxBodyBytes: 16_384,
      maxOpenOrdersPerWallet: 50,
      settlementMarginSecs: 60,
      expirySweepSecs: 30,
      marketRefreshSecs: 60,
      solanaRpcUrl: "https://api.devnet.solana.com",
      delegateCheck: true,
      workerEnabled: false,
      operatorKeypairPath: null,
      workerPollSecs: 5,
      workerMaxAttempts: 6,
      settleDeadlineMarginSecs: 90,
      evmSettlementChains: [],
      evmOperatorKeystore: null,
      evmOperatorKeystorePassword: null,
      corsOrigins: [],
    });
    expect(() => loadConfig({ DATABASE_URL: URL_OK })).toThrow(/SOLANA_OPERATOR_KEYPAIR/);
    expect(loadConfig({ DATABASE_URL: URL_OK, SOLANA_OPERATOR_KEYPAIR: "/outside/operator.json" })).toMatchObject({
      workerEnabled: true,
      operatorKeypairPath: "/outside/operator.json",
    });
    expect(loadConfig({ DATABASE_URL: URL_OK, WORKER_ENABLED: "off", PORT: "9000", MAX_OPEN_ORDERS_PER_WALLET: "5" })).toMatchObject({
      port: 9000,
      maxOpenOrdersPerWallet: 5,
    });
  });

  it("requires a postgres DATABASE_URL and refuses the transaction pooler", () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({ DATABASE_URL: "not a url" })).toThrow(/not a URL/);
    expect(() => loadConfig({ DATABASE_URL: "https://example.invalid" })).toThrow(/postgres/);
    expect(() => loadConfig({ ...NO_WORKER, DATABASE_URL: URL_OK.replace(":5432", ":6543") })).toThrow(/advisory lock/);
  });

  it("reads the Solana RPC and the delegate check switch, and never shows a custom RPC URL", () => {
    const c = loadConfig({ ...NO_WORKER, DATABASE_URL: URL_OK, SOLANA_RPC_URL: "https://rpc.example.invalid/?api-key=k", DELEGATE_CHECK: "off" });
    expect([c.solanaRpcUrl, c.delegateCheck]).toEqual(["https://rpc.example.invalid/?api-key=k", false]);
    expect(JSON.stringify(describeConfig(c))).not.toContain("rpc.example.invalid");
    expect(() => loadConfig({ ...NO_WORKER, DATABASE_URL: URL_OK, DELEGATE_CHECK: "maybe" })).toThrow(/on or off/);
    expect(() => loadConfig({ ...NO_WORKER, DATABASE_URL: URL_OK, SOLANA_RPC_URL: "ftp://x" })).toThrow(/http/);
  });

  it("refuses malformed or out-of-range numbers", () => {
    expect(() => loadConfig({ ...NO_WORKER, DATABASE_URL: URL_OK, PORT: "80.5" })).toThrow(/whole number/);
    expect(() => loadConfig({ ...NO_WORKER, DATABASE_URL: URL_OK, PORT: "70000" })).toThrow(/between/);
    expect(() => loadConfig({ ...NO_WORKER, DATABASE_URL: URL_OK, MAX_BODY_BYTES: "10" })).toThrow(/between/);
  });

  it("refuses to start when a NEXT_PUBLIC_* variable names or carries a server secret", () => {
    const base = { ...NO_WORKER, DATABASE_URL: URL_OK };
    expect(() => loadConfig({ ...base, NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY: "x" })).toThrow(/NEXT_PUBLIC/);
    expect(() => loadConfig({ ...base, NEXT_PUBLIC_DATABASE_URL: "x" })).toThrow(/NEXT_PUBLIC/);
    expect(() => loadConfig({ ...base, NEXT_PUBLIC_DB: URL_OK })).toThrow(/server secret/);
    expect(() => loadConfig({ ...base, NEXT_PUBLIC_PW: "test-password-123" })).toThrow(/server secret/);
    expect(() =>
      loadConfig({ ...base, SUPABASE_SERVICE_ROLE_KEY: "test-service-key-abc", NEXT_PUBLIC_KEY: "test-service-key-abc" }),
    ).toThrow(/server secret/);
    const rpc = "https://rpc.example.invalid/?api-key=test-rpc-key";
    expect(() => loadConfig({ ...base, SOLANA_RPC_URL: rpc, NEXT_PUBLIC_SOLANA_RPC_URL: rpc })).toThrow(/server secret/);
    expect(() =>
      loadConfig({ ...base, NEXT_PUBLIC_SOLANA_RPC_URL: "https://api.devnet.solana.com" }),
    ).not.toThrow();
    // Public values are fine.
    expect(() =>
      loadConfig({ ...base, NEXT_PUBLIC_SUPABASE_URL: "https://example.invalid", NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon" }),
    ).not.toThrow();
  });

  it("never logs any part of the database URL", () => {
    const shown = JSON.stringify(describeConfig(loadConfig({ ...NO_WORKER, DATABASE_URL: URL_OK })));
    for (const part of ["test-password-123", "test_login", "db.example.invalid", "5432"]) expect(shown).not.toContain(part);
  });

  it("redacts the database URL, its parts and the RPC URL from error text", () => {
    const env = {
      DATABASE_URL: URL_OK,
      SOLANA_RPC_URL: "https://rpc.example.invalid/?api-key=test-key-abc",
    };
    const text =
      'password authentication failed for user "test_login" at db.example.invalid:5432; ' +
      "fetch https://rpc.example.invalid/?api-key=test-key-abc failed; key test-key-abc";
    const out = redactSecrets(text, env);
    for (const part of ["test_login", "db.example.invalid", "test-key-abc", "rpc.example.invalid"]) expect(out).not.toContain(part);
    expect(redactSecrets("nothing secret here", env)).toBe("nothing secret here");
  });

  it("reads the EVM settlement chains, and requires the operator keystore and its password with them", () => {
    const base = { ...NO_WORKER, DATABASE_URL: URL_OK };
    expect(loadConfig({ ...base, EVM_SETTLEMENT_CHAINS: "base-sepolia, tempo-testnet,base-sepolia" }).evmSettlementChains).toEqual([
      "base-sepolia",
      "tempo-testnet",
    ]);
    expect(() => loadConfig({ ...base, EVM_SETTLEMENT_CHAINS: "ethereum" })).toThrow(/unknown EVM chain ethereum/);
    expect(() => loadConfig({ ...base, EVM_SETTLEMENT_CHAINS: "solana-devnet" })).toThrow(/unknown EVM chain/);
    const worker = { DATABASE_URL: URL_OK, SOLANA_OPERATOR_KEYPAIR: "/outside/op.json", EVM_SETTLEMENT_CHAINS: "base-sepolia" };
    expect(() => loadConfig(worker)).toThrow(/EVM_OPERATOR_KEYSTORE/);
    expect(() => loadConfig({ ...worker, EVM_OPERATOR_KEYSTORE: "/outside/ks" })).toThrow(/EVM_OPERATOR_KEYSTORE_PASSWORD/);
    const c = loadConfig({ ...worker, EVM_OPERATOR_KEYSTORE: "/outside/ks", EVM_OPERATOR_KEYSTORE_PASSWORD: "test-keystore-pw" });
    expect(c).toMatchObject({ evmSettlementChains: ["base-sepolia"], evmOperatorKeystore: "/outside/ks" });
    expect(JSON.stringify(describeConfig(c))).not.toContain("test-keystore-pw");
    expect(() => loadConfig({ ...base, BASE_SEPOLIA_RPC_URL: "ftp://x" })).toThrow(/BASE_SEPOLIA_RPC_URL/);
  });

  it("refuses keystore passwords and private EVM RPCs in NEXT_PUBLIC_*, and redacts them from logs", () => {
    const env = {
      ...NO_WORKER,
      DATABASE_URL: URL_OK,
      EVM_OPERATOR_KEYSTORE_PASSWORD: "test-keystore-pw",
      EVM_INVESTOR_A_KEYSTORE_PASSWORD: "test-investor-pw",
      TEMPO_TESTNET_RPC_URL: "https://tempo.example.invalid/v1/test-key-xyz",
      BASE_SEPOLIA_RPC_URL: "https://sepolia.base.org",
    };
    expect(() => loadConfig({ ...env, NEXT_PUBLIC_X: "a test-keystore-pw b" })).toThrow(/server secret/);
    expect(() => loadConfig({ ...env, NEXT_PUBLIC_RPC: "https://tempo.example.invalid/v1/test-key-xyz" })).toThrow(/server secret/);
    expect(() => loadConfig({ ...env, NEXT_PUBLIC_EVM_KEYSTORE: "x" })).toThrow(/NEXT_PUBLIC_EVM_KEYSTORE/);
    expect(() => loadConfig({ ...env, NEXT_PUBLIC_BASE_RPC: "https://sepolia.base.org" })).not.toThrow();
    const out = redactSecrets("pw test-keystore-pw, test-investor-pw; GET https://tempo.example.invalid/v1/test-key-xyz", env);
    for (const part of ["test-keystore-pw", "test-investor-pw", "test-key-xyz", "tempo.example.invalid"]) expect(out).not.toContain(part);
    expect(redactSecrets("https://sepolia.base.org is public", env)).toBe("https://sepolia.base.org is public");
  });

  it("reads the CORS origins: exact http(s) origins only, never a wildcard", () => {
    const base = { ...NO_WORKER, DATABASE_URL: URL_OK };
    expect(
      loadConfig({ ...base, CORS_ORIGINS: "http://localhost:3000, https://niara-test.vercel.app,http://localhost:3000" }).corsOrigins,
    ).toEqual(["http://localhost:3000", "https://niara-test.vercel.app"]);
    expect(loadConfig({ ...base, CORS_ORIGINS: "" }).corsOrigins).toEqual([]);
    for (const bad of ["*", "https://*.vercel.app", "http://localhost:3000/", "https://site.example/trade", "localhost:3000", "ftp://x.example"]) {
      expect(() => loadConfig({ ...base, CORS_ORIGINS: bad }), bad).toThrow(/CORS_ORIGINS/);
    }
    expect(describeConfig(loadConfig({ ...base, CORS_ORIGINS: "http://localhost:3000" })).corsOrigins).toBe("http://localhost:3000");
  });

  it(".env.example parses, holds placeholders only, and documents every variable", () => {
    const text = readFileSync(join(import.meta.dirname, "../.env.example"), "utf8");
    const env: Record<string, string> = {};
    for (const line of text.split("\n")) {
      const m = /^([A-Z_]+)=(.*)$/.exec(line);
      if (m) env[m[1]!] = m[2]!;
    }
    expect(Object.keys(env).sort()).toEqual(
      [
        "DATABASE_URL",
        "DELEGATE_CHECK",
        "EXPIRY_SWEEP_SECS",
        "HOST",
        "MARKET_REFRESH_SECS",
        "MAX_BODY_BYTES",
        "MAX_OPEN_ORDERS_PER_WALLET",
        "PORT",
        "SETTLEMENT_MARGIN_SECS",
        "SETTLE_DEADLINE_MARGIN_SECS",
        "SOLANA_OPERATOR_KEYPAIR",
        "EVM_SETTLEMENT_CHAINS",
        "EVM_OPERATOR_KEYSTORE",
        "WORKER_ENABLED",
        "WORKER_MAX_ATTEMPTS",
        "WORKER_POLL_SECS",
        "CORS_ORIGINS",
      ].sort(),
    );
    expect(env["DATABASE_URL"]).toContain("PASSWORD@DB_HOST");
    expect(() => loadConfig(env)).not.toThrow();
  });
});
