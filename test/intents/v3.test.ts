import { concat, encodeAbiParameters, getAddress, keccak256, toHex, type Hex } from "viem";
import { beforeAll, describe, expect, it } from "vitest";
import {
  ORDER_INTENT_TYPEHASH,
  ORDER_INTENT_V2_TYPEHASH,
  ORDER_INTENT_V2_TYPES,
  ORDER_INTENT_V3_TYPE,
  ORDER_INTENT_V3_TYPEHASH,
  evmIntentDigest,
  evmIntentTypedData,
  verifyEvmIntent,
} from "../../src/intents/evm.ts";
import { solanaIntentMessage, verifySolanaIntent } from "../../src/intents/solana.ts";
import {
  ICEBERG_INTENT_VERSION,
  INTENT_VERSION,
  SUPPORTED_INTENT_VERSIONS,
  IntentError,
  displayQuantityOf,
  type OrderIntent,
} from "../../src/intents/types.ts";
import { parseOrderIntent, validateIntent } from "../../src/intents/validate.ts";
import { admitOrderIntent, type ChainConfig } from "../../src/intents/verify.ts";
import {
  DAY,
  EVM_SETTLEMENT,
  EVM_USDT,
  EVM_ASSET,
  NOW,
  SOL_PROGRAM,
  SOL_USDT,
  evmIntent,
  evmSigner,
  patternedSolanaAddress,
  solanaIntent,
  solanaSigner,
  tamperedVariants,
  type SolanaSigner,
} from "./fixtures.ts";

/** Order intent v3 (iceberg): v2 plus a signed `displayQuantity`. TEST keys and patterned addresses only. */

let sol: SolanaSigner;
const evm = evmSigner();
beforeAll(async () => {
  sol = await solanaSigner();
});

// Fixture lot sizes: 1_000_000 (Solana), 10^18 (EVM); quantities of 5 lots.
const v3 = (i: OrderIntent, display: bigint): OrderIntent => ({ ...i, version: 3, timeInForce: "GTC", displayQuantity: display });
const solIceberg = () => v3(solanaIntent(sol.wallet), 2_000_000n);
const evmIceberg = () => v3(evmIntent(evm.wallet), 2n * 10n ** 18n);
const json = (i: OrderIntent): Record<string, unknown> => ({
  ...i,
  quantity: i.quantity.toString(),
  lotSize: i.lotSize.toString(),
  limitPrice: i.limitPrice.toString(),
  ...(i.displayQuantity !== undefined && { displayQuantity: i.displayQuantity.toString() }),
});
const SOLANA: ChainConfig = { chain: "solana-devnet", settlementProgram: SOL_PROGRAM, quoteAsset: SOL_USDT, maxIntentValiditySecs: 30 * DAY };
const BASE: ChainConfig = { chain: "base-sepolia", settlementProgram: EVM_SETTLEMENT, quoteAsset: EVM_USDT, maxIntentValiditySecs: 30 * DAY };
const code = (f: () => unknown): string | undefined => {
  try {
    f();
  } catch (e) {
    if (e instanceof IntentError) return e.code;
    throw e;
  }
  return undefined;
};

