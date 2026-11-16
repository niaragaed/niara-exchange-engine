import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { OrderService, Reply } from "./order-service.ts";

/**
 * HTTP API of the order service. TESTNET ONLY. Amounts are decimal strings in JSON.
 *
 *   POST /v1/orders          { intent, signature }   submit a signed order intent
 *   POST /v1/orders/cancel   { cancel, signature }   cancel an order (signed, by nonce)
 *   GET  /v1/books/:chain/:asset                     public book (price levels only)
 *   GET  /health
 *
 * Bodies above `maxBodyBytes` are refused with 413 before they are parsed.
 */
export function createApp(
  service: OrderService,
  options: { maxBodyBytes: number; log?: (event: string, data?: Record<string, unknown>) => void },
): Hono {
  const app = new Hono();
  const send = (c: Context, r: Reply) => c.json(r.body, r.status as ContentfulStatusCode);

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

  app.get("/v1/books/:chain/:asset", async (c) => send(c, await service.book(c.req.param("chain"), c.req.param("asset"))));

  app.get("/health", (c) =>
    c.json({ status: "ok", testnet: true, notice: "TESTNET ONLY: no real assets, no real money. Matches are not settled by this service." }),
  );

  app.notFound((c) => c.json({ error: "not_found" }, 404));
  // Never leak internals in an error response.
  app.onError((err, c) => {
    options.log?.("http_error", { error: err.message });
    return c.json({ error: "internal_error" }, 500);
  });
  return app;
}
