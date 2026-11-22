import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { OrderService, Reply } from "./order-service.ts";

/**
 * HTTP API of the order service. TESTNET ONLY. Amounts are decimal strings in JSON.
 *
 *   POST /v1/orders          { intent, signature }   submit a signed order intent
 *   POST /v1/orders/cancel   { cancel, signature }   cancel an order (signed, by nonce)
 *   GET  /v1/orders?chain=&wallet=[&limit=&before=]  a wallet's orders, newest first (unsigned: testnet only)
 *   GET  /v1/orders/:id                              one order's current state, with its matches
 *   GET  /v1/books/:chain/:asset                     public book (price levels only)
 *   GET  /v1/matches/:id                             a match's settlement status and tx hash
 *   GET  /health
 *
 * Bodies above `maxBodyBytes` are refused with 413 before they are parsed.
 *
 * CORS: only the exact origins of `corsOrigins` (CORS_ORIGINS) get
 * `Access-Control-Allow-Origin`, never `*`; methods GET, POST, OPTIONS; request header
 * content-type; no credentials. Preflights (OPTIONS) are answered 204 for every path.
 */
export function createApp(
  service: OrderService,
  options: {
    maxBodyBytes: number;
    corsOrigins?: readonly string[];
    log?: (event: string, data?: Record<string, unknown>) => void;
  },
): Hono {
  const app = new Hono();
  const send = (c: Context, r: Reply) => c.json(r.body, r.status as ContentfulStatusCode);

  // First, so that preflights and error responses carry the CORS headers too.
  const origins = [...(options.corsOrigins ?? [])];
  if (origins.includes("*")) throw new Error("CORS origins must be listed one by one, never *");
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

  app.get("/v1/books/:chain/:asset", async (c) => send(c, await service.book(c.req.param("chain"), c.req.param("asset"))));

  app.get("/v1/matches/:id", async (c) => send(c, await service.settlementStatus(c.req.param("id"))));

  app.get("/health", (c) =>
    c.json({ status: "ok", testnet: true, notice: "TESTNET ONLY: no real assets, no real money. Solana devnet matches are settled on devnet by the settlement worker." }),
  );

  app.notFound((c) => c.json({ error: "not_found" }, 404));
  // Never leak internals in an error response.
  app.onError((err, c) => {
    options.log?.("http_error", { error: err.message });
    return c.json({ error: "internal_error" }, 500);
  });
  return app;
}
