import { readFileSync } from "node:fs";
import { PublicKey } from "@solana/web3.js";
import type { Database } from "../db/database.ts";
import { asServiceRole } from "../db/repository.ts";
import type { AssetClass, ListingStatus } from "../engine/types.ts";
import { isSolanaAddress } from "../intents/validate.ts";
import {
  LISTING_DISCRIMINATOR,
  decodeConfig,
  decodeListing,
  decodeMintDecimals,
  decodeToken2022Metadata,
  pdas,
  type OnChainAssetClass,
  type OnChainListingStatus,
} from "../solana/accounts.ts";
import { PROGRAM_ID } from "../solana/idl.ts";
import { assertDevnet, type SolanaRpc } from "../solana/rpc.ts";
import { cleanMetadata, type TokenMetadata } from "./metadata.ts";

/**
 * Listing sync (Solana devnet): reads the program's listings ON-CHAIN, READ-ONLY, and
 * mirrors them into `public.listings`, with `lot_size` from a reviewed config file
 * (`config/solana-devnet.json`); sets `chains.settlement_program` and
 * `chains.quote_asset` for solana-devnet. TESTNET ONLY.
 *
 * - Approved listings are upserted; a listing without a reviewed lot size is skipped
 *   (never guessed).
 * - A listing that is no longer Approved on-chain gets its status updated if it is
 *   already in the table, and is not added otherwise.
 * - A lot size never changes while the market has live orders (their prices are per
 *   lot): the sync refuses and writes nothing.
 * - The quote asset must equal the on-chain `Config.fee_mint` (USDT, spec §3.4).
 * - `symbol` and `name` come from the mint's own Token-2022 TokenMetadata extension
 *   (null without one); the config file's symbol is only a review label.
 */

const CHAIN = "solana-devnet" as const;

export interface MarketConfig {
  programId: string;
  quoteAsset: string;
  reviewed: boolean;
  lotSizes: Record<string, { symbol: string; lotSize: bigint }>;
}

export function parseMarketConfig(json: unknown): MarketConfig {
  const o = json as Record<string, unknown>;
  if (typeof o !== "object" || o === null) throw new Error("config must be an object");
  if (o["cluster"] !== "devnet") throw new Error("config.cluster must be devnet");
  const programId = o["programId"];
  const quoteAsset = o["quoteAsset"];
  if (typeof programId !== "string" || programId !== PROGRAM_ID.toBase58()) {
    throw new Error(`config.programId must be the IDL's program ${PROGRAM_ID.toBase58()}`);
  }
  if (typeof quoteAsset !== "string" || !isSolanaAddress(quoteAsset)) throw new Error("config.quoteAsset must be a mint");
  if (typeof o["reviewed"] !== "boolean") throw new Error("config.reviewed must be true or false");
  const lots = o["lotSizes"] as Record<string, { symbol?: unknown; lotSize?: unknown }>;
  if (typeof lots !== "object" || lots === null) throw new Error("config.lotSizes must be an object");
  const lotSizes: MarketConfig["lotSizes"] = {};
  for (const [mint, v] of Object.entries(lots)) {
    if (!isSolanaAddress(mint)) throw new Error(`config.lotSizes: ${mint} is not a mint address`);
    if (typeof v.lotSize !== "string" || !/^[1-9][0-9]*$/.test(v.lotSize)) {
      throw new Error(`config.lotSizes.${mint}.lotSize must be a positive integer string`);
    }
    lotSizes[mint] = { symbol: String(v.symbol ?? ""), lotSize: BigInt(v.lotSize) };
  }
  return { programId, quoteAsset, reviewed: o["reviewed"], lotSizes };
}

export function loadMarketConfig(path: string): MarketConfig {
  return parseMarketConfig(JSON.parse(readFileSync(path, "utf8")));
}

export interface ListingUpsert {
  asset: string;
  /** The reviewed config file's label (logs only). */
  symbol: string;
  /** Published on-chain by the token itself: stored in listings.symbol and listings.name. */
  metadata: TokenMetadata;
  issuer: string | null;
  assetClass: AssetClass;
  status: ListingStatus;
  cashbackEligible: boolean;
  docHash: string | null;
  assetDecimals: number;
  lotSize: bigint;
}

export interface SyncPlan {
  settlementProgram: string;
  quoteAsset: string;
  /** Approved on-chain, with a reviewed lot size. */
  upserts: ListingUpsert[];
  /** Not Approved on-chain: status written only if the listing is already mirrored. */
  statusOnly: { asset: string; status: ListingStatus }[];
  skipped: { asset: string; reason: string }[];
  /** On-chain metadata that was published but not stored. */
  warnings: string[];
}

const CLASS: Record<OnChainAssetClass, AssetClass> = {
  Equity: "equity",
  FixedIncome: "fixed_income",
  Credit: "credit",
  Currency: "currency",
};
const STATUS: Record<OnChainListingStatus, ListingStatus> = {
  Pending: "pending",
  Approved: "approved",
  Suspended: "suspended",
  Delisted: "delisted",
  Quoted: "quoted",
};

