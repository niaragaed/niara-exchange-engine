/**
 * Mirrors the niara_exchange listings of Solana DEVNET into public.listings.
 * TESTNET ONLY. Read-only on-chain. Writes to the database only with --apply, and only
 * when the config file is marked reviewed.
 *
 *   node --env-file=.env scripts/sync-solana-listings.ts [--config config/solana-devnet.json] [--apply]
 *
 * Env: DATABASE_URL (secret, never printed), SOLANA_RPC_URL (optional; default the
 * public devnet RPC; may hold an API key, never printed).
 */
import { parseArgs } from "node:util";
import { join } from "node:path";
import { redactSecrets } from "../src/config.ts";
import { checkServiceRole } from "../src/db/repository.ts";
import { connectPg } from "../src/db/pg.ts";
import { DEFAULT_DEVNET_RPC, connectDevnet } from "../src/solana/rpc.ts";
import { applyListingSync, loadMarketConfig, planListingSync } from "../src/sync/solana-listings.ts";

const { values: args } = parseArgs({
  options: { config: { type: "string" }, apply: { type: "boolean", default: false } },
});

async function main(): Promise<void> {
  const configPath = args.config ?? join(import.meta.dirname, "..", "config", "solana-devnet.json");
  const config = loadMarketConfig(configPath);
  console.log("Niara listing sync (TESTNET ONLY, Solana devnet, read-only on-chain)");
  console.log(`config: ${configPath} (reviewed: ${config.reviewed})`);

  const rpc = await connectDevnet(process.env["SOLANA_RPC_URL"] || DEFAULT_DEVNET_RPC);
  console.log("cluster: devnet (genesis checked)");
  const plan = await planListingSync(rpc, config);

  console.log(`\nchains.solana-devnet: settlement_program ${plan.settlementProgram}, quote_asset ${plan.quoteAsset}`);
  console.log("\nApproved listings to upsert:");
  for (const u of plan.upserts) {
    console.log(`  ${u.asset}  ${u.symbol.padEnd(9)} ${u.assetClass.padEnd(12)} decimals ${u.assetDecimals}  lot_size ${u.lotSize}`);
    const onChain = `on-chain symbol ${JSON.stringify(u.metadata.symbol)}, name ${JSON.stringify(u.metadata.name)}`;
    const differs = u.metadata.symbol !== null && u.metadata.symbol !== u.symbol ? "  (differs from the config label)" : "";
    console.log(`      ${onChain}${differs}`);
  }
  console.log("Not approved on-chain (status updated only if already mirrored):");
  for (const s of plan.statusOnly) console.log(`  ${s.asset}  ${s.status}`);
  if (plan.skipped.length) console.log("Skipped:");
  for (const s of plan.skipped) console.log(`  ${s.asset}  ${s.reason}`);
  if (plan.warnings.length) console.log("Metadata warnings:");
  for (const w of plan.warnings) console.log(`  ${w}`);

  if (!args.apply) {
    console.log("\nDry run: nothing written. Re-run with --apply to write.");
    return;
  }
  if (!config.reviewed) throw new Error("the config file is not marked reviewed: refusing to write");
  const url = process.env["DATABASE_URL"];
  if (!url) throw new Error("DATABASE_URL is not set");
  const db = await connectPg(url, () => undefined);
  try {
    if (!(await checkServiceRole(db))) throw new Error("the database login role is not a member of service_role");
    const r = await applyListingSync(db, plan);
    console.log(`\nWritten: ${r.upserted} listings upserted, ${r.statusUpdated} statuses updated, chain config set.`);
  } finally {
    await db.close();
  }
}

main().catch((e: unknown) => {
  console.error(redactSecrets(`ERROR: ${e instanceof Error ? e.message : String(e)}`));
  process.exit(1);
});
