import { beforeAll, describe, expect, it } from "vitest";
import { getAddress, hashTypedData, keccak256, toHex } from "viem";
import {
  CANCEL_ORDER_TYPEHASH,
  admitCancelIntent,
  evmCancelDigest,
  evmCancelTypedData,
  parseCancelIntent,
  solanaCancelMessage,
  verifyCancelSignature,
  type CancelIntent,
} from "../../src/intents/cancel.ts";
import { evmIntentDigest } from "../../src/intents/evm.ts";
import { solanaIntentMessage } from "../../src/intents/solana.ts";
import type { ChainConfig } from "../../src/intents/verify.ts";
import {
  DAY,
  EVM_ASSET,
  EVM_SETTLEMENT,
  EVM_USDT,
  SOL_ASSET,
  SOL_PROGRAM,
  SOL_USDT,
  cancelOf,
  evmIntent,
  evmSigner,
  patternedSolanaAddress,
  solanaIntent,
  solanaSigner,
  type SolanaSigner,
} from "./fixtures.ts";

const SOLANA: ChainConfig = {
  chain: "solana-devnet",
  settlementProgram: SOL_PROGRAM,
  quoteAsset: SOL_USDT,
  maxIntentValiditySecs: 30 * DAY,
};
const BASE: ChainConfig = {
  chain: "base-sepolia",
  settlementProgram: EVM_SETTLEMENT,
  quoteAsset: EVM_USDT,
  maxIntentValiditySecs: 30 * DAY,
};

let alice: SolanaSigner;
let mallory: SolanaSigner;
const evm = evmSigner();
const evmMallory = evmSigner();

beforeAll(async () => {
  alice = await solanaSigner();
  mallory = await solanaSigner();
});

describe("Solana cancellation message", () => {
  it("is this exact labeled text, bound to the chain, program, wallet and order nonce", () => {
    const text = new TextDecoder().decode(solanaCancelMessage(cancelOf(solanaIntent(alice.wallet))));
    expect(text).toBe(
      [
        "Niara Exchange cancel order v1",
        "TESTNET ONLY: no real assets, no real money.",
        "",
        "Chain: solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
        `Program: ${SOL_PROGRAM}`,
        `Wallet: ${alice.wallet}`,
        "Order nonce: 0123456789abcdef0123456789abcdef",
      ].join("\n"),
    );
  });

  it("verifies the wallet's signature", async () => {
    const cancel = cancelOf(solanaIntent(alice.wallet));
    expect(await verifyCancelSignature(cancel, await alice.signCancel(cancel))).toBe(true);
  });

  it("covers every field: another nonce, program or wallet does not verify", async () => {
    const cancel = cancelOf(solanaIntent(alice.wallet));
    const sig = await alice.signCancel(cancel);
    const variants: CancelIntent[] = [
      { ...cancel, nonce: "11111111111111111111111111111111" },
      { ...cancel, settlement: patternedSolanaAddress(0x09) },
      { ...cancel, wallet: mallory.wallet },
    ];
    for (const v of variants) expect(await verifyCancelSignature(v, sig)).toBe(false);
  });

  it("is never an order intent: an order signature does not cancel, a cancel signature does not place", async () => {
    const intent = solanaIntent(alice.wallet);
    const cancel = cancelOf(intent);
    expect(await verifyCancelSignature(cancel, await alice.sign(intent))).toBe(false);
    const cancelSig = await alice.signCancel(cancel);
    expect(Buffer.from(solanaCancelMessage(cancel)).equals(Buffer.from(solanaIntentMessage(intent)))).toBe(false);
    expect(await verifyCancelSignature(cancel, await alice.signBytes(solanaIntentMessage(intent)))).toBe(false);
    expect(cancelSig).not.toBe(await alice.sign(intent));
  });

  it("refuses a signature by another wallet", async () => {
    const cancel = cancelOf(solanaIntent(alice.wallet));
    expect(await verifyCancelSignature(cancel, await mallory.signCancel(cancel))).toBe(false);
  });
});

