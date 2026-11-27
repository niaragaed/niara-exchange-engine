import fc from "fast-check";
import { getAddress } from "viem";
import { beforeAll, describe, expect, it } from "vitest";
import { MatchingEngine } from "../../src/engine/engine.ts";
import { parseOrderIntent, validateIntent } from "../../src/intents/validate.ts";
import { admitOrderIntent, verifyIntentSignature, type ChainConfig } from "../../src/intents/verify.ts";
import type { OrderIntent } from "../../src/intents/types.ts";
import { seededUuidV4 } from "../engine/helpers.ts";
import {
  DAY,
  EVM_SETTLEMENT,
  EVM_USDT,
  NOW,
  SOL_PROGRAM,
  SOL_USDT,
  evmIntent,
  evmSigner,
  patternedSolanaAddress,
  solanaIntent,
  solanaSigner,
  type SolanaSigner,
} from "./fixtures.ts";

const MAX_VALIDITY = 30 * DAY;
const SOLANA: ChainConfig = {
  chain: "solana-devnet",
  settlementProgram: SOL_PROGRAM,
  quoteAsset: SOL_USDT,
  maxIntentValiditySecs: MAX_VALIDITY,
};
const BASE: ChainConfig = {
  chain: "base-sepolia",
  settlementProgram: EVM_SETTLEMENT,
  quoteAsset: EVM_USDT,
  maxIntentValiditySecs: MAX_VALIDITY,
};

let sol: SolanaSigner;
const evm = evmSigner();

beforeAll(async () => {
  sol = await solanaSigner();
});

function toJson(i: OrderIntent): Record<string, unknown> {
  return { ...i, quantity: i.quantity.toString(), lotSize: i.lotSize.toString(), limitPrice: i.limitPrice.toString() };
}

describe("intent validation", () => {
  it("requires an expiry (spec §9.12)", () => {
    const { expiresAt: _drop, ...rest } = toJson(solanaIntent(sol.wallet));
    expect(() => parseOrderIntent(rest)).toThrow(/expiresAt is required/);
    expect(() => validateIntent(solanaIntent(sol.wallet, { expiresAt: 0 }))).toThrow(/expiresAt/);
    expect(() => validateIntent(solanaIntent(sol.wallet, { expiresAt: NOW + 0.5 }))).toThrow(/expiresAt/);
  });

  it("requires positive whole lots and a positive price", () => {
    expect(() => validateIntent(solanaIntent(sol.wallet, { quantity: 0n }))).toThrow(/quantity/);
    expect(() => validateIntent(solanaIntent(sol.wallet, { limitPrice: -1n }))).toThrow(/limitPrice/);
    expect(() => validateIntent(solanaIntent(sol.wallet, { lotSize: 0n }))).toThrow(/lotSize/);
    expect(() => validateIntent(solanaIntent(sol.wallet, { quantity: 1_500_000n }))).toThrow(/multiple/);
  });

  it("bounds amounts by the on-chain width: u64 on Solana, uint256 on EVM", () => {
    const u64 = (1n << 64n) - 1n;
    expect(() => validateIntent(solanaIntent(sol.wallet, { quantity: u64 + 1n, lotSize: 1n }))).toThrow(/u64/);
    // Notional = quantity / lot * price must fit too (the payment_amount of settle).
    expect(() => validateIntent(solanaIntent(sol.wallet, { quantity: 2n, lotSize: 1n, limitPrice: u64 }))).toThrow(/u64/);
    expect(validateIntent(evmIntent(evm.wallet, { quantity: 2n, lotSize: 1n, limitPrice: u64 })).limitPrice).toBe(u64);
  });

  it("requires valid, canonical addresses of the chain's kind", () => {
    expect(() => validateIntent(solanaIntent(sol.wallet, { asset: EVM_USDT }))).toThrow(/base58/);
    expect(() => validateIntent(evmIntent(evm.wallet, { asset: SOL_USDT }))).toThrow(/address/);
    expect(() => validateIntent(evmIntent(evm.wallet, { asset: "0x0000000000000000000000000000000000000000" }))).toThrow(
      /zero/,
    );
    expect(() => validateIntent(solanaIntent(sol.wallet, { paymentAsset: solanaIntent(sol.wallet).asset }))).toThrow(
      /differ/,
    );
    // Leading-zero-byte variants of base58 are not canonical.
    expect(() => validateIntent(solanaIntent(sol.wallet, { asset: `1${patternedSolanaAddress(2)}` }))).toThrow(/base58/);
    expect(validateIntent(evmIntent(evm.wallet.toLowerCase())).wallet).toBe(getAddress(evm.wallet));
  });

  it("requires a 16-byte non-zero hex nonce, a known chain, a side and a known version", () => {
    expect(() => validateIntent(solanaIntent(sol.wallet, { nonce: "abc" }))).toThrow(/nonce/);
    expect(() => validateIntent(solanaIntent(sol.wallet, { nonce: "0".repeat(32) }))).toThrow(/nonce/);
    expect(() => validateIntent(solanaIntent(sol.wallet, { nonce: "A".repeat(32) }))).toThrow(/nonce/);
    expect(() => validateIntent({ ...solanaIntent(sol.wallet), chain: "sepolia" as never })).toThrow(/unknown chain/);
    expect(() => validateIntent({ ...solanaIntent(sol.wallet), side: "short" as never })).toThrow(/side/);
    expect(() => validateIntent({ ...solanaIntent(sol.wallet), version: 4 as never })).toThrow(/version/);
  });

  it("parses amounts only from decimal strings, never from JSON numbers", () => {
    const json = toJson(solanaIntent(sol.wallet));
    expect(parseOrderIntent(json)).toEqual(solanaIntent(sol.wallet));
    expect(() => parseOrderIntent({ ...json, quantity: 5_000_000 })).toThrow(/decimal integer string/);
    expect(() => parseOrderIntent({ ...json, limitPrice: "25000000.0" })).toThrow(/decimal/);
    expect(() => parseOrderIntent({ ...json, limitPrice: "025000000" })).toThrow(/decimal/);
    expect(() => parseOrderIntent({ ...json, limitPrice: "1e7" })).toThrow(/decimal/);
    expect(() => parseOrderIntent({ ...json, extra: 1 })).toThrow(/unexpected field/);
    expect(() => parseOrderIntent([json])).toThrow(/object/);
  });
});

