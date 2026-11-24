import { concat, encodeAbiParameters, getAddress, keccak256, toHex, type Hex } from "viem";
import { beforeAll, describe, expect, it } from "vitest";
import { CANCEL_VERSION, parseCancelIntent, solanaCancelMessage } from "../../src/intents/cancel.ts";
import {
  ORDER_INTENT_TYPEHASH,
  ORDER_INTENT_V2_TYPE,
  ORDER_INTENT_V2_TYPEHASH,
  evmIntentDigest,
  evmIntentTypedData,
  verifyEvmIntent,
} from "../../src/intents/evm.ts";
import { solanaIntentMessage, verifySolanaIntent } from "../../src/intents/solana.ts";
import { INTENT_VERSION, IntentError, timeInForceOf, type OrderIntent } from "../../src/intents/types.ts";
import { parseOrderIntent, validateIntent } from "../../src/intents/validate.ts";
import { admitOrderIntent, verifyIntentSignature, type ChainConfig } from "../../src/intents/verify.ts";
import {
  DAY,
  EVM_ASSET,
  EVM_SETTLEMENT,
  EVM_USDT,
  NOW,
  SOL_PROGRAM,
  SOL_USDT,
  cancelOf,
  evmIntent,
  evmSigner,
  patternedSolanaAddress,
  solanaIntent,
  solanaSigner,
  tamperedVariants,
  type SolanaSigner,
} from "./fixtures.ts";

/** Order intent v2: `timeInForce` signed in both families; v1 still accepted as GTC. TEST keys only. */

let sol: SolanaSigner;
const evm = evmSigner();
beforeAll(async () => {
  sol = await solanaSigner();
});

const v2 = (i: OrderIntent, tif: "GTC" | "IOC"): OrderIntent => ({ ...i, version: 2, timeInForce: tif });
const json = (i: OrderIntent): Record<string, unknown> => ({
  ...i,
  quantity: i.quantity.toString(),
  lotSize: i.lotSize.toString(),
  limitPrice: i.limitPrice.toString(),
});
const SOLANA: ChainConfig = { chain: "solana-devnet", settlementProgram: SOL_PROGRAM, quoteAsset: SOL_USDT, maxIntentValiditySecs: 30 * DAY };
const BASE: ChainConfig = { chain: "base-sepolia", settlementProgram: EVM_SETTLEMENT, quoteAsset: EVM_USDT, maxIntentValiditySecs: 30 * DAY };

describe("intent versions", () => {
  it("v2 is current; v1 still validates and means GTC", () => {
    expect(INTENT_VERSION).toBe(2);
    const v1 = solanaIntent(sol.wallet);
    expect(validateIntent(v1)).toEqual(v1);
    expect(timeInForceOf(v1)).toBe("GTC");
    expect(timeInForceOf(v2(v1, "IOC"))).toBe("IOC");
  });

  it("v2 requires GTC or IOC; v1 refuses the field (it was never signed)", () => {
    const base = solanaIntent(sol.wallet);
    expect(() => validateIntent({ ...base, version: 2 })).toThrow(/timeInForce must be GTC or IOC/);
    expect(() => validateIntent({ ...base, version: 2, timeInForce: "FOK" as never })).toThrow(IntentError);
    expect(() => validateIntent({ ...base, version: 2, timeInForce: "ioc" as never })).toThrow(IntentError);
    expect(() => validateIntent({ ...base, timeInForce: "IOC" })).toThrow(/v2 field/);
    expect(() => validateIntent({ ...base, timeInForce: "GTC" })).toThrow(/v2 field/);
  });

  it("parses v2 JSON with timeInForce, and v1 JSON without it", () => {
    const i = v2(solanaIntent(sol.wallet), "IOC");
    expect(parseOrderIntent(json(i))).toEqual(i);
    const v1 = solanaIntent(sol.wallet);
    expect(parseOrderIntent(json(v1))).toEqual(v1);
    expect(() => parseOrderIntent({ ...json(v1), timeInForce: "IOC" })).toThrow(/v2 field/);
    expect(() => parseOrderIntent({ ...json(i), timeInForce: undefined })).toThrow(/GTC or IOC/);
  });
});

describe("Solana text v2", () => {
  it("adds one labeled Time in force line after the limit price; the rest is v1's text", () => {
    const base = solanaIntent(sol.wallet);
    const lines = (i: OrderIntent) => new TextDecoder().decode(solanaIntentMessage(i)).split("\n");
    const v1 = lines(base);
    const ioc = lines(v2(base, "IOC"));
    expect(ioc[0]).toBe("Niara Exchange order intent v2");
    expect(ioc.slice(1, 11)).toEqual(v1.slice(1, 11));
    expect(ioc[11]).toBe("Time in force: IOC (fills now up to the limit price; the rest is cancelled)");
    expect(ioc.slice(12)).toEqual(v1.slice(11));
    expect(lines(v2(base, "GTC"))[11]).toBe("Time in force: GTC (rests in the book until filled, cancelled or expired)");
    expect(v1[0]).toBe("Niara Exchange order intent v1"); // v1 text unchanged
    expect(v1.some((l) => l.startsWith("Time in force"))).toBe(false);
  });

  it("verifies v2 signatures; timeInForce and the version are covered", async () => {
    const ioc = v2(solanaIntent(sol.wallet), "IOC");
    const sig = await sol.sign(ioc);
    expect(await verifySolanaIntent(ioc, sig)).toBe(true);
    expect(await verifySolanaIntent({ ...ioc, timeInForce: "GTC" }, sig)).toBe(false);
    for (const [field, t] of tamperedVariants(ioc, patternedSolanaAddress(0x09))) {
      expect(await verifySolanaIntent(t, sig), field).toBe(false);
    }
    // A v1 signature is not a v2 GTC signature, nor the reverse.
    const v1 = solanaIntent(sol.wallet);
    expect(await verifySolanaIntent(v2(v1, "GTC"), await sol.sign(v1))).toBe(false);
    expect(await verifySolanaIntent(v1, await sol.sign(v2(v1, "GTC")))).toBe(false);
  });
});

