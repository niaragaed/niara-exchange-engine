import { describe, expect, it } from "vitest";
import { createApp } from "../../src/service/http.ts";
import type { OrderService } from "../../src/service/order-service.ts";
import { NO_CLIENT_IP, RateLimiter, clientKey } from "../../src/service/rate-limit.ts";

/**
 * Per-IP rate limiting. The routes exercised never reach the order service (an empty
 * stand-in). Addresses are documentation/test ranges.
 */

describe("RateLimiter (sliding 60 s window)", () => {
  it("admits perMinute in any 60 s, however slowly they arrive, then refuses until the oldest expire", () => {
    let t = 0;
    const rl = new RateLimiter({ perMinute: 30, now: () => t });
    // One request every 1.5 s (a slow client): a token bucket refilling 0.5/s let these through.
    for (let i = 0; i < 30; i++) {
      t = i * 1_500;
      expect(rl.take("a").ok).toBe(true);
    }
    t = 30 * 1_500; // 45 s after the first: still inside its minute
    expect(rl.take("a")).toEqual({ ok: false, retryAfterSecs: 15 }); // the first expires at 60 s
    expect(rl.take("b").ok).toBe(true); // another client has its own window
    t = 59_999;
    expect(rl.take("a").ok).toBe(false);
    t = 60_000; // the request of second 0 left the window
    expect(rl.take("a").ok).toBe(true);
    expect(rl.take("a").ok).toBe(false); // refused requests are not counted, the window is full again
  });

  it("a burst fills the window; a long pause empties it", () => {
    let t = 5_000;
    const rl = new RateLimiter({ perMinute: 6, now: () => t });
    for (let i = 0; i < 6; i++) expect(rl.take("a").ok).toBe(true);
    expect(rl.take("a")).toEqual({ ok: false, retryAfterSecs: 60 });
    t = 5_000 + 3_600_000;
    for (let i = 0; i < 6; i++) expect(rl.take("a").ok).toBe(true);
    expect(rl.take("a").ok).toBe(false);
  });

  it("a clock step back never refills a window", () => {
    let t = 100_000;
    const rl = new RateLimiter({ perMinute: 2, now: () => t });
    rl.take("a");
    rl.take("a");
    t = 10_000;
    expect(rl.take("a").ok).toBe(false);
  });

  it("keeps at most maxClients windows, dropping the least recently seen", () => {
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
  it("on Railway: only the X-Real-IP its edge sets, never the TCP peer", () => {
    expect(clientKey("railway", "203.0.113.7", "10.0.0.2")).toBe("203.0.113.7");
    // Missing or unusable header: the one shared bucket, not the (varying) proxy address.
    expect(clientKey("railway", undefined, "10.0.0.2")).toBe(NO_CLIENT_IP);
    expect(clientKey("railway", undefined, "10.0.0.3")).toBe(NO_CLIENT_IP);
    expect(clientKey("railway", "", "10.0.0.2")).toBe(NO_CLIENT_IP);
    expect(clientKey("railway", "anything-goes", "10.0.0.2")).toBe(NO_CLIENT_IP);
    // Several values (a client copy the edge appended to): the last, the edge's.
    expect(clientKey("railway", "198.51.100.1, 203.0.113.7", "10.0.0.2")).toBe("203.0.113.7");
    expect(clientKey("railway", "198.51.100.99,203.0.113.7", undefined)).toBe("203.0.113.7");
    expect(clientKey("railway", "203.0.113.7, junk", undefined)).toBe(NO_CLIENT_IP);
  });

  it("locally: the TCP peer, never the header", () => {
    expect(clientKey("none", "203.0.113.7", "10.0.0.2")).toBe("10.0.0.2");
    expect(clientKey("none", "203.0.113.7", undefined)).toBe(NO_CLIENT_IP);
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
    expect(r.headers.get("retry-after")).toBe("60");
    expect(r.headers.get("access-control-allow-origin")).toBe(SITE);
    expect(await r.json()).toMatchObject({ error: "rate_limited", retryAfterSecs: 60 });
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
    expect(r.headers.get("retry-after")).toBe("60");
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

describe("rate-limited HTTP API at production limits (30 writes, 300 reads per minute)", () => {
  // Railway mode: the key is what main.ts derives. `edge` plays Railway's edge: the
  // X-Real-IP it sets; a client copy, when sent, is what the edge appended to.
  let t = 0;
  const submitted: unknown[] = [];
  const service = {
    submitOrder: async (body: unknown) => {
      submitted.push(body);
      return { status: 201, body: { order: { id: "stub (test)" }, matches: [] } };
    },
  } as unknown as OrderService;
  const make = () =>
    createApp(service, {
      maxBodyBytes: 4096,
      rateLimit: {
        readsPerMinute: 300,
        writesPerMinute: 30,
        key: (c) => clientKey("railway", c.req.header("x-real-ip"), "10.0.0.2"),
        now: () => t,
      },
    });
  const edgeHeaders = (edge: string | undefined, forged?: string): Record<string, string> => {
    const values = [forged, edge].filter((v): v is string => v !== undefined);
    return values.length ? { "x-real-ip": values.join(", ") } : {};
  };
  const postOrder = (app: ReturnType<typeof make>, edge: string | undefined, body: string, forged?: string) =>
    app.request("/v1/orders", { method: "POST", headers: { "content-type": "application/json", ...edgeHeaders(edge, forged) }, body });
  const tick = () => (t += 1_500); // 31 requests over 45 s: well inside one minute

  for (const [name, body] of [
    ["an empty object", "{}"],
    ["malformed JSON", "{"],
    ["a valid body", JSON.stringify({ intent: {}, signature: "stub" })],
  ] as const) {
    it(`the 31st POST in a minute gets 429 (${name})`, async () => {
      t = 0;
      const app = make();
      for (let i = 0; i < 30; i++, tick()) expect((await postOrder(app, "203.0.113.10", body)).status).not.toBe(429);
      const r = await postOrder(app, "203.0.113.10", body);
      expect(r.status).toBe(429);
      expect(Number(r.headers.get("retry-after"))).toBe(15);
      expect((await postOrder(app, "203.0.113.11", body)).status).not.toBe(429); // another client
    });
  }

  it("refused POSTs never reach the service", async () => {
    t = 0;
    submitted.length = 0;
    const app = make();
    const valid = JSON.stringify({ intent: {}, signature: "stub" });
    for (let i = 0; i < 35; i++) await postOrder(app, "203.0.113.12", valid);
    expect(submitted).toHaveLength(30);
  });

  it("GET: the 301st read in a minute gets 429; POSTs are counted apart", async () => {
    t = 0;
    const app = make();
    const get = () => app.request("/v1/markets", { headers: edgeHeaders("203.0.113.20") });
    for (let i = 0; i < 300; i++) {
      t = i * 150;
      expect((await get()).status).not.toBe(429);
    }
    expect((await get()).status).toBe(429);
    expect((await postOrder(app, "203.0.113.20", "{")).status).toBe(400);
  });

  it("404 paths count, and get 429 past the limit", async () => {
    t = 0;
    const app = make();
    const miss = (i: number) => app.request(`/nope/${i}`, { headers: edgeHeaders("203.0.113.30") });
    for (let i = 0; i < 300; i++) expect((await miss(i)).status).toBe(404);
    expect((await miss(300)).status).toBe(429);
    expect((await app.request("/health", { headers: edgeHeaders("203.0.113.30") })).status).toBe(429); // same window
    const postMiss = (i: number) => app.request(`/v1/nope/${i}`, { method: "POST", headers: edgeHeaders("203.0.113.31"), body: "{}" });
    for (let i = 0; i < 30; i++) expect((await postMiss(i)).status).toBe(404);
    expect((await postMiss(30)).status).toBe(429);
  });

  it("a client-sent X-Real-IP creates no new bucket while the edge's header is present", async () => {
    t = 0;
    const app = make();
    for (let i = 0; i < 30; i++) expect((await postOrder(app, "203.0.113.40", "{}", `198.51.100.${i}`)).status).not.toBe(429);
    expect((await postOrder(app, "203.0.113.40", "{}", "198.51.100.200")).status).toBe(429);
    expect((await postOrder(app, "203.0.113.40", "{}")).status).toBe(429);
  });

  it("requests without the edge's header share ONE bucket, never unlimited", async () => {
    t = 0;
    const app = make();
    for (let i = 0; i < 30; i++) expect((await postOrder(app, undefined, "{}")).status).not.toBe(429);
    expect((await postOrder(app, undefined, "{}")).status).toBe(429);
    // An unusable header lands in the same shared bucket, not in a fresh one.
    const r = await app.request("/v1/orders", { method: "POST", headers: { "x-real-ip": "not-an-ip" }, body: "{}" });
    expect(r.status).toBe(429);
  });
});