describe("order admission (the server function's gate)", () => {
  it("admits a correctly signed Solana intent and produces the engine order", async () => {
    const intent = solanaIntent(sol.wallet);
    const r = await admitOrderIntent({ intent, signature: await sol.sign(intent), orderId: "order-1", now: NOW, chain: SOLANA });
    expect(r).toMatchObject({
      ok: true,
      order: {
        id: "order-1",
        chain: "solana-devnet",
        wallet: sol.wallet,
        side: "buy",
        quantity: 5_000_000n,
        lotSize: 1_000_000n,
        limitPrice: 25_000_000n,
        expiresAt: NOW + DAY,
      },
    });
  });

  it("admits a correctly signed EVM intent", async () => {
    const intent = evmIntent(evm.wallet);
    const r = await admitOrderIntent({ intent, signature: await evm.sign(intent), orderId: "order-2", now: NOW, chain: BASE });
    expect(r.ok).toBe(true);
  });

  it("refuses a bad signature", async () => {
    const intent = solanaIntent(sol.wallet);
    const other = await solanaSigner();
    const r = await admitOrderIntent({ intent, signature: await other.sign(intent), orderId: "o", now: NOW, chain: SOLANA });
    expect(r).toMatchObject({ ok: false, reason: "bad_signature" });
    const evmR = await admitOrderIntent({
      intent: evmIntent(evm.wallet),
      signature: "0x1234",
      orderId: "o",
      now: NOW,
      chain: BASE,
    });
    expect(evmR).toMatchObject({ ok: false, reason: "invalid_signature_format" });
  });

  it("enforces the expiry window: after now, at most the chain's maximum validity ahead", async () => {
    const admit = async (expiresAt: number) => {
      const intent = solanaIntent(sol.wallet, { expiresAt });
      return admitOrderIntent({ intent, signature: await sol.sign(intent), orderId: "o", now: NOW, chain: SOLANA });
    };
    expect(await admit(NOW)).toMatchObject({ ok: false, reason: "expired" });
    expect(await admit(NOW + MAX_VALIDITY + 1)).toMatchObject({ ok: false, reason: "expiry_too_far" });
    expect((await admit(NOW + MAX_VALIDITY)).ok).toBe(true);
    expect((await admit(NOW + 1)).ok).toBe(true);
  });

  it("refuses an intent for another chain, program or payment asset, or a chain not deployed yet", async () => {
    const intent = solanaIntent(sol.wallet);
    const signature = await sol.sign(intent);
    const admit = (chain: ChainConfig) => admitOrderIntent({ intent, signature, orderId: "o", now: NOW, chain });
    expect(await admit(BASE)).toMatchObject({ ok: false, reason: "wrong_chain" });
    expect(await admit({ ...SOLANA, settlementProgram: patternedSolanaAddress(7) })).toMatchObject({
      ok: false,
      reason: "wrong_settlement",
    });
    expect(await admit({ ...SOLANA, quoteAsset: patternedSolanaAddress(7) })).toMatchObject({
      ok: false,
      reason: "wrong_payment_asset",
    });
    expect(await admit({ ...SOLANA, settlementProgram: null })).toMatchObject({ ok: false, reason: "chain_not_ready" });
    expect(await admit({ ...SOLANA, quoteAsset: null })).toMatchObject({ ok: false, reason: "chain_not_ready" });
  });

  it("returns a validation error code instead of throwing", async () => {
    const intent = solanaIntent(sol.wallet, { quantity: 1n });
    expect(await admitOrderIntent({ intent, signature: "x", orderId: "o", now: NOW, chain: SOLANA })).toMatchObject({
      ok: false,
      reason: "not_whole_lots",
    });
  });

  it("feeds the engine: two admitted intents from different wallets match", async () => {
    const seller = await solanaSigner();
    const buyIntent = solanaIntent(sol.wallet);
    const sellIntent = solanaIntent(seller.wallet, { side: "sell", nonce: "22222222222222222222222222222222" });
    const buy = await admitOrderIntent({ intent: buyIntent, signature: await sol.sign(buyIntent), orderId: "b", now: NOW, chain: SOLANA });
    const sell = await admitOrderIntent({
      intent: sellIntent,
      signature: await seller.sign(sellIntent),
      orderId: "s",
      now: NOW,
      chain: SOLANA,
    });
    if (!buy.ok || !sell.ok) throw new Error("not admitted");
    const engine = new MatchingEngine({ newMatchId: seededUuidV4(3) });
    engine.upsertMarket({
      chain: "solana-devnet",
      asset: buyIntent.asset,
      assetClass: "equity",
      status: "approved",
      quoteAsset: SOL_USDT,
      lotSize: 1_000_000n,
      minOrderNotional: 0n,
    });
    engine.place(sell.order, NOW);
    const r = engine.place(buy.order, NOW);
    expect(r.accepted && r.matches.map((m) => [m.buyer, m.seller, m.quantity, m.paymentAmount])).toEqual([
      [sol.wallet, seller.wallet, 5_000_000n, 125_000_000n],
    ]);
  });
});

