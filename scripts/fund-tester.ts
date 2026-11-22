/**
 * Funds a browser tester's wallet on Solana DEVNET. TESTNET ONLY: devnet SOL and test
 * tokens (mockUSDT, tEQTY), no real assets, no real money. The RPC's genesis hash must
 * be devnet's.
 *
 *   node --env-file=.env scripts/fund-tester.ts <solana address> [--sol 0.2] [--usdt 1000] [--eqty 20] [--dry-run]
 *
 * ONE devnet transaction, simulated first (--dry-run stops after the simulation):
 *   - the demo funder sends `--sol` devnet SOL and pays the fees and the rent;
 *   - the tester's associated token accounts for mockUSDT and tEQTY are created if
 *     missing (idempotent);
 *   - the demo "equity-seller" wallet of the 2026-11-14 demo run (it holds both) sends
 *     `--usdt` mockUSDT and `--eqty` tEQTY (transfer_checked).
 *
 * Keys: ~/.config/niara-exchange/devnet/ (demo-funder.json and the demo run's
 * equity-seller.json), read into memory and never printed. The tester must be a wallet
 * (on the ed25519 curve) and not one of those keys. Amounts are capped per run.
 *
 * Log: ~/niara-logs/fund-tester-<time>.log.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Keypair, PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { redactSecrets } from "../src/config.ts";
import { checkFundingBalances, fundingInstructions, type FundingRequest } from "../src/devnet/funding.ts";
import { decodeConfig, decodeMintDecimals, decodeTokenAccount, isTokenProgram, pdas } from "../src/solana/accounts.ts";
import { mapTransactionError } from "../src/solana/errors.ts";
import { loadKeypairFile } from "../src/solana/keypair.ts";
import { DEFAULT_DEVNET_RPC, connectDevnet } from "../src/solana/rpc.ts";
import { formatUnits, parseUnits } from "../src/units.ts";

const ASSET_MINT = new PublicKey("8LjQkS1rTJGpzz9wbyAmqJk7oZgDsZS6vhPBv2BhzsTo"); // tEQTY (TEST)
const KEYS = join(homedir(), ".config", "niara-exchange", "devnet");
const RUN = join(KEYS, "demo-runs", "2026-11-14T10-31-02-302Z");

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    sol: { type: "string", default: "0.2" },
    usdt: { type: "string", default: "1000" },
    eqty: { type: "string", default: "20" },
    "dry-run": { type: "boolean", default: false },
  },
});

const logDir = join(homedir(), "niara-logs");
mkdirSync(logDir, { recursive: true });
const logFile = join(logDir, `fund-tester-${new Date().toISOString().replace(/[:.]/g, "-")}.log`);
function say(line = ""): void {
  const safe = redactSecrets(line);
  console.log(safe);
  appendFileSync(logFile, `${safe}\n`);
}
const explorer = (kind: "tx" | "address", v: string) => `https://explorer.solana.com/${kind}/${v}?cluster=devnet`;

async function main(): Promise<void> {
  if (positionals.length !== 1) throw new Error("usage: scripts/fund-tester.ts <solana address> [--sol 0.2] [--usdt 1000] [--eqty 20] [--dry-run]");
  let tester: PublicKey;
  try {
    tester = new PublicKey(positionals[0]!);
  } catch {
    throw new Error(`${positionals[0]} is not a Solana address`);
  }

  say("Niara tester funding, Solana DEVNET (TESTNET ONLY: devnet SOL and test tokens, no real value)");
  say(`log: ${logFile}`);
  const rpc = await connectDevnet(process.env["SOLANA_RPC_URL"] || DEFAULT_DEVNET_RPC);
  say("cluster: devnet (genesis hash checked)");

  const [configAccount, assetMintAccount] = await rpc.getAccounts([pdas().config(), ASSET_MINT]);
  if (!configAccount || !assetMintAccount) throw new Error("program Config or tEQTY mint not found on devnet");
  const usdtMint = decodeConfig(configAccount.data).feeMint; // mockUSDT: the program's fee mint
  const [usdtMintAccount] = await rpc.getAccounts([usdtMint]);
  if (!usdtMintAccount) throw new Error("mockUSDT mint not found");
  for (const m of [assetMintAccount, usdtMintAccount]) if (!isTokenProgram(m.owner)) throw new Error("a mint is not owned by an SPL token program");
  const usdt = { mint: usdtMint, tokenProgram: usdtMintAccount.owner, decimals: decodeMintDecimals(usdtMintAccount.data) };
  const asset = { mint: ASSET_MINT, tokenProgram: assetMintAccount.owner, decimals: decodeMintDecimals(assetMintAccount.data) };

  const funder = loadKeypairFile(join(KEYS, "demo-funder.json"), "demo funder");
  const source = loadKeypairFile(join(RUN, "equity-seller.json"), "demo equity-seller wallet");
  const forbidden: PublicKey[] = [funder.publicKey, source.publicKey];
  for (const f of ["settlement-operator.json", "treasury.json", "listing-authority.json", "mock-mint-authority.json"]) {
    try {
      forbidden.push(loadKeypairFile(join(KEYS, f), f).publicKey);
    } catch {
      // a missing key file cannot be the tester
    }
  }

  const request: FundingRequest = {
    tester,
    funder: funder.publicKey,
    source: source.publicKey,
    usdt,
    asset,
    lamports: parseUnits(args.sol, 9),
    usdtAmount: parseUnits(args.usdt, usdt.decimals),
    assetAmount: parseUnits(args.eqty, asset.decimals),
    forbidden,
  };
  const { instructions, accounts } = fundingInstructions(request);

  say(`tester:  ${tester.toBase58()}  ${explorer("address", tester.toBase58())}`);
  say(`funder:  ${funder.publicKey.toBase58()} (demo funder: SOL, fees, rent)`);
  say(`source:  ${source.publicKey.toBase58()} (demo "equity-seller" wallet: the tokens)`);
  say(`sending: ${args.sol} SOL, ${formatUnits(request.usdtAmount, usdt.decimals)} mockUSDT, ${formatUnits(request.assetAmount, asset.decimals)} tEQTY`);

  const read = async () => {
    const [f, su, sa, tu, ta, t] = await rpc.getAccounts([funder.publicKey, accounts.sourceUsdt, accounts.sourceAsset, accounts.testerUsdt, accounts.testerAsset, tester]);
    const amount = (a: typeof f) => (a ? decodeTokenAccount(a.data).amount : null);
    return {
      funderLamports: BigInt(f?.lamports ?? 0),
      sourceUsdt: amount(su),
      sourceAsset: amount(sa),
      testerUsdt: amount(tu),
      testerAsset: amount(ta),
      testerLamports: BigInt(t?.lamports ?? 0),
    };
  };
  const show = (title: string, b: Awaited<ReturnType<typeof read>>) => {
    const tok = (v: bigint | null, d: number) => (v === null ? "(no account)" : formatUnits(v, d));
    say(title);
    say(`  tester  SOL ${formatUnits(b.testerLamports, 9)}  mockUSDT ${tok(b.testerUsdt, usdt.decimals)}  tEQTY ${tok(b.testerAsset, asset.decimals)}`);
    say(`  source  mockUSDT ${tok(b.sourceUsdt, usdt.decimals)}  tEQTY ${tok(b.sourceAsset, asset.decimals)}`);
    say(`  funder  SOL ${formatUnits(b.funderLamports, 9)}`);
  };
  const before = await read();
  show("\nbalances before:", before);
  checkFundingBalances(request, before);

  const { blockhash, lastValidBlockHeight } = await rpc.getLatestBlockhash();
  const tx = new VersionedTransaction(
    new TransactionMessage({ payerKey: funder.publicKey, recentBlockhash: blockhash, instructions }).compileToV0Message(),
  );
  tx.sign([funder, source] as Keypair[]);
  const sim = await rpc.simulate(tx);
  if (sim.err) {
    const f = mapTransactionError(sim.err, sim.logs);
    throw new Error(`simulation refused (${f === "already_settled" ? JSON.stringify(sim.err) : f.message}); nothing sent\n${sim.logs.join("\n")}`);
  }
  say("\nsimulation: ok");
  if (args["dry-run"]) {
    say("Dry run: nothing sent.");
    return;
  }
  const sig = await rpc.send(tx);
  const conf = await rpc.confirm(sig, blockhash, lastValidBlockHeight);
  if (conf.err) throw new Error(`transaction failed: ${JSON.stringify(conf.err)}`);
  say(`sent: ${explorer("tx", sig)}`);
  show("\nbalances after (a public RPC can lag a few seconds):", await read());
}

main().catch((e: unknown) => {
  say(`\nERROR: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
