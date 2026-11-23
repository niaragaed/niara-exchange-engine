import { describe, expect, it } from "vitest";
import { createApp } from "../../src/service/http.ts";
import type { OrderService } from "../../src/service/order-service.ts";

/**
 * CORS of the HTTP API (CORS_ORIGINS). The routes exercised here never reach the order
 * service, so it is an empty stand-in. Origins are test values.
 */

const SITE = "http://localhost:3000";
const app = createApp({} as OrderService, { maxBodyBytes: 4096, corsOrigins: [SITE, "https://niara-test.vercel.app"] });

const preflight = (origin: string, method = "POST", headers = "content-type") =>
  app.request("/v1/orders", {
    method: "OPTIONS",
    headers: { origin, "access-control-request-method": method, "access-control-request-headers": headers },
  });

describe("CORS", () => {
  it("answers a preflight from a listed origin: that origin, GET/POST/OPTIONS, content-type, no credentials", async () => {
    const r = await preflight(SITE);
    expect(r.status).toBe(204);
    expect(r.headers.get("access-control-allow-origin")).toBe(SITE);
    expect(r.headers.get("access-control-allow-methods")).toBe("GET,POST,OPTIONS");
    expect(r.headers.get("access-control-allow-headers")).toBe("content-type");
    expect(r.headers.get("access-control-allow-credentials")).toBeNull();
    expect(r.headers.get("vary")).toContain("Origin");
    expect((await preflight("https://niara-test.vercel.app")).headers.get("access-control-allow-origin")).toBe(
      "https://niara-test.vercel.app",
    );
  });

  it("never allows another origin, and never answers *", async () => {
    for (const origin of ["https://evil.example", "http://localhost:3001", "http://localhost:3000.evil.example", "null"]) {
      const r = await preflight(origin);
      expect(r.headers.get("access-control-allow-origin"), origin).toBeNull();
    }
    const get = await app.request("/health", { headers: { origin: "https://evil.example" } });
    expect(get.status).toBe(200);
    expect(get.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("sets the allowed origin on actual responses, including errors", async () => {
    const health = await app.request("/health", { headers: { origin: SITE } });
    expect(health.headers.get("access-control-allow-origin")).toBe(SITE);
    const missing = await app.request("/v1/nothing", { headers: { origin: SITE } });
    expect(missing.status).toBe(404);
    expect(missing.headers.get("access-control-allow-origin")).toBe(SITE);
    const big = await app.request("/v1/orders", {
      method: "POST",
      headers: { origin: SITE, "content-type": "application/json" },
      body: JSON.stringify({ pad: "x".repeat(5000) }),
    });
    expect(big.status).toBe(413);
    expect(big.headers.get("access-control-allow-origin")).toBe(SITE);
  });

  it("allows no browser origin when none is configured, and refuses *", async () => {
    const closed = createApp({} as OrderService, { maxBodyBytes: 4096 });
    const r = await closed.request("/v1/orders", {
      method: "OPTIONS",
      headers: { origin: SITE, "access-control-request-method": "POST" },
    });
    expect(r.headers.get("access-control-allow-origin")).toBeNull();
    expect(() => createApp({} as OrderService, { maxBodyBytes: 4096, corsOrigins: ["*"] })).toThrow(/never \*/);
  });
});

describe("CORS with the production origins", () => {
  const prod = createApp({} as OrderService, { maxBodyBytes: 4096, corsOrigins: ["https://niaraglobal.com", "https://www.niaraglobal.com"] });
  const preflightFrom = (origin: string) =>
    prod.request("/v1/orders", {
      method: "OPTIONS",
      headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "content-type" },
    });

  it("allows niaraglobal.com and www.niaraglobal.com, each echoed exactly", async () => {
    for (const origin of ["https://niaraglobal.com", "https://www.niaraglobal.com"]) {
      const r = await preflightFrom(origin);
      expect(r.status).toBe(204);
      expect(r.headers.get("access-control-allow-origin")).toBe(origin);
      const get = await prod.request("/health", { headers: { origin } });
      expect(get.headers.get("access-control-allow-origin")).toBe(origin);
    }
  });

  it("refuses look-alikes, other subdomains, http and the local site", async () => {
    for (const origin of [
      "http://niaraglobal.com",
      "https://api.niaraglobal.com",
      "https://evil.niaraglobal.com",
      "https://niaraglobal.com.evil.example",
      "https://wwwniaraglobal.com",
      "https://niaraglobal.co",
      "http://localhost:3000",
      "null",
    ]) {
      expect((await preflightFrom(origin)).headers.get("access-control-allow-origin"), origin).toBeNull();
    }
  });
});
