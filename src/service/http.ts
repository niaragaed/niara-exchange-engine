import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { OrderService, Reply } from "./order-service.ts";
import { RateLimiter } from "./rate-limit.ts";

/**
 * HTTP API of the order service. TESTNET ONLY. Amounts are decimal strings in JSON.
 *
 *   POST /v1/orders          { intent, signature }   submit a signed order intent
 *   POST /v1/orders/cancel   { cancel, signature }   cancel an order (signed, by nonce)
 *   GET  /v1/orders?chain=&wallet=[&limit=&before=]  a wallet's orders, newest first (unsigned: testnet only)
 *   GET  /v1/orders/:id                              one order's current state, with its matches
 *   GET  /v1/markets                                 chains (settlement enabled?) and their approved equity markets
 *   GET  /v1/books/:chain/:asset                     public book (price levels only)
 *   GET  /v1/matches?chain=&wallet=[&limit=&before=] a wallet's matches with settlement status and tx hash (unsigned: testnet only)
 *   GET  /v1/matches/:id                             a match's settlement status and tx hash
 *   GET  /v1/trades/:chain/:asset[?limit=&before=&since=]  settled trades of a market (no wallets)
 *   GET  /health                                     {status: "ok"}; "standby" while waiting for the instance lock
 *
 * Bodies above `maxBodyBytes` are refused with 413 before they are parsed.
 *
 * Rate limits (`rateLimit`): per client IP (see rate-limit.ts), on every path,
 * preflights included; POST has its own, stricter bucket. Over the limit: 429
 * `rate_limited` with Retry-After (and the CORS header for a listed origin, so the
 * site can read it).
 *
 * CORS: only the exact origins of `corsOrigins` (CORS_ORIGINS) get
 * `Access-Control-Allow-Origin`, never `*`; methods GET, POST, OPTIONS; request header
 * content-type; no credentials. Preflights (OPTIONS) are answered 204 for every path.
 */
export interface EdgeOptions {
  corsOrigins?: readonly string[];
  rateLimit?: {
    readsPerMinute: number;
    writesPerMinute: number;
    /** The client's rate-limit key (its IP; see `clientKey`). */
    key: (c: Context) => string;
    /** Milliseconds; injected for tests. */
    now?: () => number;
  };
  log?: (event: string, data?: Record<string, unknown>) => void;
}

const TESTNET_NOTICE = "TESTNET ONLY: no real assets, no real money. Solana devnet matches are settled on devnet by the settlement worker.";

export function createApp(service: OrderService, options: EdgeOptions & { maxBodyBytes: number }): Hono {
  const app = new Hono();
  const send = (c: Context, r: Reply) => c.json(r.body, r.status as ContentfulStatusCode);
  installEdge(app, options);

  app.use(
    "/v1/*",
    bodyLimit({
      maxSize: options.maxBodyBytes,
      onError: (c) => c.json({ error: "body_too_large", detail: `at most ${options.maxBodyBytes} bytes` }, 413),
    }),
  );

  const readJson = async (req: { json: () => Promise<unknown> }): Promise<{ ok: true; body: unknown } | { ok: false }> => {
    try {
      return { ok: true, body: await req.json() };
    } catch {
      return { ok: false };
    }
  };

  app.post("/v1/orders", async (c) => {
    const parsed = await readJson(c.req);
    if (!parsed.ok) return c.json({ error: "malformed_json" }, 400);
    return send(c, await service.submitOrder(parsed.body));
  });

  app.post("/v1/orders/cancel", async (c) => {
    const parsed = await readJson(c.req);
    if (!parsed.ok) return c.json({ error: "malformed_json" }, 400);
    return send(c, await service.cancelOrder(parsed.body));
  });

  app.get("/v1/orders", async (c) => send(c, await service.walletOrders(c.req.query())));

  app.get("/v1/orders/:id", async (c) => send(c, await service.orderStatus(c.req.param("id"))));

  app.get("/v1/markets", (c) => send(c, service.markets()));

  app.get("/v1/books/:chain/:asset", async (c) => send(c, await service.book(c.req.param("chain"), c.req.param("asset"))));

  app.get("/v1/trades/:chain/:asset", async (c) =>
    send(c, await service.trades(c.req.param("chain"), c.req.param("asset"), c.req.query())),
  );

  app.get("/v1/matches", async (c) => send(c, await service.walletMatches(c.req.query())));

  app.get("/v1/matches/:id", async (c) => send(c, await service.settlementStatus(c.req.param("id"))));

  app.get("/health", (c) =>
    c.json({ status: "ok", testnet: true, notice: TESTNET_NOTICE }),
  );

  app.notFound((c) => c.json({ error: "not_found" }, 404));
  // Never leak internals in an error response.
  app.onError((err, c) => {
    options.log?.("http_error", { error: err.message });
    return c.json({ error: "internal_error" }, 500);
  });
  return app;
}

/**
 * The front every response goes through, serving or standby: the per-IP rate limit
 * first (no request, preflights included, does any work over the limit), then CORS
 * (so preflights and error responses carry its headers).
 */
function installEdge(app: Hono, options: EdgeOptions): void {
  const origins = [...(options.corsOrigins ?? [])];
  if (origins.includes("*")) throw new Error("CORS origins must be listed one by one, never *");
  if (options.rateLimit) {
    const rl = options.rateLimit;
    const now = rl.now ?? Date.now;
    const reads = new RateLimiter({ perMinute: rl.readsPerMinute, now });
    const writes = new RateLimiter({ perMinute: rl.writesPerMinute, now });
    app.use("*", async (c, next) => {
      const method = c.req.method;
      const write = method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
      const verdict = (write ? writes : reads).take(rl.key(c));
      if (verdict.ok) return next();
      const origin = c.req.header("origin");
      if (origin && origins.includes(origin)) {
        c.header("Access-Control-Allow-Origin", origin);
        c.header("Vary", "Origin");
      }
      c.header("Retry-After", String(verdict.retryAfterSecs));
      return c.json(
        {
          error: "rate_limited",
          detail: `too many ${write ? "order submissions or cancellations" : "requests"} from this address; retry in ${verdict.retryAfterSecs} s`,
          retryAfterSecs: verdict.retryAfterSecs,
        },
        429,
      );
    });
  }
  app.use(
    "*",
    cors({
      origin: (origin) => (origins.includes(origin) ? origin : null),
      allowMethods: ["GET", "POST", "OPTIONS"],
      allowHeaders: ["content-type"],
      credentials: false,
      maxAge: 600,
    }),
  );
}

/**
 * While the process waits for the single-instance lock (a redeploy: the previous
 * deployment still holds it; see startup.ts): /health answers 200 "standby", so the
 * platform can switch traffic and stop the previous deployment, and every other path
 * answers 503 `starting` with Retry-After. Nothing is read or written.
 */
export function createStandbyApp(options: EdgeOptions): Hono {
  const app = new Hono();
  installEdge(app, options);
  app.get("/health", (c) =>
    c.json({
      status: "standby",
      testnet: true,
      notice: TESTNET_NOTICE,
      detail: "waiting for the previous instance to stop and release the single-instance lock; not serving yet",
    }),
  );
  app.all("*", (c) => {
    c.header("Retry-After", "5");
    return c.json({ error: "starting", detail: "the service is starting (a deployment is switching over); retry in a few seconds" }, 503);
  });
  return app;
}
