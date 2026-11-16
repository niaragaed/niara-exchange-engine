import type { ChainId } from "../../src/chains.ts";
import type { Market, OrderInput } from "../../src/engine/types.ts";

/**
 * TEST ONLY: a deterministic UUID v4 generator (splitmix64 seeded), so that runs can
 * be compared byte for byte. Production uses `randomMatchId` (OS CSPRNG).
 */
export function seededUuidV4(seed: number): () => string {
  let state = BigInt(seed) & 0xffffffffffffffffn;
  const next = (): bigint => {
    state = (state + 0x9e3779b97f4a7c15n) & 0xffffffffffffffffn;
    let z = state;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & 0xffffffffffffffffn;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & 0xffffffffffffffffn;
    return z ^ (z >> 31n);
  };
  return () => {
    const hex = (next().toString(16).padStart(16, "0") + next().toString(16).padStart(16, "0")).split("");
    hex[12] = "4";
    hex[16] = "89ab"[Number.parseInt(hex[16]!, 16) & 3]!;
    const h = hex.join("");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  };
}

// Labeled test identifiers: not real mints, tokens or wallets.
export const CHAIN: ChainId = "solana-devnet";
export const OTHER_CHAIN: ChainId = "base-sepolia";
export const ASSET = "TEST-EQUITY-A";
export const ASSET_B = "TEST-EQUITY-B";
export const USDT = "TEST-USDT";
export const LOT = 100n;
export const NOW = 1_800_000_000;
export const DAY = 86_400;

export function market(overrides: Partial<Market> = {}): Market {
  return {
    chain: CHAIN,
    asset: ASSET,
    assetClass: "equity",
    status: "approved",
    quoteAsset: USDT,
    lotSize: LOT,
    minOrderNotional: 0n,
    ...overrides,
  };
}

let counter = 0;

export function order(overrides: Partial<OrderInput> & Pick<OrderInput, "side" | "wallet">): OrderInput {
  counter += 1;
  return {
    id: `order-${counter}`,
    chain: CHAIN,
    asset: ASSET,
    paymentAsset: USDT,
    quantity: 10n * LOT,
    limitPrice: 1_000n,
    lotSize: LOT,
    expiresAt: NOW + DAY,
    ...overrides,
  };
}
