import { getAddress, isAddress } from "viem";
import { CHAINS, type ChainId } from "../chains.ts";
import type { ChainRow, ListingRow } from "../db/repository.ts";
import { marketKey } from "../engine/engine.ts";
import type { Market } from "../engine/types.ts";
import type { ChainConfig } from "../intents/verify.ts";

/**
 * The service's view of `chains` and `listings`: the admission config of each chain and
 * the engine's markets.
 *
 * Addresses: admission returns EVM addresses checksummed, so the engine works with
 * checksummed EVM addresses. The listing's stored spelling is kept too, because
 * `orders` and `matches` reference `listings (chain_id, asset)` by foreign key and must
 * reuse it exactly.
 */
/** A listing as `GET /v1/markets` shows it: canonical address, decimals, on-chain metadata. */
export interface CatalogListing {
  chain: ChainId;
  asset: string;
  assetClass: ListingRow["assetClass"];
  status: ListingRow["status"];
  lotSize: bigint;
  assetDecimals: number;
  symbol: string | null;
  name: string | null;
}

export interface Catalog {
  chains: ReadonlyMap<ChainId, ChainConfig & { minOrderNotional: bigint }>;
  markets: readonly Market[];
  /** Every listing that became a market, with its display fields, in the markets' order. */
  listings: readonly CatalogListing[];
  /** The listing's stored spelling of a market asset (engine spelling in). */
  dbAsset(chain: ChainId, asset: string): string | undefined;
  /** Listings that could not become a market, with the reason (logged by the service). */
  skipped: readonly { chain: ChainId; asset: string; reason: string }[];
}

/** Canonical spelling: checksummed on EVM, unchanged on Solana. Null if not an address. */
export function canonicalAddress(chain: ChainId, value: string): string | null {
  if (CHAINS[chain].kind === "solana") return value;
  return isAddress(value, { strict: false }) ? getAddress(value) : null;
}

export function buildCatalog(chainRows: readonly ChainRow[], listings: readonly ListingRow[]): Catalog {
  const chains = new Map<ChainId, ChainConfig & { minOrderNotional: bigint }>();
  for (const c of chainRows) {
    chains.set(c.id, {
      chain: c.id,
      settlementProgram: c.settlementProgram === null ? null : canonicalAddress(c.id, c.settlementProgram),
      quoteAsset: c.quoteAsset === null ? null : canonicalAddress(c.id, c.quoteAsset),
      maxIntentValiditySecs: c.maxIntentValiditySecs,
      minOrderNotional: c.minOrderNotional,
    });
  }
  const markets: Market[] = [];
  const shown: CatalogListing[] = [];
  const stored = new Map<string, string>();
  const skipped: { chain: ChainId; asset: string; reason: string }[] = [];
  for (const l of listings) {
    const chain = chains.get(l.chain);
    const asset = canonicalAddress(l.chain, l.asset);
    if (!chain) {
      skipped.push({ chain: l.chain, asset: l.asset, reason: "unknown chain" });
    } else if (asset === null) {
      skipped.push({ chain: l.chain, asset: l.asset, reason: "asset is not an address of the chain's kind" });
    } else if (stored.has(marketKey(l.chain, asset))) {
      skipped.push({ chain: l.chain, asset: l.asset, reason: "same asset listed twice with different spellings" });
    } else {
      stored.set(marketKey(l.chain, asset), l.asset);
      markets.push({
        chain: l.chain,
        asset,
        assetClass: l.assetClass,
        status: l.status,
        // An empty quote asset matches no order: admission refuses the chain anyway
        // (chain_not_ready) until USDT is configured.
        quoteAsset: chain.quoteAsset ?? "",
        lotSize: l.lotSize,
        minOrderNotional: chain.minOrderNotional,
      });
      shown.push({
        chain: l.chain,
        asset,
        assetClass: l.assetClass,
        status: l.status,
        lotSize: l.lotSize,
        assetDecimals: l.assetDecimals,
        symbol: l.symbol,
        name: l.name,
      });
    }
  }
  return {
    chains,
    markets,
    listings: shown,
    dbAsset: (chain, asset) => stored.get(marketKey(chain, asset)),
    skipped,
  };
}