describe("intent versions", () => {
  it("v3 is the iceberg version; plain orders keep signing v2; v1, v2 and v3 are accepted", () => {
    expect(INTENT_VERSION).toBe(2);
    expect(ICEBERG_INTENT_VERSION).toBe(3);
    expect([...SUPPORTED_INTENT_VERSIONS]).toEqual([1, 2, 3]);
    expect(validateIntent(solIceberg())).toEqual(solIceberg());
    expect(displayQuantityOf(solIceberg())).toBe(2_000_000n);
    expect(displayQuantityOf(solanaIntent(sol.wallet))).toBeUndefined();
  });

  it("v3 rules: GTC only, display required, whole lots, at least one lot, below the quantity", () => {
    const i = solIceberg();
    expect(code(() => validateIntent({ ...i, timeInForce: "IOC" }))).toBe("iceberg_requires_gtc");
    expect(() => validateIntent({ ...i, timeInForce: "IOC" })).toThrow(/must be GTC: an IOC never rests/);
    const { displayQuantity: _, ...noDisplay } = i;
    expect(code(() => validateIntent(noDisplay))).toBe("invalid_display_quantity");
    expect(code(() => validateIntent({ ...i, displayQuantity: 0n }))).toBe("invalid_display_quantity");
    expect(code(() => validateIntent({ ...i, displayQuantity: 1_500_000n }))).toBe("invalid_display_quantity"); // 1.5 lots
    expect(() => validateIntent({ ...i, displayQuantity: 1_500_000n })).toThrow(/whole number of lots/);
    expect(code(() => validateIntent({ ...i, displayQuantity: i.quantity }))).toBe("invalid_display_quantity");
    expect(() => validateIntent({ ...i, displayQuantity: i.quantity })).toThrow(/less than quantity/);
    expect(validateIntent({ ...i, displayQuantity: 1_000_000n }).displayQuantity).toBe(1_000_000n); // one lot
  });

  it("v1 and v2 refuse a display quantity: they never signed one, so they are shown whole", () => {
    const base = solanaIntent(sol.wallet);
    expect(code(() => validateIntent({ ...base, displayQuantity: 1_000_000n }))).toBe("invalid_display_quantity");
    expect(code(() => validateIntent({ ...base, version: 2, timeInForce: "GTC", displayQuantity: 1_000_000n }))).toBe(
      "invalid_display_quantity",
    );
  });

  it("parses v3 JSON with displayQuantity as a decimal string, never a number", () => {
    const i = solIceberg();
    expect(parseOrderIntent(json(i))).toEqual(i);
    expect(code(() => parseOrderIntent({ ...json(i), displayQuantity: 2_000_000 }))).toBe("invalid_amount");
    expect(code(() => parseOrderIntent({ ...json(i), displayQuantity: undefined }))).toBe("invalid_display_quantity");
  });
});

describe("Solana text v3", () => {
  it("adds one labeled Display quantity line after the time in force; the rest is v2's text", () => {
    const lines = (i: OrderIntent) => new TextDecoder().decode(solanaIntentMessage(i)).split("\n");
    const i = solIceberg();
    const { displayQuantity: _, ...plain } = { ...i, version: 2 as const };
    const two = lines(plain);
    const three = lines(i);
    expect(three[0]).toBe("Niara Exchange order intent v3");
    expect(three.slice(1, 12)).toEqual(two.slice(1, 12));
    expect(three[12]).toBe("Display quantity: 2000000 (asset base units shown in the book at a time)");
    expect(three.slice(13)).toEqual(two.slice(12));
    expect(two.some((l) => l.startsWith("Display quantity"))).toBe(false); // v2 text unchanged
  });

  it("is 699 bytes for a typical iceberg (v1: 552, v2: 626), well within one transaction for the Ed25519 program", () => {
    // Patterned 43-character base58 addresses, as a typical intent's.
    const typical = (over: Partial<OrderIntent>): OrderIntent =>
      solanaIntent(patternedSolanaAddress(0x04), {
        settlement: patternedSolanaAddress(0x01),
        asset: patternedSolanaAddress(0x02),
        paymentAsset: patternedSolanaAddress(0x03),
        side: "sell",
        expiresAt: 1_800_086_400,
        ...over,
      });
    expect(solanaIntentMessage(typical({})).length).toBe(552);
    expect(solanaIntentMessage(typical({ version: 2, timeInForce: "GTC" })).length).toBe(626);
    expect(solanaIntentMessage(typical({ version: 3, timeInForce: "GTC", displayQuantity: 2_000_000n })).length).toBe(699);
  });

  it("verifies v3 signatures; the display quantity and the version are covered", async () => {
    const i = solIceberg();
    const sig = await sol.sign(i);
    expect(await verifySolanaIntent(i, sig)).toBe(true);
    expect(await verifySolanaIntent({ ...i, displayQuantity: 3_000_000n }, sig)).toBe(false);
    for (const [field, t] of tamperedVariants(i, patternedSolanaAddress(0x09))) {
      expect(await verifySolanaIntent(t, sig), field).toBe(false);
    }
    // A v2 signature does not place an iceberg, nor the reverse.
    const { displayQuantity: _, ...v2 } = { ...i, version: 2 as const };
    expect(await verifySolanaIntent(i, await sol.sign(v2))).toBe(false);
    expect(await verifySolanaIntent(v2, sig)).toBe(false);
  });
});

