import { getAddress, isAddressEqual, toEventSelector, zeroAddress, zeroHash, type Address, type Hex } from "viem";
import type { Database } from "../db/database.ts";
import { asServiceRole } from "../db/repository.ts";
import type { AssetClass, ListingStatus } from "../engine/types.ts";
import { LISTING_REGISTRY_ABI } from "../evm/abi/ListingRegistry.ts";
import { NATIVE_ASSET_TOKEN_ABI } from "../evm/abi/NativeAssetToken.ts";
import { NIARA_SETTLEMENT_ABI } from "../evm/abi/NiaraSettlement.ts";
import type { EvmClient } from "../evm/client.ts";
import { scanLogs } from "../evm/logs.ts";
import type { DeployedEvmChain, EvmChainId } from "../evm/settings.ts";
import { cleanMetadata } from "./metadata.ts";
import { LotSizeChangeError, type ListingUpsert, type SyncResult } from "./solana-listings.ts";

/**
 * Listing sync (EVM testnets): finds every token the ListingRegistry ever emitted a
 * listing event for (ListingSubmitted, ListingQuoted, ListingApproved, ListingSuspended,
 * ListingDelisted), from the deployment block, READ-ONLY, then reads each one's current
 * state with `getListing` (the events find tokens; the contract's state is what counts),
 * and mirrors them into `public.listings` with `lot_size` from the reviewed config file
 * (`config/evm-testnets.json`). Sets `chains.settlement_program` (NiaraSettlement) and
 * `chains.quote_asset` (its feeToken). TESTNET ONLY.
 *
 * Same rules as the Solana sync: Approved listings are upserted, never without a reviewed
 * lot size; a listing no longer Approved only gets its status updated if it is already
 * mirrored; a lot size never changes while the market has live orders. `tx_hash` is the
 * token's latest ListingApproved transaction. `symbol` and `name` are the token's own
 * `symbol()` and `name()` (null if it reverts or publishes nothing storable); the config
 * file's symbol is only a review label.
 */

const EVENTS = ["ListingSubmitted", "ListingQuoted", "ListingApproved", "ListingSuspended", "ListingDelisted"] as const;

function eventTopic(name: (typeof EVENTS)[number]): Hex {
  const item = LISTING_REGISTRY_ABI.find((i) => i.type === "event" && i.name === name);
  if (!item || item.type !== "event") throw new Error(`ListingRegistry ABI has no event ${name}`);
  return toEventSelector(item);
}

const TOPICS = EVENTS.map(eventTopic);
const APPROVED_TOPIC = eventTopic("ListingApproved");

/** IListingRegistry.AssetClass and ListingStatus, by their enum values. */
const CLASS: Record<number, AssetClass> = { 0: "equity", 1: "fixed_income", 2: "credit", 3: "currency" };
const STATUS: Record<number, ListingStatus | null> = {
  0: null, // None: no listing
  1: "pending",
  2: "approved",
  3: "suspended",
  4: "delisted",
  5: "quoted",
};

export interface EvmSyncPlan {
  chain: EvmChainId;
  settlementProgram: Address;
  quoteAsset: Address;
  /** The blocks scanned. */
  fromBlock: bigint;
  toBlock: bigint;
  upserts: (ListingUpsert & { txHash: string | null })[];
  statusOnly: { asset: string; status: ListingStatus }[];
  skipped: { asset: string; reason: string }[];
  /** On-chain metadata that was published but not stored. */
  warnings: string[];
}

