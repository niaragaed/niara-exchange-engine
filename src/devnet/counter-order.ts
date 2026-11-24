import { INTENT_VERSION, type OrderIntent } from "../intents/types.ts";
import type { Side } from "../engine/types.ts";
import { orderNeed, type CoverageNeed } from "../solana/coverage.ts";
import { parseUnits } from "../units.ts";

/**
 * A resting order from a demo investor wallet on Solana DEVNET, for a browser tester to
 * trade against (scripts/counter-order.ts). Pure: the intent, the exact delegation it
 * needs, and the checks; the script reads the chain, approves, signs and submits.
 * TESTNET ONLY.
 */

export interface CounterMarket {
  /** The program id (the intent's `settlement`). */
  program: string;
  asset: string;
  assetDecimals: number;
  /** Base units of the asset per lot (the listing's lot_size). */
  lotSize: bigint;
  usdt: string;
  usdtDecimals: number;
}

export interface CounterOrderArgs {
  wallet: string;
  side: Side;
  /** Shares (whole units of the asset), decimal text. */
  quantity: string;
  /** mockUSDT per share, decimal text. */
  price: string;
  /** Unix seconds. */
  expiresAt: number;
  /** 32 lowercase hex chars. */
  nonce: string;
}

export class CounterOrderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CounterOrderError";
  }
}

/**
 * The order intent: quantity in asset base units (whole lots), limit price in mockUSDT
 * base units per lot (the price per share times the shares in a lot, exactly).
 */
export function counterIntent(market: CounterMarket, a: CounterOrderArgs): OrderIntent {
  if (a.side !== "buy" && a.side !== "sell") throw new CounterOrderError("side must be buy or sell");
  if (!/^[0-9a-f]{32}$/.test(a.nonce)) throw new CounterOrderError("nonce must be 32 lowercase hex characters");
  const quantity = parseUnits(a.quantity, market.assetDecimals);
  if (quantity <= 0n || quantity % market.lotSize !== 0n) {
    throw new CounterOrderError(`quantity must be a positive whole number of lots (a lot is ${market.lotSize} base units)`);
  }
  const perShare = parseUnits(a.price, market.usdtDecimals); // mockUSDT base units per whole share
  const scaled = perShare * market.lotSize;
  const shareUnits = 10n ** BigInt(market.assetDecimals);
  if (perShare <= 0n || scaled % shareUnits !== 0n) throw new CounterOrderError("price must be positive and a whole number of mockUSDT base units per lot");
  return {
    version: INTENT_VERSION,
    chain: "solana-devnet",
    settlement: market.program,
    wallet: a.wallet,
    side: a.side,
    asset: market.asset,
    quantity,
    lotSize: market.lotSize,
    limitPrice: scaled / shareUnits,
    paymentAsset: market.usdt,
    nonce: a.nonce,
    expiresAt: a.expiresAt,
  };
}

/** The exact delegation the service checks for this order (spec §3.5): the same `orderNeed`. */
export function counterDelegation(intent: OrderIntent): CoverageNeed {
  return orderNeed({ ...intent, remaining: intent.quantity });
}

const LIVE = new Set(["open", "partially_filled", "stale"]);

/**
 * The wallet's other live orders whose delegation sits on the same token account as
 * this one (sells: the asset account; buys: the USDT account). `approve` REPLACES a
 * token account's delegation, so an exact approval for the new order would shrink
 * theirs: the script refuses while any exist.
 */
export function ordersSharingDelegation(
  orders: readonly { id: string; side: string; status: string; asset: string; paymentAsset: string }[],
  intent: OrderIntent,
): string[] {
  return orders
    .filter((o) => LIVE.has(o.status))
    .filter((o) => (intent.side === "sell" ? o.side === "sell" && o.asset === intent.asset : o.side === "buy" && o.paymentAsset === intent.paymentAsset))
    .map((o) => o.id);
}

/** The deployed order service (docs/deploy-railway.md). */
export const DEPLOYED_ENGINE_URL = "https://api.niaraglobal.com";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * `--engine-url`: the order service the script talks to. https anywhere, plain http
 * only for localhost (an order intent must not cross the network in the clear).
 * Returns the origin; a path, query or credentials are refused.
 */
export function engineUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CounterOrderError(`--engine-url is not a URL: ${raw}`);
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new CounterOrderError("--engine-url must be a bare origin (scheme, host, optional port): no path, query or credentials");
  }
  if (url.protocol === "http:" && !LOCAL_HOSTS.has(url.hostname)) {
    throw new CounterOrderError(`--engine-url must be https (http is allowed only for localhost): ${url.origin}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new CounterOrderError("--engine-url must be an https URL");
  return url.origin;
}
