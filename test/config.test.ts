import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, describeConfig, loadConfig, redactSecrets } from "../src/config.ts";

// TEST ONLY: a placeholder URL, not a real database or password.
const URL_OK = "postgresql://test_login:test-password-123@db.example.invalid:5432/postgres";

describe("loadConfig", () => {
  it("reads env vars with defaults", () => {
    expect(loadConfig({ DATABASE_URL: URL_OK })).toEqual({
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
    });
    expect(loadConfig({ DATABASE_URL: URL_OK, PORT: "9000", MAX_OPEN_ORDERS_PER_WALLET: "5" })).toMatchObject({
      port: 9000,
      maxOpenOrdersPerWallet: 5,
    });
  });

  it("requires a postgres DATABASE_URL and refuses the transaction pooler", () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({ DATABASE_URL: "not a url" })).toThrow(/not a URL/);
    expect(() => loadConfig({ DATABASE_URL: "https://example.invalid" })).toThrow(/postgres/);
    expect(() => loadConfig({ DATABASE_URL: URL_OK.replace(":5432", ":6543") })).toThrow(/advisory lock/);
  });

  it("reads the Solana RPC and the delegate check switch, and never shows a custom RPC URL", () => {
    const c = loadConfig({ DATABASE_URL: URL_OK, SOLANA_RPC_URL: "https://rpc.example.invalid/?api-key=k", DELEGATE_CHECK: "off" });
    expect([c.solanaRpcUrl, c.delegateCheck]).toEqual(["https://rpc.example.invalid/?api-key=k", false]);
    expect(JSON.stringify(describeConfig(c))).not.toContain("rpc.example.invalid");
    expect(() => loadConfig({ DATABASE_URL: URL_OK, DELEGATE_CHECK: "maybe" })).toThrow(/on or off/);
    expect(() => loadConfig({ DATABASE_URL: URL_OK, SOLANA_RPC_URL: "ftp://x" })).toThrow(/http/);
  });

  it("refuses malformed or out-of-range numbers", () => {
    expect(() => loadConfig({ DATABASE_URL: URL_OK, PORT: "80.5" })).toThrow(/whole number/);
    expect(() => loadConfig({ DATABASE_URL: URL_OK, PORT: "70000" })).toThrow(/between/);
    expect(() => loadConfig({ DATABASE_URL: URL_OK, MAX_BODY_BYTES: "10" })).toThrow(/between/);
  });

  it("refuses to start when a NEXT_PUBLIC_* variable names or carries a server secret", () => {
    const base = { DATABASE_URL: URL_OK };
    expect(() => loadConfig({ ...base, NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY: "x" })).toThrow(/NEXT_PUBLIC/);
    expect(() => loadConfig({ ...base, NEXT_PUBLIC_DATABASE_URL: "x" })).toThrow(/NEXT_PUBLIC/);
    expect(() => loadConfig({ ...base, NEXT_PUBLIC_DB: URL_OK })).toThrow(/server secret/);
    expect(() => loadConfig({ ...base, NEXT_PUBLIC_PW: "test-password-123" })).toThrow(/server secret/);
    expect(() =>
      loadConfig({ ...base, SUPABASE_SERVICE_ROLE_KEY: "test-service-key-abc", NEXT_PUBLIC_KEY: "test-service-key-abc" }),
    ).toThrow(/server secret/);
    // Public values are fine.
    expect(() =>
      loadConfig({ ...base, NEXT_PUBLIC_SUPABASE_URL: "https://example.invalid", NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon" }),
    ).not.toThrow();
  });

  it("never logs any part of the database URL", () => {
    const shown = JSON.stringify(describeConfig(loadConfig({ DATABASE_URL: URL_OK })));
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
      ].sort(),
    );
    expect(env["DATABASE_URL"]).toContain("PASSWORD@DB_HOST");
    expect(() => loadConfig(env)).not.toThrow();
  });
});
