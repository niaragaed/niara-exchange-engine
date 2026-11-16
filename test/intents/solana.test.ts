import { signAsync, utils } from "@noble/ed25519";
import { base58 } from "@scure/base";
import { beforeAll, describe, expect, it } from "vitest";
import { decodeSolanaSignature, solanaIntentMessage, verifySolanaIntent } from "../../src/intents/solana.ts";
import { IntentError } from "../../src/intents/types.ts";
import {
  NOW,
  SOL_ASSET,
  SOL_PROGRAM,
  SOL_USDT,
  patternedSolanaAddress,
  solanaIntent,
  solanaSigner,
  tamperedVariants,
  type SolanaSigner,
} from "./fixtures.ts";

let alice: SolanaSigner;
let bob: SolanaSigner;

beforeAll(async () => {
  alice = await solanaSigner();
  bob = await solanaSigner();
});

describe("Solana order intent message", () => {
  it("is this exact labeled text, with chain id, program, asset, side, quantity, limit price, nonce and expiry", () => {
    const text = new TextDecoder().decode(solanaIntentMessage(solanaIntent(alice.wallet)));
    expect(text).toBe(
      [
        "Niara Exchange order intent v1",
        "TESTNET ONLY: no real assets, no real money.",
        "",
        "Chain: solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
        `Program: ${SOL_PROGRAM}`,
        `Wallet: ${alice.wallet}`,
        "Side: buy",
        `Asset: ${SOL_ASSET}`,
        "Quantity: 5000000 (asset base units)",
        "Lot size: 1000000 (asset base units)",
        "Limit price: 25000000 (payment base units per lot)",
        `Payment asset: ${SOL_USDT}`,
        "Nonce: 0123456789abcdef0123456789abcdef",
        `Expires at: ${NOW + 86_400} (unix seconds)`,
      ].join("\n"),
    );
  });

  it("refuses an EVM chain", () => {
    expect(() => solanaIntentMessage(solanaIntent(alice.wallet, { chain: "base-sepolia" }))).toThrow(IntentError);
  });
});

describe("Solana signature verification (ed25519 signMessage)", () => {
  it("accepts the wallet's signature over the intent", async () => {
    const intent = solanaIntent(alice.wallet);
    expect(await verifySolanaIntent(intent, await alice.sign(intent))).toBe(true);
  });

  it("refuses another wallet's signature", async () => {
    const intent = solanaIntent(alice.wallet);
    expect(await verifySolanaIntent(intent, await bob.sign(intent))).toBe(false);
  });

  it("refuses a signature replayed under another wallet's name", async () => {
    const intent = solanaIntent(alice.wallet);
    const sig = await alice.sign(intent);
    expect(await verifySolanaIntent({ ...intent, wallet: bob.wallet }, sig)).toBe(false);
  });

  it("covers every field: any change invalidates the signature", async () => {
    const intent = solanaIntent(alice.wallet);
    const sig = await alice.sign(intent);
    for (const [field, changed] of tamperedVariants(intent, patternedSolanaAddress(0x09))) {
      expect(await verifySolanaIntent(changed, sig), field).toBe(false);
    }
  });

  it("refuses a signature over a raw message that is not the canonical intent text", async () => {
    const secret = utils.randomSecretKey();
    const intent = solanaIntent(alice.wallet);
    const other = base58.encode(await signAsync(new TextEncoder().encode("hello"), secret));
    expect(await verifySolanaIntent(intent, other)).toBe(false);
  });

  it("refuses a non-canonical S (S + L) under strict verification", async () => {
    const intent = solanaIntent(alice.wallet);
    const sig = decodeSolanaSignature(await alice.sign(intent));
    // Little-endian S in bytes 32..63; add the group order L.
    const L = 2n ** 252n + 27742317777372353535851937790883648493n;
    let s = 0n;
    for (let i = 63; i >= 32; i--) s = (s << 8n) | BigInt(sig[i]!);
    const bigS = s + L;
    const forged = new Uint8Array(sig);
    for (let i = 0; i < 32; i++) forged[32 + i] = Number((bigS >> BigInt(8 * i)) & 0xffn);
    expect(bigS < 2n ** 256n).toBe(true);
    expect(await verifySolanaIntent(intent, base58.encode(forged))).toBe(false);
  });

  it("rejects malformed signatures", async () => {
    const intent = solanaIntent(alice.wallet);
    await expect(verifySolanaIntent(intent, "0OIl")).rejects.toThrow(/base58/);
    await expect(verifySolanaIntent(intent, base58.encode(new Uint8Array(63)))).rejects.toThrow(/64 bytes/);
    expect(await verifySolanaIntent(intent, base58.encode(new Uint8Array(64)))).toBe(false);
  });
});