/** Reads the chain (read-only) and computes what the sync would write. */
export async function planEvmListingSync(
  client: EvmClient,
  s: DeployedEvmChain,
  options: { logChunk?: bigint } = {},
): Promise<EvmSyncPlan> {
  const settlement = s.contracts.settlement;
  const [feeToken, registry] = await Promise.all([
    client.readContract({ address: settlement, abi: NIARA_SETTLEMENT_ABI, functionName: "feeToken" }),
    client.readContract({ address: settlement, abi: NIARA_SETTLEMENT_ABI, functionName: "listingRegistry" }),
  ]);
  if (!isAddressEqual(feeToken, s.quoteAsset)) throw new Error(`config quoteAsset ${s.quoteAsset} is not NiaraSettlement.feeToken ${feeToken}`);
  if (!isAddressEqual(registry, s.contracts.listingRegistry)) {
    throw new Error(`config listingRegistry ${s.contracts.listingRegistry} is not NiaraSettlement.listingRegistry ${registry}`);
  }

  const toBlock = await client.getBlockNumber();
  const logs = await scanLogs(client, {
    address: s.contracts.listingRegistry,
    topics: TOPICS,
    fromBlock: s.fromBlock,
    toBlock,
    ...(options.logChunk ? { chunk: options.logChunk } : {}),
  });
  const tokens = new Map<Address, string | null>(); // token -> latest ListingApproved tx
  for (const l of logs) {
    const topic = l.topics[1];
    if (!topic) continue;
    const token = getAddress(`0x${topic.slice(26)}`);
    if (!tokens.has(token)) tokens.set(token, null);
    if (l.topics[0] === APPROVED_TOPIC) tokens.set(token, l.transactionHash);
  }

  const plan: EvmSyncPlan = {
    chain: s.chain,
    settlementProgram: settlement,
    quoteAsset: s.quoteAsset,
    fromBlock: s.fromBlock,
    toBlock,
    upserts: [],
    statusOnly: [],
    skipped: [],
    warnings: [],
  };
  for (const token of [...tokens.keys()].sort()) {
    const l = await client.readContract({ address: s.contracts.listingRegistry, abi: LISTING_REGISTRY_ABI, functionName: "getListing", args: [token] });
    const status = STATUS[l.status];
    const assetClass = CLASS[l.assetClass];
    if (!status || !assetClass) {
      plan.skipped.push({ asset: token, reason: `no listing on-chain (status ${l.status})` });
      continue;
    }
    if (status !== "approved") {
      plan.statusOnly.push({ asset: token, status });
      continue;
    }
    const reviewed = s.lotSizes[token];
    if (!reviewed) {
      plan.skipped.push({ asset: token, reason: "no reviewed lot size in the config file" });
      continue;
    }
    const decimals = await client.readContract({ address: token, abi: NATIVE_ASSET_TOKEN_ABI, functionName: "decimals" });
    const text = async (functionName: "symbol" | "name"): Promise<string | null> => {
      try {
        return await client.readContract({ address: token, abi: NATIVE_ASSET_TOKEN_ABI, functionName });
      } catch (e) {
        plan.warnings.push(`${token}: ${functionName}() not read (${(e as Error).message.split("\n")[0]})`);
        return null;
      }
    };
    const { metadata, warnings } = cleanMetadata({ symbol: await text("symbol"), name: await text("name") }, token);
    plan.warnings.push(...warnings);
    const currency = assetClass === "currency";
    plan.upserts.push({
      asset: token,
      symbol: reviewed.symbol,
      metadata,
      issuer: currency || isAddressEqual(l.issuer, zeroAddress) ? null : getAddress(l.issuer),
      assetClass,
      status: "approved",
      cashbackEligible: currency ? false : l.cashbackEligible,
      docHash: currency || l.docHash === zeroHash ? null : l.docHash.slice(2).toLowerCase(),
      assetDecimals: decimals,
      lotSize: reviewed.lotSize,
      txHash: tokens.get(token) ?? null,
    });
  }
  return plan;
}

/** Writes the plan in one service_role transaction. */
export async function applyEvmListingSync(db: Database, plan: EvmSyncPlan): Promise<SyncResult> {
  return asServiceRole(db, async (tx) => {
    await tx.query(`update public.chains set settlement_program = $2, quote_asset = $3 where id = $1`, [
      plan.chain,
      plan.settlementProgram,
      plan.quoteAsset,
    ]);
    let upserted = 0;
    for (const u of plan.upserts) {
      // Any stored spelling of the address (EVM addresses are case-insensitive).
      const current = await tx.query<{ asset: string; lot_size: string; live: string }>(
        `select l.asset, l.lot_size::text,
                (select count(*) from public.orders o where o.chain_id = l.chain_id and o.asset = l.asset
                   and o.status in ('open', 'partially_filled', 'stale'))::text as live
           from public.listings l where l.chain_id = $1 and lower(l.asset) = lower($2)`,
        [plan.chain, u.asset],
      );
      const row = current.rows[0];
      if (row && BigInt(row.lot_size) !== u.lotSize && Number(row.live) > 0) throw new LotSizeChangeError(u.asset);
      const asset = row?.asset ?? u.asset; // keep the stored spelling (orders reference it)
      await tx.query(
        `insert into public.listings
           (chain_id, asset, issuer, asset_class, status, cashback_eligible, doc_hash, asset_decimals, lot_size, tx_hash,
            symbol, name)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         on conflict (chain_id, asset) do update set
           issuer = excluded.issuer, asset_class = excluded.asset_class, status = excluded.status,
           cashback_eligible = excluded.cashback_eligible, doc_hash = excluded.doc_hash,
           asset_decimals = excluded.asset_decimals, lot_size = excluded.lot_size,
           tx_hash = coalesce(excluded.tx_hash, public.listings.tx_hash),
           symbol = excluded.symbol, name = excluded.name`,
        [
          plan.chain,
          asset,
          u.issuer,
          u.assetClass,
          u.status,
          u.cashbackEligible,
          u.docHash,
          u.assetDecimals,
          u.lotSize.toString(),
          u.txHash,
          u.metadata.symbol,
          u.metadata.name,
        ],
      );
      upserted += 1;
    }
    let statusUpdated = 0;
    for (const st of plan.statusOnly) {
      const r = await tx.query<{ asset: string }>(
        `update public.listings set status = $3 where chain_id = $1 and lower(asset) = lower($2) and status <> $3 returning asset`,
        [plan.chain, st.asset, st.status],
      );
      statusUpdated += r.rows.length;
    }
    return { upserted, statusUpdated };
  });
}
