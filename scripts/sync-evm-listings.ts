/**
 * Mirrors the ListingRegistry listings of one EVM TESTNET into public.listings.
 * TESTNET ONLY. Read-only on-chain (eth_call, eth_getLogs). Writes to the database only
 * with --apply, and only when the chain is marked reviewed in the config file.
 *
 *   node --env-file=.env scripts/sync-evm-listings.ts --chain base-sepolia [--config config/evm-testnets.json] [--apply]
 *
 * Chains: base-sepolia, robinhood-testnet, tempo-testnet (hyperevm-testnet once deployed).
 * Env: DATABASE_URL (secret, never printed, only with --apply); BASE_SEPOLIA_RPC_URL,
 * ROBINHOOD_TESTNET_RPC_URL, TEMPO_TESTNET_RPC_URL (optional; default the public RPC;
 * may hold an API key, never printed). The node's chain id is checked first.
 */
import { parseArgs } from "node:util";
import { redactSecrets } from "../src/config.ts";
import { connectPg } from "../src/db/pg.ts";
import { checkServiceRole } from "../src/db/repository.ts";
import { PUBLIC_RPC, RPC_ENV, connectEvm, httpTransport, rpcUrlFor } from "../src/evm/client.ts";
import { DEFAULT_EVM_CONFIG, deployedChain, isEvmChainId, loadEvmSettings } from "../src/evm/settings.ts";
import { applyEvmListingSync, planEvmListingSync } from "../src/sync/evm-listings.ts";

const { values: args } = parseArgs({
  options: {
    chain: { type: "string" },
    config: { type: "string" },
    apply: { type: "boolean", default: false },
  },
});

async function main(): Promise<void> {
  const chain = args.chain;
  if (!isEvmChainId(chain)) throw new Error("--chain must be base-sepolia, robinhood-testnet, tempo-testnet or hyperevm-testnet");
  const configPath = args.config ?? DEFAULT_EVM_CONFIG;
  const settings = deployedChain(loadEvmSettings(configPath), chain, { requireReviewed: false });
  console.log(`Niara listing sync (TESTNET ONLY, ${chain}, read-only on-chain)`);
  console.log(`config: ${configPath} (reviewed: ${settings.reviewed})`);
  const url = rpcUrlFor(chain);
  console.log(`rpc: ${url === PUBLIC_RPC[chain] ? url : `${RPC_ENV[chain]} (custom, not shown)`}`);

  const client = await connectEvm(chain, httpTransport(url));
  console.log(`chain id: ${settings.evmChainId} (checked)`);
  const plan = await planEvmListingSync(client, settings);

  console.log(`\nchains.${chain}: settlement_program ${plan.settlementProgram}, quote_asset ${plan.quoteAsset}`);
  console.log(`ListingRegistry events scanned: blocks ${plan.fromBlock} to ${plan.toBlock}`);
  console.log("\nApproved listings to upsert:");
  for (const u of plan.upserts) {
    console.log(`  ${u.asset}  ${u.symbol.padEnd(9)} ${u.assetClass.padEnd(12)} decimals ${u.assetDecimals}  lot_size ${u.lotSize}  approved in ${u.txHash ?? "(unknown)"}`);
  }
  console.log("Not approved on-chain (status updated only if already mirrored):");
  for (const s of plan.statusOnly) console.log(`  ${s.asset}  ${s.status}`);
  if (plan.skipped.length) console.log("Skipped:");
  for (const s of plan.skipped) console.log(`  ${s.asset}  ${s.reason}`);

  if (!args.apply) {
    console.log("\nDry run: nothing written. Re-run with --apply to write.");
    return;
  }
  if (!settings.reviewed) throw new Error(`${chain} is not marked reviewed in the config file: refusing to write`);
  const dbUrl = process.env["DATABASE_URL"];
  if (!dbUrl) throw new Error("DATABASE_URL is not set");
  const db = await connectPg(dbUrl, () => undefined);
  try {
    if (!(await checkServiceRole(db))) throw new Error("the database login role is not a member of service_role");
    const r = await applyEvmListingSync(db, plan);
    console.log(`\nWritten: ${r.upserted} listings upserted, ${r.statusUpdated} statuses updated, chain config set.`);
  } finally {
    await db.close();
  }
}

main().catch((e: unknown) => {
  console.error(redactSecrets(`ERROR: ${e instanceof Error ? e.message : String(e)}`));
  process.exit(1);
});
