import { getPublicKeyAsync, signAsync, utils } from "@noble/ed25519";
import { base58 } from "@scure/base";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { evmIntentTypedData } from "../../src/intents/evm.ts";
import { solanaIntentMessage } from "../../src/intents/solana.ts";
import type { OrderIntent } from "../../src/intents/types.ts";

/**
 * TEST ONLY. Keys are generated per run and never leave memory; addresses below are
 * placeholders (patterned bytes), not deployed programs, mints or tokens.
 */

export const NOW = 1_800_000_000;
export const DAY = 86_400;

export function patternedSolanaAddress(byte: number): string {
  return base58.encode(new Uint8Array(32).fill(byte));
}

export const SOL_PROGRAM = patternedSolanaAddress(0x01);
export const SOL_ASSET = patternedSolanaAddress(0x02);
export const SOL_USDT = patternedSolanaAddress(0x03);

export const EVM_SETTLEMENT = "0x00000000000000000000000000000000005e7701";
export const EVM_ASSET = "0x000000000000000000000000000000000000e001";
export const EVM_USDT = "0x000000000000000000000000000000000000d001";

export interface SolanaSigner {
  wallet: string;
  sign(intent: OrderIntent): Promise<string>;
}

export async function solanaSigner(): Promise<SolanaSigner> {
  const secret = utils.randomSecretKey();
  const wallet = base58.encode(await getPublicKeyAsync(secret));
  return {
    wallet,
    // What a wallet's signMessage returns, base58-encoded by the client.
    sign: async (intent) => base58.encode(await signAsync(solanaIntentMessage(intent), secret)),
  };
}

export interface EvmSigner {
  wallet: string;
  account: PrivateKeyAccount;
  sign(intent: OrderIntent): Promise<string>;
}

export function evmSigner(): EvmSigner {
  const account = privateKeyToAccount(generatePrivateKey());
  return {
    wallet: account.address,
    account,
    // What a wallet's eth_signTypedData_v4 returns.
    sign: (intent) => account.signTypedData(evmIntentTypedData(intent)),
  };
}

export function solanaIntent(wallet: string, overrides: Partial<OrderIntent> = {}): OrderIntent {
  return {
    version: 1,
    chain: "solana-devnet",
    settlement: SOL_PROGRAM,
    wallet,
    side: "buy",
    asset: SOL_ASSET,
    quantity: 5_000_000n,
    lotSize: 1_000_000n,
    limitPrice: 25_000_000n,
    paymentAsset: SOL_USDT,
    nonce: "0123456789abcdef0123456789abcdef",
    expiresAt: NOW + DAY,
    ...overrides,
  };
}

export function evmIntent(wallet: string, overrides: Partial<OrderIntent> = {}): OrderIntent {
  return {
    version: 1,
    chain: "base-sepolia",
    settlement: EVM_SETTLEMENT,
    wallet,
    side: "sell",
    asset: EVM_ASSET,
    quantity: 5n * 10n ** 18n,
    lotSize: 10n ** 18n,
    limitPrice: 25_000_000n,
    paymentAsset: EVM_USDT,
    nonce: "fedcba9876543210fedcba9876543210",
    expiresAt: NOW + DAY,
    ...overrides,
  };
}

/** One altered copy per signed field, to show each field is covered by the signature. */
export function tamperedVariants(intent: OrderIntent, otherAddress: string): [string, OrderIntent][] {
  return [
    ["side", { ...intent, side: intent.side === "buy" ? "sell" : "buy" }],
    ["asset", { ...intent, asset: otherAddress }],
    ["quantity", { ...intent, quantity: intent.quantity + intent.lotSize }],
    ["lotSize", { ...intent, lotSize: intent.lotSize / 5n, quantity: intent.quantity }],
    ["limitPrice", { ...intent, limitPrice: intent.limitPrice + 1n }],
    ["paymentAsset", { ...intent, paymentAsset: otherAddress }],
    ["nonce", { ...intent, nonce: "11111111111111111111111111111111" }],
    ["expiresAt", { ...intent, expiresAt: intent.expiresAt + 1 }],
    ["settlement", { ...intent, settlement: otherAddress }],
  ];
}