/** Reads devnet (read-only) and computes what the sync would write. */
export async function planListingSync(rpc: SolanaRpc, config: MarketConfig): Promise<SyncPlan> {
  await assertDevnet(rpc);
  const programId = new PublicKey(config.programId);
  const [configAccount] = await rpc.getAccounts([pdas(programId).config()]);
  if (!configAccount) throw new Error("the program has no Config account on devnet");
  const onChain = decodeConfig(configAccount.data);
  if (onChain.feeMint.toBase58() !== config.quoteAsset) {
    throw new Error(`config.quoteAsset ${config.quoteAsset} is not the on-chain fee mint ${onChain.feeMint.toBase58()}`);
  }

  const listings = (await rpc.getProgramAccounts(programId, LISTING_DISCRIMINATOR))
    .map((a) => decodeListing(a.account.data))
    .sort((a, b) => (a.assetMint.toBase58() < b.assetMint.toBase58() ? -1 : 1));
  const approved = listings.filter((l) => l.status === "Approved");
  const mints = await rpc.getAccounts(approved.map((l) => l.assetMint));

  const plan: SyncPlan = {
    settlementProgram: programId.toBase58(),
    quoteAsset: config.quoteAsset,
    upserts: [],
    statusOnly: [],
    skipped: [],
    warnings: [],
  };
  for (const l of listings) {
    const asset = l.assetMint.toBase58();
    if (l.status !== "Approved") {
      plan.statusOnly.push({ asset, status: STATUS[l.status] });
      continue;
    }
    const reviewed = config.lotSizes[asset];
    if (!reviewed) {
      plan.skipped.push({ asset, reason: "no reviewed lot size in the config file" });
      continue;
    }
    const mint = mints[approved.indexOf(l)];
    if (!mint) {
      plan.skipped.push({ asset, reason: "mint account not found" });
      continue;
    }
    const currency = l.assetClass === "Currency";
    let raw: { name: string; symbol: string } | null = null;
    try {
      raw = decodeToken2022Metadata(mint.data, l.assetMint);
    } catch (e) {
      plan.warnings.push(`${asset}: Token-2022 metadata not read (${(e as Error).message})`);
    }
    const { metadata, warnings } = cleanMetadata(raw ?? { symbol: null, name: null }, asset);
    plan.warnings.push(...warnings);
    plan.upserts.push({
      asset,
      symbol: reviewed.symbol,
      metadata,
      issuer: currency ? null : l.issuer.toBase58(),
      assetClass: CLASS[l.assetClass],
      status: "approved",
      cashbackEligible: currency ? false : l.cashbackEligible,
      docHash: currency || l.docHash.every((b) => b === 0) ? null : Buffer.from(l.docHash).toString("hex"),
      assetDecimals: decodeMintDecimals(mint.data),
      lotSize: reviewed.lotSize,
    });
  }
  return plan;
}

export interface SyncResult {
  upserted: number;
  statusUpdated: number;
}

export class LotSizeChangeError extends Error {
  constructor(asset: string) {
    super(`refusing to change the lot size of ${asset}: it has live orders (their prices are per lot)`);
    this.name = "LotSizeChangeError";
  }
}

/** Writes the plan in one service_role transaction. `tx_hash` is left as stored. */
export async function applyListingSync(db: Database, plan: SyncPlan): Promise<SyncResult> {
  return asServiceRole(db, async (tx) => {
    await tx.query(`update public.chains set settlement_program = $2, quote_asset = $3 where id = $1`, [
      CHAIN,
      plan.settlementProgram,
      plan.quoteAsset,
    ]);
    let upserted = 0;
    for (const u of plan.upserts) {
      const current = await tx.query<{ lot_size: string; live: string }>(
        `select l.lot_size::text,
                (select count(*) from public.orders o where o.chain_id = l.chain_id and o.asset = l.asset
                   and o.status in ('open', 'partially_filled', 'stale'))::text as live
           from public.listings l where l.chain_id = $1 and l.asset = $2`,
        [CHAIN, u.asset],
      );
      const row = current.rows[0];
      if (row && BigInt(row.lot_size) !== u.lotSize && Number(row.live) > 0) throw new LotSizeChangeError(u.asset);
      await tx.query(
        `insert into public.listings
           (chain_id, asset, issuer, asset_class, status, cashback_eligible, doc_hash, asset_decimals, lot_size,
            symbol, name)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         on conflict (chain_id, asset) do update set
           issuer = excluded.issuer, asset_class = excluded.asset_class, status = excluded.status,
           cashback_eligible = excluded.cashback_eligible, doc_hash = excluded.doc_hash,
           asset_decimals = excluded.asset_decimals, lot_size = excluded.lot_size,
           symbol = excluded.symbol, name = excluded.name`,
        [
          CHAIN,
          u.asset,
          u.issuer,
          u.assetClass,
          u.status,
          u.cashbackEligible,
          u.docHash,
          u.assetDecimals,
          u.lotSize.toString(),
          u.metadata.symbol,
          u.metadata.name,
        ],
      );
      upserted += 1;
    }
    let statusUpdated = 0;
    for (const s of plan.statusOnly) {
      const r = await tx.query<{ asset: string }>(
        `update public.listings set status = $3 where chain_id = $1 and asset = $2 and status <> $3 returning asset`,
        [CHAIN, s.asset, s.status],
      );
      statusUpdated += r.rows.length;
    }
    return { upserted, statusUpdated };
  });
}