describe("signature properties (fast-check)", () => {
  const fields = fc.record({
    side: fc.constantFrom<"buy" | "sell">("buy", "sell"),
    lots: fc.bigInt({ min: 1n, max: 1_000_000n }),
    lotSize: fc.bigInt({ min: 1n, max: 10n ** 9n }),
    limitPrice: fc.bigInt({ min: 1n, max: 10n ** 9n }),
    nonce: fc.uint8Array({ minLength: 16, maxLength: 16 }).filter((b) => b.some((x) => x !== 0)),
    ttl: fc.integer({ min: 1, max: MAX_VALIDITY }),
  });
  type Fields = typeof fields extends fc.Arbitrary<infer T> ? T : never;
  const build = (f: Fields): Partial<OrderIntent> => ({
    side: f.side,
    quantity: f.lots * f.lotSize,
    lotSize: f.lotSize,
    limitPrice: f.limitPrice,
    nonce: Buffer.from(f.nonce).toString("hex"),
    expiresAt: NOW + f.ttl,
  });

  it("Solana: every valid intent verifies under its wallet and fails once its price moves", async () => {
    await fc.assert(
      fc.asyncProperty(fields, async (f) => {
        const intent = solanaIntent(sol.wallet, build(f));
        const sig = await sol.sign(intent);
        expect(await verifyIntentSignature(intent, sig)).toBe(true);
        expect(await verifyIntentSignature({ ...intent, limitPrice: intent.limitPrice + 1n }, sig)).toBe(false);
      }),
      { numRuns: 50 },
    );
  });

  it("EVM: every valid intent verifies under its wallet and fails once its quantity moves", async () => {
    await fc.assert(
      fc.asyncProperty(fields, async (f) => {
        const intent = evmIntent(evm.wallet, build(f));
        const sig = await evm.sign(intent);
        expect(await verifyIntentSignature(intent, sig)).toBe(true);
        expect(await verifyIntentSignature({ ...intent, quantity: intent.quantity + intent.lotSize }, sig)).toBe(false);
      }),
      { numRuns: 50 },
    );
  });
});