describe("EIP-712 v3", () => {
  it("appends uint256 displayQuantity to v2's type; three distinct type hashes, same domain", () => {
    expect(ORDER_INTENT_V3_TYPE).toBe(
      "OrderIntent(address wallet,uint8 side,address asset,uint256 quantity,uint256 lotSize," +
        "uint256 limitPrice,address paymentAsset,bytes16 nonce,uint64 expiresAt,uint8 timeInForce,uint256 displayQuantity)",
    );
    expect(ORDER_INTENT_V3_TYPEHASH).toBe(keccak256(toHex(ORDER_INTENT_V3_TYPE)));
    expect(new Set([ORDER_INTENT_TYPEHASH, ORDER_INTENT_V2_TYPEHASH, ORDER_INTENT_V3_TYPEHASH]).size).toBe(3);
    const typed = evmIntentTypedData(evmIceberg());
    expect(typed.domain).toMatchObject({ name: "Niara Exchange", version: "1" });
    expect(typed.message).toMatchObject({ timeInForce: 0, displayQuantity: 2n * 10n ** 18n });
    // v2 typed data unchanged: v2's type, no displayQuantity.
    const two = evmIntentTypedData({ ...evmIntent(evm.wallet), version: 2, timeInForce: "GTC" });
    expect(two.types).toBe(ORDER_INTENT_V2_TYPES);
    expect(two.message).not.toHaveProperty("displayQuantity");
  });

  it("matches the digest a Solidity verifier computes by hand", () => {
    const intent = evmIceberg();
    const domainSeparator = keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
        [
          keccak256(toHex("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")),
          keccak256(toHex("Niara Exchange")),
          keccak256(toHex("1")),
          84532n,
          getAddress(EVM_SETTLEMENT),
        ],
      ),
    );
    const structHash = keccak256(
      encodeAbiParameters(
        [
          { type: "bytes32" },
          { type: "address" },
          { type: "uint8" },
          { type: "address" },
          { type: "uint256" },
          { type: "uint256" },
          { type: "uint256" },
          { type: "address" },
          { type: "bytes16" },
          { type: "uint64" },
          { type: "uint8" },
          { type: "uint256" },
        ],
        [
          ORDER_INTENT_V3_TYPEHASH,
          evm.wallet as Hex,
          1,
          getAddress(EVM_ASSET),
          intent.quantity,
          intent.lotSize,
          intent.limitPrice,
          getAddress(EVM_USDT),
          `0x${intent.nonce}`,
          BigInt(intent.expiresAt),
          0,
          intent.displayQuantity!,
        ],
      ),
    );
    expect(evmIntentDigest(intent)).toBe(keccak256(concat(["0x1901", domainSeparator, structHash])));
  });

  it("verifies v3 signatures; the display quantity is covered, and v2 and v3 signatures never cross", async () => {
    const i = evmIceberg();
    const sig = await evm.sign(i);
    expect(await verifyEvmIntent(i, sig)).toBe(true);
    expect(await verifyEvmIntent({ ...i, displayQuantity: 3n * 10n ** 18n }, sig)).toBe(false);
    const { displayQuantity: _, ...v2 } = { ...i, version: 2 as const };
    expect(await verifyEvmIntent(v2, sig)).toBe(false);
    expect(await verifyEvmIntent(i, await evm.sign(v2))).toBe(false);
  });
});

describe("admission", () => {
  it("admits v3 on both families and hands the engine the signed display quantity", async () => {
    for (const [intent, sign, chain] of [
      [solIceberg(), sol.sign, SOLANA],
      [evmIceberg(), evm.sign, BASE],
    ] as const) {
      const r = await admitOrderIntent({ intent, signature: await sign(intent), orderId: "00000000-0000-4000-8000-000000000003", now: NOW, chain });
      expect(r.ok).toBe(true);
      expect(r.ok && r.order).toMatchObject({ timeInForce: "GTC", displayQuantity: intent.displayQuantity });
    }
  });

  it("refuses an IOC iceberg with a clear reason, and gives v1/v2 orders no display quantity", async () => {
    const ioc: OrderIntent = { ...solIceberg(), timeInForce: "IOC" };
    const r = await admitOrderIntent({ intent: ioc, signature: await sol.sign(solIceberg()), orderId: "x", now: NOW, chain: SOLANA });
    expect(r).toMatchObject({ ok: false, reason: "iceberg_requires_gtc" });
    const plain = solanaIntent(sol.wallet);
    const ok = await admitOrderIntent({ intent: plain, signature: await sol.sign(plain), orderId: "y", now: NOW, chain: SOLANA });
    expect(ok.ok && "displayQuantity" in ok.order).toBe(false);
  });
});
