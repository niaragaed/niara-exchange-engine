import { concat, encodeAbiParameters, getAddress, keccak256, recoverTypedDataAddress, toHex, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import {
  ORDER_INTENT_TYPE,
  ORDER_INTENT_TYPEHASH,
  checkEvmSignatureFormat,
  evmIntentDigest,
  evmIntentTypedData,
  verifyEvmIntent,
} from "../../src/intents/evm.ts";
import { IntentError } from "../../src/intents/types.ts";
import { EVM_ASSET, EVM_SETTLEMENT, EVM_USDT, evmIntent, evmSigner, tamperedVariants } from "./fixtures.ts";

const alice = evmSigner();
const bob = evmSigner();
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

describe("EIP-712 order intent", () => {
  it("has the documented type string and type hash", () => {
    expect(ORDER_INTENT_TYPE).toBe(
      "OrderIntent(address wallet,uint8 side,address asset,uint256 quantity,uint256 lotSize," +
        "uint256 limitPrice,address paymentAsset,bytes16 nonce,uint64 expiresAt)",
    );
    expect(ORDER_INTENT_TYPEHASH).toBe(keccak256(toHex(ORDER_INTENT_TYPE)));
  });

  it("signs chain id and contract in the domain, the rest in the message", () => {
    const typed = evmIntentTypedData(evmIntent(alice.wallet));
    expect(typed.domain).toEqual({
      name: "Niara Exchange",
      version: "1",
      chainId: 84532,
      verifyingContract: getAddress(EVM_SETTLEMENT),
    });
    expect(typed.message).toMatchObject({
      wallet: alice.wallet,
      side: 1,
      asset: getAddress(EVM_ASSET),
      paymentAsset: getAddress(EVM_USDT),
      nonce: "0xfedcba9876543210fedcba9876543210",
    });
  });

  it("matches the digest a Solidity verifier computes by hand", () => {
    const intent = evmIntent(alice.wallet);
    const domainTypehash = keccak256(
      toHex("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
    );
    const domainSeparator = keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
        [domainTypehash, keccak256(toHex("Niara Exchange")), keccak256(toHex("1")), 84532n, getAddress(EVM_SETTLEMENT)],
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
        ],
        [
          ORDER_INTENT_TYPEHASH,
          alice.wallet as Hex,
          1,
          getAddress(EVM_ASSET),
          intent.quantity,
          intent.lotSize,
          intent.limitPrice,
          getAddress(EVM_USDT),
          `0x${intent.nonce}`,
          BigInt(intent.expiresAt),
        ],
      ),
    );
    expect(evmIntentDigest(intent)).toBe(keccak256(concat(["0x1901", domainSeparator, structHash])));
  });

  it("refuses a Solana chain", () => {
    expect(() => evmIntentTypedData(evmIntent(alice.wallet, { chain: "solana-devnet" }))).toThrow(IntentError);
  });
});

describe("EVM signature verification (EIP-712)", () => {
  it("accepts the wallet's signature, whatever the address case", async () => {
    const intent = evmIntent(alice.wallet);
    const sig = await alice.sign(intent);
    expect(await verifyEvmIntent(intent, sig)).toBe(true);
    expect(await verifyEvmIntent({ ...intent, wallet: alice.wallet.toLowerCase() }, sig)).toBe(true);
  });

  it("refuses another wallet's signature", async () => {
    const intent = evmIntent(alice.wallet);
    expect(await verifyEvmIntent(intent, await bob.sign(intent))).toBe(false);
  });

  it("covers every field: any change invalidates the signature", async () => {
    const intent = evmIntent(alice.wallet);
    const sig = await alice.sign(intent);
    for (const [field, changed] of tamperedVariants(intent, "0x000000000000000000000000000000000000beef")) {
      expect(await verifyEvmIntent(changed, sig), field).toBe(false);
    }
  });

  it("binds the chain id: a Base Sepolia signature is invalid on another EVM chain", async () => {
    const intent = evmIntent(alice.wallet);
    const sig = await alice.sign(intent);
    for (const chain of ["robinhood-testnet", "hyperevm-testnet", "tempo-testnet"] as const) {
      expect(await verifyEvmIntent({ ...intent, chain }, sig), chain).toBe(false);
    }
  });

  it("refuses the malleated high-s twin of a valid signature", async () => {
    const intent = evmIntent(alice.wallet);
    const sig = await alice.sign(intent);
    const s = BigInt(`0x${sig.slice(66, 130)}`);
    const v = Number.parseInt(sig.slice(130, 132), 16);
    const twin = `${sig.slice(0, 66)}${(N - s).toString(16).padStart(64, "0")}${(v === 27 ? 28 : 27).toString(16)}` as Hex;
    // The twin recovers the same signer; only the low-s rule rejects it.
    expect(await recoverTypedDataAddress({ ...evmIntentTypedData(intent), signature: twin })).toBe(alice.wallet);
    await expect(verifyEvmIntent(intent, twin)).rejects.toThrow(/lower half/);
  });

  it("rejects malformed signatures", () => {
    expect(() => checkEvmSignatureFormat("0x1234")).toThrow(/65 bytes/);
    expect(() => checkEvmSignatureFormat(`0x${"11".repeat(64)}00`)).toThrow(/27 or 28/);
    expect(() => checkEvmSignatureFormat(`0x${"11".repeat(32)}${"00".repeat(32)}1b`)).toThrow(/lower half/);
    expect(checkEvmSignatureFormat(`0x${"11".repeat(64)}1b`)).toMatch(/^0x/);
  });
});