describe("EIP-712 v2", () => {
  it("appends uint8 timeInForce to the type; the type hash differs from v1's", () => {
    expect(ORDER_INTENT_V2_TYPE).toBe(
      "OrderIntent(address wallet,uint8 side,address asset,uint256 quantity,uint256 lotSize," +
        "uint256 limitPrice,address paymentAsset,bytes16 nonce,uint64 expiresAt,uint8 timeInForce)",
    );
    expect(ORDER_INTENT_V2_TYPEHASH).toBe(keccak256(toHex(ORDER_INTENT_V2_TYPE)));
    expect(ORDER_INTENT_V2_TYPEHASH).not.toBe(ORDER_INTENT_TYPEHASH);
    const typed = evmIntentTypedData(v2(evmIntent(evm.wallet), "IOC"));
    expect(typed.domain).toMatchObject({ name: "Niara Exchange", version: "1" }); // contract unchanged
    expect(typed.message).toMatchObject({ timeInForce: 1 });
    expect(evmIntentTypedData(v2(evmIntent(evm.wallet), "GTC")).message).toMatchObject({ timeInForce: 0 });
    expect(evmIntentTypedData(evmIntent(evm.wallet)).message).not.toHaveProperty("timeInForce");
  });

  it("matches the digest a Solidity verifier computes by hand", () => {
    const intent = v2(evmIntent(evm.wallet), "IOC");
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
        ],
        [
          ORDER_INTENT_V2_TYPEHASH,
          evm.wallet as Hex,
          1,
          getAddress(EVM_ASSET),
          intent.quantity,
          intent.lotSize,
          intent.limitPrice,
          getAddress(EVM_USDT),
          `0x${intent.nonce}`,
          BigInt(intent.expiresAt),
          1,
        ],
      ),
    );
    expect(evmIntentDigest(intent)).toBe(keccak256(concat(["0x1901", domainSeparator, structHash])));
  });

  it("verifies v2 signatures; timeInForce and the version are covered", async () => {
    const ioc = v2(evmIntent(evm.wallet), "IOC");
    const sig = await evm.sign(ioc);
    expect(await verifyEvmIntent(ioc, sig)).toBe(true);
    expect(await verifyEvmIntent({ ...ioc, timeInForce: "GTC" }, sig)).toBe(false);
    for (const [field, t] of tamperedVariants(ioc, "0x000000000000000000000000000000000000beef")) {
      expect(await verifyEvmIntent(t, sig), field).toBe(false);
    }
    const v1 = evmIntent(evm.wallet);
    expect(await verifyEvmIntent(v2(v1, "GTC"), await evm.sign(v1))).toBe(false);
    expect(await verifyEvmIntent(v1, await evm.sign(v2(v1, "GTC")))).toBe(false);
    expect(await verifyIntentSignature(v1, await evm.sign(v1))).toBe(true); // v1 still verifies
  });
});

describe("admission", () => {
  it("admits v1 (as GTC) and v2 GTC on both families", async () => {
    const s1 = solanaIntent(sol.wallet);
    const s2 = v2(solanaIntent(sol.wallet, { nonce: "22222222222222222222222222222222" }), "GTC");
    const e1 = evmIntent(evm.wallet);
    const e2 = v2(evmIntent(evm.wallet, { nonce: "33333333333333333333333333333333" }), "GTC");
    for (const [intent, sign, chain] of [
      [s1, sol.sign, SOLANA],
      [s2, sol.sign, SOLANA],
      [e1, evm.sign, BASE],
      [e2, evm.sign, BASE],
    ] as const) {
      const r = await admitOrderIntent({ intent, signature: await sign(intent), orderId: "00000000-0000-4000-8000-000000000001", now: NOW, chain });
      expect(r.ok, `${intent.chain} v${intent.version}`).toBe(true);
    }
  });
});

describe("cancellation", () => {
  it("keeps its v1 format for orders of either version", () => {
    expect(CANCEL_VERSION).toBe(1);
    const c = cancelOf(v2(solanaIntent(sol.wallet), "IOC"));
    expect(new TextDecoder().decode(solanaCancelMessage(c)).split("\n")[0]).toBe("Niara Exchange cancel order v1");
    expect(() => parseCancelIntent({ ...c, version: 2 })).toThrow(/cancel version must be 1/);
  });
});

