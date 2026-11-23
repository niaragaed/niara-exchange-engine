import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Keypair } from "@solana/web3.js";
import { base58 } from "@scure/base";
import { describe, expect, it } from "vitest";
import { X509Certificate } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { parse as parsePgUrl } from "pg-connection-string";
import { ConfigError, SUPABASE_CA_PATH, describeConfig, loadConfig, redactSecrets } from "../src/config.ts";

// TEST ONLY: a placeholder URL, not a real database or password.
const URL_OK = "postgresql://test_login:test-password-123@db.example.invalid:5432/postgres";
const bs58 = (b: Uint8Array) => base58.encode(b);
// Most cases run without the worker (it needs an operator keypair path).
const NO_WORKER = { WORKER_ENABLED: "off" };

describe("loadConfig", () => {
  it("reads env vars with defaults", () => {
    expect(loadConfig({ DATABASE_URL: URL_OK, WORKER_ENABLED: "off" })).toEqual({
      databaseUrl: `${URL_OK}?sslmode=verify-full&sslrootcert=${encodeURIComponent(SUPABASE_CA_PATH)}`,
      databaseCaCommitted: true,
      platform: "local",
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
      solanaOperatorKeypair: null,
      workerPollSecs: 5,
      workerMaxAttempts: 6,
      settleDeadlineMarginSecs: 90,
      evmSettlementChains: [],
      evmOperatorKeystore: null,
      evmOperatorKeystorePassword: null,
      corsOrigins: [],
      rateLimitReadsPerMin: 300,
      rateLimitWritesPerMin: 30,
      trustProxy: "none",
    });
    expect(() => loadConfig({ DATABASE_URL: URL_OK })).toThrow(/SOLANA_OPERATOR_KEYPAIR/);
    expect(loadConfig({ DATABASE_URL: URL_OK, SOLANA_OPERATOR_KEYPAIR: "/outside/operator.json" })).toMatchObject({
      workerEnabled: true,
      solanaOperatorKeypair: { from: "file", path: "/outside/operator.json" },
    });
    expect(loadConfig({ DATABASE_URL: URL_OK, WORKER_ENABLED: "off", PORT: "9000", MAX_OPEN_ORDERS_PER_WALLET: "5" })).toMatchObject({
      port: 9000,
      maxOpenOrdersPerWallet: 5,
    });
  });

  it("listens on HOST and PORT: loopback locally, 0.0.0.0 on Railway (detected by its injected variables)", () => {
    const base = { ...NO_WORKER, DATABASE_URL: URL_OK };
    // TEST ONLY: placeholder Railway ids.
    const railway = { ...base, RAILWAY_ENVIRONMENT_ID: "test-env-id", PORT: "4321" };
    expect(loadConfig(base)).toMatchObject({ platform: "local", host: "127.0.0.1", port: 8787 });
    expect(loadConfig({ ...base, HOST: "0.0.0.0", PORT: "9000" })).toMatchObject({ platform: "local", host: "0.0.0.0", port: 9000 });
    expect(loadConfig(railway)).toMatchObject({ platform: "railway", host: "0.0.0.0", port: 4321 });
    expect(loadConfig({ ...base, RAILWAY_PROJECT_ID: "test-project-id" }).host).toBe("0.0.0.0");
    expect(loadConfig({ ...railway, HOST: "::" }).host).toBe("::");
    expect(loadConfig({ ...base, RAILWAY_SERVICE_ID: "" }).platform).toBe("local");
    // A loopback bind is unreachable from Railway's proxy: refused there, not silently kept.
    for (const h of ["127.0.0.1", "localhost", "::1"]) expect(() => loadConfig({ ...railway, HOST: h }), h).toThrow(/unreachable from Railway/);
    expect(() => loadConfig({ ...base, HOST: "http://0.0.0.0" })).toThrow(/bare IP address/);
    expect(describeConfig(loadConfig(railway))).toMatchObject({ platform: "railway", host: "0.0.0.0", port: 4321 });
  });

  it("reads the rate limits and which proxy header to trust (only Railway's, only on Railway by default)", () => {
    const base = { ...NO_WORKER, DATABASE_URL: URL_OK };
    const railway = { ...base, RAILWAY_ENVIRONMENT_ID: "test-env-id" };
    expect(loadConfig(base)).toMatchObject({ rateLimitReadsPerMin: 300, rateLimitWritesPerMin: 30, trustProxy: "none" });
    expect(loadConfig(railway).trustProxy).toBe("railway");
    expect(loadConfig({ ...base, TRUST_PROXY: "railway" }).trustProxy).toBe("railway");
    expect(() => loadConfig({ ...railway, TRUST_PROXY: "none" })).toThrow(/every client/);
    for (const bad of ["x-forwarded-for", "true", "cloudflare"]) expect(() => loadConfig({ ...base, TRUST_PROXY: bad }), bad).toThrow(/railway or none/);
    expect(loadConfig({ ...base, RATE_LIMIT_READS_PER_MIN: "60", RATE_LIMIT_WRITES_PER_MIN: "5" })).toMatchObject({
      rateLimitReadsPerMin: 60,
      rateLimitWritesPerMin: 5,
    });
    expect(() => loadConfig({ ...base, RATE_LIMIT_WRITES_PER_MIN: "0" })).toThrow(/between/);
  });

  it("requires a postgres DATABASE_URL and refuses the transaction pooler", () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({ DATABASE_URL: "not a url" })).toThrow(/not a URL/);
    expect(() => loadConfig({ DATABASE_URL: "https://example.invalid" })).toThrow(/postgres/);
    expect(() => loadConfig({ ...NO_WORKER, DATABASE_URL: URL_OK.replace(":5432", ":6543") })).toThrow(/advisory lock/);
  });

  describe("database TLS: the committed Supabase CA", () => {
    const base = { ...NO_WORKER };
    const caOf = (url: string) => new URL(url).searchParams.get("sslrootcert");

    it("commits Supabase's public root CA (a certificate only, no key) under config/", () => {
      const pem = readFileSync(SUPABASE_CA_PATH, "utf8");
      expect(SUPABASE_CA_PATH.endsWith(join("config", "supabase-ca.crt"))).toBe(true);
      expect(pem.match(/-----BEGIN [A-Z ]+-----/g)).toEqual(["-----BEGIN CERTIFICATE-----"]);
      expect(pem).not.toMatch(/PRIVATE KEY/);
      const cert = new X509Certificate(pem);
      expect(cert.subject).toContain("CN=Supabase Root 2021 CA");
      expect(cert.ca).toBe(true);
      expect(cert.checkIssued(cert)).toBe(true); // a self-signed root
      expect(new Date(cert.validTo).getTime()).toBeGreaterThan(Date.now());
    });

    it("verifies the server against it by default: sslmode=verify-full and an absolute sslrootcert", () => {
      const c = loadConfig({ ...base, DATABASE_URL: URL_OK });
      expect(caOf(c.databaseUrl)).toBe(SUPABASE_CA_PATH);
      expect(new URL(c.databaseUrl).searchParams.get("sslmode")).toBe("verify-full");
      expect(new URL(c.databaseUrl).password).toBe("test-password-123");
      // What node-postgres makes of it: the CA loaded, certificate checks on.
      const ssl = parsePgUrl(c.databaseUrl).ssl as { ca?: string; rejectUnauthorized?: boolean };
      expect(ssl.ca).toBe(readFileSync(SUPABASE_CA_PATH, "utf8"));
      expect(ssl.rejectUnauthorized).not.toBe(false);
      expect(describeConfig(c).databaseTls).toBe("verify-full, committed config/supabase-ca.crt");
    });

    it("resolves a relative sslrootcert against the repository and keeps an absolute one", () => {
      const rel = loadConfig({ ...base, DATABASE_URL: `${URL_OK}?sslmode=verify-full&sslrootcert=config/supabase-ca.crt` });
      expect(caOf(rel.databaseUrl)).toBe(SUPABASE_CA_PATH);
      expect(rel.databaseCaCommitted).toBe(true);
      const dir = mkdtempSync(join(tmpdir(), "niara-test-ca-"));
      const own = join(dir, "ca.crt");
      writeFileSync(own, readFileSync(SUPABASE_CA_PATH));
      const abs = `${URL_OK}?sslmode=verify-full&sslrootcert=${own}`;
      const c = loadConfig({ ...base, DATABASE_URL: abs });
      expect(c.databaseUrl).toBe(abs);
      expect(c.databaseCaCommitted).toBe(false);
      expect(JSON.stringify(describeConfig(c))).not.toContain(dir);
    });

    it("refuses a weaker sslmode and a missing CA file", () => {
      for (const mode of ["disable", "prefer", "require", "verify-ca"]) {
        expect(() => loadConfig({ ...base, DATABASE_URL: `${URL_OK}?sslmode=${mode}` }), mode).toThrow(/verify-full/);
      }
      expect(() => loadConfig({ ...base, DATABASE_URL: `${URL_OK}?sslrootcert=/nonexistent/ca.crt` })).toThrow(/sslrootcert file does not exist/);
    });
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
    expect(c).toMatchObject({ evmSettlementChains: ["base-sepolia"], evmOperatorKeystore: { from: "file", path: "/outside/ks" } });
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

  describe("operator keys as content (hosted deployments)", () => {
    // TEST ONLY: a throwaway keypair and a fake keystore, generated per run.
    const kp = Keypair.generate();
    const solanaJson = JSON.stringify(Array.from(kp.secretKey));
    const keystoreJson = JSON.stringify({
      version: 3,
      address: "0000000000000000000000000000000000000001",
      crypto: { cipher: "aes-128-ctr", ciphertext: "c1".repeat(32), cipherparams: { iv: "1v".repeat(8) }, kdf: "scrypt", kdfparams: { salt: "5a".repeat(32) }, mac: "3c".repeat(32) },
    });
    const env = {
      DATABASE_URL: URL_OK,
      SOLANA_OPERATOR_KEYPAIR_JSON: solanaJson,
      EVM_SETTLEMENT_CHAINS: "base-sepolia",
      EVM_OPERATOR_KEYSTORE_JSON: keystoreJson,
      EVM_OPERATOR_KEYSTORE_PASSWORD: "test-keystore-pw",
    };

    it("reads SOLANA_OPERATOR_KEYPAIR_JSON and EVM_OPERATOR_KEYSTORE_JSON, and refuses a path and content together", () => {
      const c = loadConfig(env);
      expect(c.solanaOperatorKeypair).toEqual({ from: "env", variable: "SOLANA_OPERATOR_KEYPAIR_JSON", json: solanaJson });
      expect(c.evmOperatorKeystore).toEqual({ from: "env", variable: "EVM_OPERATOR_KEYSTORE_JSON", json: keystoreJson });
      expect(() => loadConfig({ ...env, SOLANA_OPERATOR_KEYPAIR: "/outside/op.json" })).toThrow(/not both/);
      expect(() => loadConfig({ ...env, EVM_OPERATOR_KEYSTORE: "/outside/ks" })).toThrow(/not both/);
      const { EVM_OPERATOR_KEYSTORE_PASSWORD: _pw, ...noPassword } = env;
      expect(() => loadConfig(noPassword)).toThrow(/EVM_OPERATOR_KEYSTORE_PASSWORD/);
      // Empty content counts as unset.
      expect(() => loadConfig({ ...env, SOLANA_OPERATOR_KEYPAIR_JSON: " " })).toThrow(/SOLANA_OPERATOR_KEYPAIR_JSON \(content\)/);
    });

    it("never shows the key content in the logged configuration", () => {
      const shown = JSON.stringify(describeConfig(loadConfig(env)));
      expect(shown).toContain("env SOLANA_OPERATOR_KEYPAIR_JSON (set, not shown)");
      expect(shown).toContain("env EVM_OPERATOR_KEYSTORE_JSON (set, not shown)");
      for (const part of [solanaJson, String(kp.secretKey[0]) + "," + String(kp.secretKey[1]), "c1c1c1", "5a5a5a", "3c3c3c", "test-keystore-pw"]) {
        expect(shown).not.toContain(part);
      }
      expect(describeConfig(loadConfig({ ...env, SOLANA_OPERATOR_KEYPAIR_JSON: "", SOLANA_OPERATOR_KEYPAIR: "/outside/op.json" })).solanaOperatorKeypair).toBe(
        "file /outside/op.json",
      );
    });

    it("refuses the key content in NEXT_PUBLIC_*, and redacts it in every printable form", () => {
      expect(() => loadConfig({ ...env, NEXT_PUBLIC_X: solanaJson })).toThrow(/server secret/);
      expect(() => loadConfig({ ...env, NEXT_PUBLIC_X: bs58(kp.secretKey) })).toThrow(/server secret/);
      expect(() => loadConfig({ ...env, NEXT_PUBLIC_X: "c1".repeat(32) })).toThrow(/server secret/);
      expect(() => loadConfig({ ...env, NEXT_PUBLIC_SOLANA_OPERATOR_KEYPAIR_JSON: "x" })).toThrow(/NEXT_PUBLIC/);
      const secret = kp.secretKey;
      const forms = [
        solanaJson,
        JSON.stringify(Array.from(secret), null, 2),
        Array.from(secret).join(", "),
        bs58(secret),
        bs58(secret.subarray(0, 32)),
        Buffer.from(secret).toString("hex"),
        "0x" + Buffer.from(secret.subarray(0, 32)).toString("hex"),
        Buffer.from(secret).toString("base64"),
        keystoreJson,
        "c1".repeat(32),
        "0x" + "3c".repeat(32),
        "5a".repeat(32),
      ];
      for (const f of forms) expect(redactSecrets(`error: ${f} end`, env), f.slice(0, 20)).toBe("error: *** end");
      // The operator's public key and the keystore's address are not secrets.
      const pub = kp.publicKey.toBase58();
      expect(redactSecrets(`operator ${pub}`, env)).toBe(`operator ${pub}`);
    });
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
        "RATE_LIMIT_READS_PER_MIN",
        "RATE_LIMIT_WRITES_PER_MIN",
      ].sort(),
    );
    expect(env["DATABASE_URL"]).toContain("PASSWORD@DB_HOST");
    expect(() => loadConfig(env)).not.toThrow();
  });
});
