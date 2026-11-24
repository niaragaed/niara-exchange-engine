import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { CounterOrderError, counterDelegation, counterIntent, engineUrl, ordersSharingDelegation, type CounterMarket } from "../../src/devnet/counter-order.ts";
import { parseOrderIntent } from "../../src/intents/validate.ts";
import { verifyIntentSignature } from "../../src/intents/verify.ts";
import { solanaIntentMessage } from "../../src/intents/solana.ts";

/** The devnet counter order: intent, exact delegation, and the shared-delegation guard. Keys generated per run. */

const key = () => Keypair.generate().publicKey.toBase58();
const market: CounterMarket = { program: key(), asset: key(), assetDecimals: 0, lotSize: 1n, usdt: key(), usdtDecimals: 6 };
const args = { wallet: key(), side: "sell" as const, quantity: "5", price: "25", expiresAt: 1_900_000_000, nonce: "ab".repeat(16) };

describe("counter order intent", () => {
  it("builds a valid solana-devnet intent: shares to base units, price per lot in mockUSDT base units", () => {
    const i = counterIntent(market, args);
    expect(i).toMatchObject({ chain: "solana-devnet", side: "sell", quantity: 5n, lotSize: 1n, limitPrice: 25_000_000n, settlement: market.program });
    // The service's parser accepts it (amounts as strings, as sent over HTTP).
    const wire = JSON.parse(JSON.stringify(i, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
    expect(parseOrderIntent(wire)).toEqual(i);
    expect(counterIntent(market, { ...args, price: "25.5" }).limitPrice).toBe(25_500_000n);
  });

  it("scales the price to the lot for a divisible asset", () => {
    const m = { ...market, assetDecimals: 2, lotSize: 50n }; // a lot is half a share
    const i = counterIntent(m, { ...args, quantity: "3", price: "10" });
    expect(i.quantity).toBe(300n);
    expect(i.limitPrice).toBe(5_000_000n); // 10 mockUSDT per share = 5 per lot
    expect(() => counterIntent(m, { ...args, quantity: "0.25" })).toThrow(/whole number of lots/);
  });

  it("refuses zero or fractional quantities, a zero price, a bad side and a bad nonce", () => {
    expect(() => counterIntent(market, { ...args, quantity: "0" })).toThrow(CounterOrderError);
    expect(() => counterIntent(market, { ...args, quantity: "1.5" })).toThrow(/decimal places/);
    expect(() => counterIntent(market, { ...args, price: "0" })).toThrow(/price/);
    expect(() => counterIntent(market, { ...args, side: "hold" as never })).toThrow(/side/);
    expect(() => counterIntent(market, { ...args, nonce: "XYZ" })).toThrow(/nonce/);
  });

  it("delegates exactly what the service checks: the tEQTY for a sell, quantity x price for a buy", () => {
    expect(counterDelegation(counterIntent(market, args))).toEqual({ wallet: args.wallet, mint: market.asset, amount: 5n });
    expect(counterDelegation(counterIntent(market, { ...args, side: "buy" }))).toEqual({ wallet: args.wallet, mint: market.usdt, amount: 125_000_000n });
  });

  it("is signed over the same text the service verifies", async () => {
    const kp = Keypair.generate();
    const i = counterIntent(market, { ...args, wallet: kp.publicKey.toBase58() });
    const { signAsync } = await import("@noble/ed25519");
    const { base58 } = await import("@scure/base");
    const sig = base58.encode(await signAsync(solanaIntentMessage(i), kp.secretKey.subarray(0, 32)));
    expect(await verifyIntentSignature(i, sig)).toBe(true);
  });
});

describe("shared delegation guard", () => {
  const intent = counterIntent(market, args);
  const order = (over: Partial<{ id: string; side: string; status: string; asset: string; paymentAsset: string }>) => ({
    id: "o",
    side: "sell",
    status: "open",
    asset: market.asset,
    paymentAsset: market.usdt,
    ...over,
  });

  it("finds the wallet's live orders on the same token account, and ignores the others", () => {
    expect(
      ordersSharingDelegation(
        [
          order({ id: "live-sell" }),
          order({ id: "partial", status: "partially_filled" }),
          order({ id: "stale", status: "stale" }),
          order({ id: "done", status: "filled" }),
          order({ id: "cancelled", status: "cancelled" }),
          order({ id: "a-buy", side: "buy" }), // USDT account: not touched by a sell's approval
          order({ id: "other-asset", asset: key() }),
        ],
        intent,
      ),
    ).toEqual(["live-sell", "partial", "stale"]);
    const buy = counterIntent(market, { ...args, side: "buy" });
    expect(ordersSharingDelegation([order({ id: "s" }), order({ id: "b", side: "buy" })], buy)).toEqual(["b"]);
  });
});

describe("engineUrl (--engine-url)", () => {
  it("accepts https anywhere and http only for localhost, returning the origin", () => {
    expect(engineUrl("https://api.niaraglobal.com")).toBe("https://api.niaraglobal.com");
    expect(engineUrl("https://api.niaraglobal.com/")).toBe("https://api.niaraglobal.com");
    expect(engineUrl("http://127.0.0.1:8787")).toBe("http://127.0.0.1:8787");
    expect(engineUrl("http://localhost:8787")).toBe("http://localhost:8787");
    expect(engineUrl("http://[::1]:8787")).toBe("http://[::1]:8787");
  });

  it("refuses plain http to any other host, other schemes, paths and credentials", () => {
    for (const bad of [
      "http://api.niaraglobal.com",
      "http://127.0.0.1.evil.example",
      "http://localhost.evil.example",
      "http://10.0.0.5:8787",
      "ftp://api.niaraglobal.com",
      "https://api.niaraglobal.com/v1",
      "https://user:pw@api.niaraglobal.com",
      "https://api.niaraglobal.com?x=1",
      "api.niaraglobal.com",
      "",
    ]) {
      expect(() => engineUrl(bad), bad).toThrow(CounterOrderError);
    }
  });
});
