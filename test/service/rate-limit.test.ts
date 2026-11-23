import { describe, expect, it } from "vitest";
import { createApp } from "../../src/service/http.ts";
import type { OrderService } from "../../src/service/order-service.ts";
import { RateLimiter, clientKey } from "../../src/service/rate-limit.ts";

/**
 * Per-IP rate limiting. The routes exercised never reach the order service (an empty
 * stand-in). Addresses are documentation/test ranges.
 */

describe("RateLimiter", () => {
  it("allows a burst of perMinute, then refills at perMinute/60 per second", () => {
    let t = 0;
    const rl = new RateLimiter({ perMinute: 6, now: () => t });
    for (let i = 0; i < 6; i++) expect(rl.take("a").ok).toBe(true);
    expect(rl.take("a")).toEqual({ ok: false, retryAfterSecs: 10 }); // one token per 10 s
    expect(rl.take("b").ok).toBe(true); // another client has its own bucket
    t = 9_000;
    expect(rl.take("a").ok).toBe(false);
    t = 10_000;
    expect(rl.take("a").ok).toBe(true);
    expect(rl.take("a").ok).toBe(false);
    t = 10_000 + 3_600_000; // a long pause refills to the cap, not beyond
    for (let i = 0; i < 6; i++) expect(rl.take("a").ok).toBe(true);
    expect(rl.take("a").ok).toBe(false);
  });

  it("keeps at most maxClients buckets, dropping the least recently used", () => {
    const rl = new RateLimiter({ perMinute: 1, now: () => 0, maxClients: 3 });
    for (const k of ["a", "b", "c"]) rl.take(k);
    expect(rl.take("a").ok).toBe(false); // a is now the most recent
    rl.take("d"); // drops b
    expect(rl.size()).toBe(3);
    expect(rl.take("b").ok).toBe(true); // b started over (only ever in the client's favour)
    expect(rl.take("a").ok).toBe(false); // a was kept
  });

  it("refuses a non-positive limit", () => {
    expect(() => new RateLimiter({ perMinute: 0, now: () => 0 })).toThrow(RangeError);
  });
});

describe("clientKey", () => {
  it("on Railway: the X-Real-IP its edge sets; otherwise the TCP peer", () => {
    expect(clientKey("railway", "203.0.113.7", "10.0.0.2")).toBe("203.0.113.7");
    expect(clientKey("none", "203.0.113.7", "10.0.0.2")).toBe("10.0.0.2");
    // A missing or malformed header falls back to the peer, never to a client-chosen string.
    expect(clientKey("railway", undefined, "10.0.0.2")).toBe("10.0.0.2");
    expect(clientKey("railway", "203.0.113.7, 198.51.100.1", "10.0.0.2")).toBe("10.0.0.2");
    expect(clientKey("railway", "anything-goes", "10.0.0.2")).toBe("10.0.0.2");
    expect(clientKey("none", undefined, undefined)).toBe("unknown");
  });

  it("unwraps IPv4-mapped IPv6 and groups IPv6 by /64", () => {
    expect(clientKey("none", undefined, "::ffff:203.0.113.7")).toBe("203.0.113.7");
    const a = clientKey("railway", "2001:db8:1:2:aaaa::1", undefined);
    expect(a).toBe("2001:db8:1:2::/64");
    expect(clientKey("railway", "2001:0db8:0001:0002:ffff:ffff:ffff:fffe", undefined)).toBe(a);
    expect(clientKey("railway", "2001:db8:1:3::1", undefined)).not.toBe(a);
    expect(clientKey("railway", "::1", undefined)).toBe("0:0:0:0::/64");
    expect(clientKey("railway", "2001:db8::", undefined)).toBe("2001:db8:0:0::/64");
  });
});

describe("rate-limited HTTP API", () => {
  const SITE = "https://niaraglobal.com";
  let t = 0;
  // The key reads X-Real-IP the way main.ts does on Railway; X-Forwarded-For is ignored.
  const app = createApp({} as OrderService, {
    maxBodyBytes: 4096,
    corsOrigins: [SITE],
    rateLimit: {
      readsPerMinute: 3,
      writesPerMinute: 2,
      key: (c) => clientKey("railway", c.req.header("x-real-ip"), "10.0.0.2"),
      now: () => t,
    },
  });
  const get = (ip: string, extra: Record<string, string> = {}) => app.request("/health", { headers: { "x-real-ip": ip, ...extra } });
  const post = (ip: string) =>
    app.request("/v1/orders", { method: "POST", headers: { "x-real-ip": ip, "content-type": "application/json", origin: SITE }, body: "{" });

  it("limits reads per IP with 429, Retry-After and the CORS header for the site", async () => {
    t = 0;
    for (let i = 0; i < 3; i++) expect((await get("198.51.100.1")).status).toBe(200);
    const r = await get("198.51.100.1", { origin: SITE });
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBe("20");
    expect(r.headers.get("access-control-allow-origin")).toBe(SITE);
    expect(await r.json()).toMatchObject({ error: "rate_limited", retryAfterSecs: 20 });
    expect((await get("198.51.100.1", { origin: "https://evil.example" })).headers.get("access-control-allow-origin")).toBeNull();
    expect((await get("198.51.100.2")).status).toBe(200); // another client
  });

  it("is stricter on POST, in a bucket of its own", async () => {
    t = 1_000_000;
    // Malformed bodies: the limiter runs first, so these never reach the service.
    expect((await post("198.51.100.3")).status).toBe(400);
    expect((await post("198.51.100.3")).status).toBe(400);
    const r = await post("198.51.100.3");
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBe("30");
    expect((await get("198.51.100.3")).status).toBe(200); // reads unaffected
  });

  it("counts preflights, and X-Forwarded-For cannot buy a fresh allowance", async () => {
    t = 2_000_000;
    const preflight = (xff: string) =>
      app.request("/v1/orders", {
        method: "OPTIONS",
        headers: { "x-real-ip": "198.51.100.4", "x-forwarded-for": xff, origin: SITE, "access-control-request-method": "POST" },
      });
    for (let i = 0; i < 3; i++) expect((await preflight(`192.0.2.${i}`)).status).toBe(204);
    expect((await preflight("192.0.2.99")).status).toBe(429);
  });
});