describe("EVM cancellation (EIP-712)", () => {
  it("uses the order intent's domain and the CancelOrder(address wallet,bytes16 nonce) type", () => {
    const typed = evmCancelTypedData(cancelOf(evmIntent(evm.wallet)));
    expect(typed.domain).toEqual({
      name: "Niara Exchange",
      version: "1",
      chainId: 84532,
      verifyingContract: getAddress(EVM_SETTLEMENT),
    });
    expect(typed.primaryType).toBe("CancelOrder");
    expect(typed.message).toEqual({ wallet: evm.wallet, nonce: "0xfedcba9876543210fedcba9876543210" });
    expect(CANCEL_ORDER_TYPEHASH).toBe(keccak256(toHex("CancelOrder(address wallet,bytes16 nonce)")));
    expect(evmCancelDigest(cancelOf(evmIntent(evm.wallet)))).toBe(hashTypedData(typed));
  });

  it("verifies the wallet's signature, and every field is covered", async () => {
    const cancel = cancelOf(evmIntent(evm.wallet));
    const sig = await evm.signCancel(cancel);
    expect(await verifyCancelSignature(cancel, sig)).toBe(true);
    const variants: CancelIntent[] = [
      { ...cancel, nonce: "11111111111111111111111111111111" },
      { ...cancel, settlement: EVM_ASSET },
      { ...cancel, wallet: evmMallory.wallet },
      { ...cancel, chain: "tempo-testnet" },
    ];
    for (const v of variants) expect(await verifyCancelSignature(v, sig)).toBe(false);
  });

  it("has a digest distinct from the order's, and an order signature does not cancel", async () => {
    const intent = evmIntent(evm.wallet);
    const cancel = cancelOf(intent);
    expect(evmCancelDigest(cancel)).not.toBe(evmIntentDigest(intent));
    expect(await verifyCancelSignature(cancel, await evm.sign(intent))).toBe(false);
  });

  it("accepts any address casing and verifies the checksummed form", async () => {
    const cancel = cancelOf(evmIntent(evm.wallet));
    const sig = await evm.signCancel(cancel);
    expect(await verifyCancelSignature({ ...cancel, wallet: evm.wallet.toLowerCase() }, sig)).toBe(true);
  });
});

describe("cancellation parsing", () => {
  const json = (c: CancelIntent) => ({ ...c });

  it("parses a client cancellation and refuses unknown fields", () => {
    const cancel = cancelOf(solanaIntent(patternedSolanaAddress(0x07)));
    expect(parseCancelIntent(json(cancel))).toEqual(cancel);
    expect(() => parseCancelIntent({ ...json(cancel), orderId: "x" })).toThrow(/unexpected field/);
    expect(() => parseCancelIntent([])).toThrow(/object/);
  });

  it("refuses a bad nonce, version, chain or address", () => {
    const cancel = cancelOf(solanaIntent(patternedSolanaAddress(0x07)));
    expect(() => parseCancelIntent({ ...cancel, nonce: "0".repeat(32) })).toThrow(/nonce/);
    expect(() => parseCancelIntent({ ...cancel, nonce: "ABCDEF".padEnd(32, "0") })).toThrow(/nonce/);
    expect(() => parseCancelIntent({ ...cancel, version: 2 })).toThrow(/version/);
    expect(() => parseCancelIntent({ ...cancel, chain: "sepolia" })).toThrow(/unknown chain/);
    expect(() => parseCancelIntent({ ...cancel, wallet: EVM_USDT })).toThrow(/base58/);
  });
});

describe("admitCancelIntent", () => {
  it("admits a valid Solana and a valid EVM cancellation", async () => {
    const s = cancelOf(solanaIntent(alice.wallet));
    expect(await admitCancelIntent({ cancel: s, signature: await alice.signCancel(s), chain: SOLANA })).toEqual({
      ok: true,
      cancel: s,
    });
    const e = cancelOf(evmIntent(evm.wallet));
    const r = await admitCancelIntent({ cancel: e, signature: await evm.signCancel(e), chain: BASE });
    expect(r.ok).toBe(true);
  });

  it("refuses the wrong chain config, another program, an undeployed chain and a bad signature", async () => {
    const cancel = cancelOf(solanaIntent(alice.wallet));
    const signature = await alice.signCancel(cancel);
    const reason = async (chain: ChainConfig, sig = signature) => {
      const r = await admitCancelIntent({ cancel, signature: sig, chain });
      return r.ok ? null : r.reason;
    };
    expect(await reason(BASE)).toBe("wrong_chain");
    expect(await reason({ ...SOLANA, settlementProgram: patternedSolanaAddress(0x09) })).toBe("wrong_settlement");
    expect(await reason({ ...SOLANA, settlementProgram: null })).toBe("chain_not_ready");
    expect(await reason(SOLANA, await mallory.signCancel(cancel))).toBe("bad_signature");
    expect(await reason(SOLANA, "not-base58-0OIl")).toBe("invalid_signature_format");
  });

  it("refuses a malleated (high-s) EVM signature", async () => {
    const cancel = cancelOf(evmIntent(evm.wallet));
    const sig = await evm.signCancel(cancel);
    const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const s = BigInt(`0x${sig.slice(66, 130)}`);
    const v = Number.parseInt(sig.slice(130, 132), 16);
    const flipped = `${sig.slice(0, 66)}${(n - s).toString(16).padStart(64, "0")}${(v === 27 ? 28 : 27).toString(16)}`;
    const r = await admitCancelIntent({ cancel, signature: flipped, chain: BASE });
    expect(r.ok ? null : r.reason).toBe("invalid_signature_format");
  });

  it("names no asset: one signed cancellation covers exactly the order with that (chain, wallet, nonce)", () => {
    const a = cancelOf(solanaIntent(alice.wallet, { asset: SOL_ASSET }));
    const b = cancelOf(solanaIntent(alice.wallet, { asset: patternedSolanaAddress(0x0a) }));
    // Same nonce means same order (unique per chain and wallet), so the texts are equal.
    expect(solanaCancelMessage(a)).toEqual(solanaCancelMessage(b));
  });
});
