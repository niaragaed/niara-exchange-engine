import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  MARKET_ORDER_DEFAULT_SLIPPAGE_BPS,
  MARKET_ORDER_MAX_SLIPPAGE_BPS,
  MarketOrderError,
  marketOrderLimitPrice,
  requiredApproval,
} from "../../src/intents/market-order.ts";
import { orderNeed } from "../../src/solana/coverage.ts";

/** Market order = IOC with a price cap set by the client from the best opposite price. */

describe("market order price cap", () => {
  it("defaults to 1% and allows at most 5%", () => {
    expect(MARKET_ORDER_DEFAULT_SLIPPAGE_BPS).toBe(100);
    expect(MARKET_ORDER_MAX_SLIPPAGE_BPS).toBe(500);
    expect(marketOrderLimitPrice("buy", 25_000_000n)).toBe(25_250_000n);
    expect(marketOrderLimitPrice("sell", 25_000_000n)).toBe(24_750_000n);
    expect(marketOrderLimitPrice("buy", 25_000_000n, 500)).toBe(26_250_000n);
    expect(marketOrderLimitPrice("sell", 25_000_000n, 0)).toBe(25_000_000n);
    for (const bad of [501, -1, 1.5, Number.NaN]) expect(() => marketOrderLimitPrice("buy", 25_000_000n, bad)).toThrow(MarketOrderError);
  });

  it("refuses an empty opposite side or a non-positive price", () => {
    expect(() => marketOrderLimitPrice("buy", null)).toThrow(/no ask/);
    expect(() => marketOrderLimitPrice("sell", undefined)).toThrow(/no bid/);
    expect(() => marketOrderLimitPrice("buy", 0n)).toThrow(MarketOrderError);
  });

  it("rounds so the cap never exceeds the slippage, and never crosses below the best price on the wrong side", () => {
    expect(marketOrderLimitPrice("buy", 99n, 100)).toBe(99n); // 99.99 -> 99
    expect(marketOrderLimitPrice("sell", 99n, 100)).toBe(99n); // 98.01 -> 99
    expect(marketOrderLimitPrice("sell", 1n, 500)).toBe(1n);
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 10n ** 30n }), fc.integer({ min: 0, max: 500 }), (best, bps) => {
        const buy = marketOrderLimitPrice("buy", best, bps);
        const sell = marketOrderLimitPrice("sell", best, bps);
        // Buy: at least the best ask (it can take it), at most best + slippage.
        expect(buy >= best).toBe(true);
        expect(buy * 10_000n <= best * (10_000n + BigInt(bps))).toBe(true);
        // Sell: at most the best bid, at least best - slippage, and positive.
        expect(sell <= best && sell >= 1n).toBe(true);
        expect(sell * 10_000n >= best * (10_000n - BigInt(bps))).toBe(true);
      }),
      { numRuns: 500 },
    );
  });
});

describe("approvals", () => {
  const base = { asset: "TEST-ASSET", paymentAsset: "TEST-USDT", quantity: 7_000_000n, lotSize: 1_000_000n };
  it("an IOC buy approves quantity x its limit price (the cap), a sell its quantity", () => {
    const cap = marketOrderLimitPrice("buy", 25_000_000n); // 25.25
    expect(requiredApproval({ ...base, side: "buy", limitPrice: cap })).toEqual({ mint: "TEST-USDT", amount: 7n * 25_250_000n });
    expect(requiredApproval({ ...base, side: "sell", limitPrice: 1n })).toEqual({ mint: "TEST-ASSET", amount: 7_000_000n });
  });

  it("is exactly what the service checks at admission (orderNeed on the whole quantity)", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("buy" as const, "sell" as const),
        fc.bigInt({ min: 1n, max: 1000n }),
        fc.bigInt({ min: 1n, max: 10n ** 9n }),
        fc.bigInt({ min: 1n, max: 10n ** 12n }),
        (side, lots, lotSize, limitPrice) => {
          const i = { ...base, side, wallet: "TEST-WALLET", quantity: lots * lotSize, lotSize, limitPrice };
          const need = orderNeed({ ...i, remaining: i.quantity });
          expect(requiredApproval(i)).toEqual({ mint: need.mint, amount: need.amount });
        },
      ),
    );
  });
});
