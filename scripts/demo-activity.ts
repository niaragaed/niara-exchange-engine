/**
 * DEMO ACTIVITY on Solana DEVNET: real orders, matches and settlements between demo
 * wallets that NIARA CONTROLS, so the chart and the history show settled trades.
 * TESTNET ONLY: test tokens (tEQTY, mockUSDT), no real assets, no real money. The
 * RPC's genesis hash must be devnet's; any other cluster is refused.
 *
 * THIS IS NOT MARKET ACTIVITY. Both sides of every trade are wallets Niara owns. Any
 * chart, history, screenshot or video that shows these trades must say so
 * (README, "Demo activity").
 *
 *   node --env-file=.env scripts/demo-activity.ts [--engine-url https://api.niaraglobal.com]
 *        [--duration 30] [--max-trades 20] [--traders 4] [--sol 0.01] [--usdt 500] [--eqty 20] [--dry-run]
 *
 *   --duration     minutes, 1-240 (default 30)
 *   --max-trades   stop after this many matches, 1-200 (default 20)
 *   --traders      new demo traders on top of the two existing demo wallets, 0-4 (default 4)
 *   --sol/--usdt/--eqty  what each new trader is topped up TO (caps 0.05 / 2000 / 50)
 *   --dry-run      checks everything, simulates the transactions, sends and submits nothing
 *                  (and creates no key file)
 *
 * What it does:
 *   1. checks devnet, the service (approved tEQTY market, orders accepted, settlement
 *      ENABLED: every trade must be settled by the worker), and that the settlement
 *      operator holds enough SOL for the planned trades (about 0.00075 SOL each);
 *   2. wallets: the demo run's "equity-seller" and "equity-buyer", plus new demo traders
 *      (keys created in ~/.config/niara-exchange/devnet/demo-trader-N.json, mode 600,
 *      never printed), topped up from the demo funder (SOL) and the equity-seller
 *      (mockUSDT, tEQTY), to capped targets;
 *   3. every 20-60 s one order, alternating a maker (rests at the price of a bounded
 *      random walk: 25 mockUSDT +/-3%, 1-5 lots) and a taker (opposite side, another
 *      wallet, same price and size) that matches it. Each order: ONE devnet transaction
 *      approving EXACTLY what it needs to the program's vault (fees paid by the demo
 *      funder, simulated first), then a signed intent to the service. A wallet side is
 *      never used again until its order is cancelled or its match settled (one
 *      delegate per token account);
 *   4. each match is followed until the worker settles it; the transaction and its
 *      Explorer link go to the log. A failed settlement stops the run;
 *   5. Ctrl+C (or the end): signed cancels for this script's open orders, then exit.
 *      Delegations stay on the token accounts of these demo wallets (only the engine's
 *      cancel is signed; nothing is revoked on-chain).
 *
 * Log: ~/niara-logs/demo-activity-<time>.log
 */
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { randomBytes, randomInt } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { signAsync } from "@noble/ed25519";
import { base58 } from "@scure/base";
import { Keypair, PublicKey, TransactionMessage, VersionedTransaction, type TransactionInstruction } from "@solana/web3.js";
import { redactSecrets } from "../src/config.ts";
import { counterDelegation, counterIntent, DEPLOYED_ENGINE_URL, engineUrl, type CounterMarket } from "../src/devnet/counter-order.ts";
import {
  DemoError,
  centsToPrice,
  checkOperatorBalance,
  parseDemoOptions,
  plannedTrades,
  runDemo,
  type BookLevel,
  type DemoDeps,
  type DemoWallet,
  type Side,
} from "../src/devnet/demo-activity.ts";
import { checkFundingSources, planTopUp, traderFundingInstructions, traderKeyFile, type TraderTopUp } from "../src/devnet/demo-funding.ts";
import { CANCEL_VERSION, solanaCancelMessage, type CancelIntent } from "../src/intents/cancel.ts";
import { solanaIntentMessage } from "../src/intents/solana.ts";
import { associatedTokenAddress, decodeConfig, decodeMintDecimals, decodeTokenAccount, isTokenProgram, pdas } from "../src/solana/accounts.ts";
import { mapTransactionError } from "../src/solana/errors.ts";
import { PROGRAM_ID } from "../src/solana/idl.ts";
import { loadKeypairFile } from "../src/solana/keypair.ts";
import { DEFAULT_DEVNET_RPC, connectDevnet } from "../src/solana/rpc.ts";
import { approveChecked } from "../src/solana/token-instructions.ts";
import { formatUnits } from "../src/units.ts";

const ASSET_MINT = new PublicKey("8LjQkS1rTJGpzz9wbyAmqJk7oZgDsZS6vhPBv2BhzsTo"); // tEQTY (TEST)
const KEYS = join(homedir(), ".config", "niara-exchange", "devnet");
const RUN = join(KEYS, "demo-runs", "2026-11-14T10-31-02-302Z");
const ORDER_LIFETIME_SECS = 15 * 60;

const { values: args } = parseArgs({
  options: {
    "engine-url": { type: "string", default: DEPLOYED_ENGINE_URL },
    duration: { type: "string" },
    "max-trades": { type: "string" },
    traders: { type: "string" },
    sol: { type: "string" },
    usdt: { type: "string" },
    eqty: { type: "string" },
    "dry-run": { type: "boolean", default: false },
  },
});

const logDir = join(homedir(), "niara-logs");
mkdirSync(logDir, { recursive: true });
const logFile = join(logDir, `demo-activity-${new Date().toISOString().replace(/[:.]/g, "-")}.log`);
function say(line = ""): void {
  const safe = redactSecrets(line);
  console.log(safe);
  appendFileSync(logFile, `${safe}\n`);
}
const explorer = (kind: "tx" | "address", v: string) => `https://explorer.solana.com/${kind}/${v}?cluster=devnet`;
const dryRun = args["dry-run"] === true;
let ENGINE = "";

const sleepMs = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done);
  });

/** One request; a 429 waits its Retry-After (at most 65 s) and tries again, three times at most. */
async function http(method: "GET" | "POST", path: string, body?: unknown, signal?: AbortSignal): Promise<{ status: number; body: any }> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(new URL(path, ENGINE), {
      method,
      ...(body === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) }),
    });
    const parsed = { status: res.status, body: await res.json().catch(() => ({})) };
    if (res.status !== 429 || attempt >= 3) return parsed;
    const wait = Math.min(65, Math.max(1, Number(res.headers.get("retry-after")) || 30));
    say(`  rate limited by the engine: waiting ${wait} s`);
    await sleepMs(wait * 1000, signal);
  }
}

async function main(): Promise<void> {
  ENGINE = engineUrl(args["engine-url"]!);
  const opts = parseDemoOptions({
    ...(args.duration !== undefined && { duration: args.duration }),
    ...(args["max-trades"] !== undefined && { "max-trades": args["max-trades"] }),
    ...(args.traders !== undefined && { traders: args.traders }),
    ...(args.sol !== undefined && { sol: args.sol }),
    ...(args.usdt !== undefined && { usdt: args.usdt }),
    ...(args.eqty !== undefined && { eqty: args.eqty }),
  });
  const trades = plannedTrades(opts);

  say("Niara DEMO ACTIVITY, Solana DEVNET (TESTNET ONLY: test tokens, no real assets, no real money)");
  say("These trades are between wallets NIARA CONTROLS. They are demo activity, not market activity.");
  say(`log: ${logFile}`);
  say(`engine: ${ENGINE}${dryRun ? "  [DRY RUN: nothing is sent or submitted, no key file is created]" : ""}`);
  say(`plan: up to ${opts.maxTrades} trades in ${opts.durationMin} min (at most ${trades} fit), ${opts.traders} new trader(s)`);
  const rpc = await connectDevnet(process.env["SOLANA_RPC_URL"] || DEFAULT_DEVNET_RPC);
  say("cluster: devnet (genesis hash checked)");

  // ---- chain ---------------------------------------------------------------------
  const p = pdas();
  const [configAccount, assetMintAccount] = await rpc.getAccounts([p.config(), ASSET_MINT]);
  if (!configAccount || !assetMintAccount) throw new Error("program Config or tEQTY mint not found on devnet");
  const config = decodeConfig(configAccount.data);
  if (config.paused) throw new Error("the protocol is paused");
  const usdtMint = config.feeMint;
  const [usdtMintAccount] = await rpc.getAccounts([usdtMint]);
  if (!usdtMintAccount) throw new Error("mockUSDT mint not found");
  for (const m of [assetMintAccount, usdtMintAccount]) if (!isTokenProgram(m.owner)) throw new Error("a mint is not owned by an SPL token program");
  const assetDecimals = decodeMintDecimals(assetMintAccount.data);
  const usdtDecimals = decodeMintDecimals(usdtMintAccount.data);
  if (usdtDecimals < 2) throw new Error("mockUSDT has fewer than 2 decimals: prices in cents are not representable");
  const assetInfo = { mint: ASSET_MINT, tokenProgram: assetMintAccount.owner, decimals: assetDecimals };
  const usdtInfo = { mint: usdtMint, tokenProgram: usdtMintAccount.owner, decimals: usdtDecimals };

  // ---- the service ---------------------------------------------------------------
  const health = await http("GET", "/health").catch(() => null);
  if (!health || health.status !== 200 || health.body.status !== "ok") {
    throw new Error(`the order service is not serving at ${ENGINE} (${health ? JSON.stringify(health.body.status) : "unreachable"})`);
  }
  const bookReply = await http("GET", `/v1/books/solana-devnet/${ASSET_MINT.toBase58()}`);
  if (bookReply.status !== 200 || bookReply.body.status !== "approved") throw new Error(`tEQTY is not an approved market in the service: ${JSON.stringify(bookReply.body)}`);
  if (bookReply.body.quoteAsset !== usdtMint.toBase58()) throw new Error("the service's quote asset is not the on-chain fee mint");
  const lotSize = BigInt(bookReply.body.lotSize);
  if (lotSize !== 10n ** BigInt(assetDecimals)) throw new Error("this script trades markets whose lot is exactly one share");
  const minNotional = BigInt(bookReply.body.minOrderNotional);
  const lowestPrice = 24_25n * 10n ** BigInt(usdtDecimals - 2); // 24.25 mockUSDT per share, the walk's floor
  if (lowestPrice < minNotional) throw new Error(`one lot at the lowest walk price is below the market's minimum order notional (${minNotional})`);
  const markets = await http("GET", "/v1/markets");
  const chain = markets.body.chains?.find((c: { id: string }) => c.id === "solana-devnet");
  if (!chain?.ordersAccepted) throw new Error("the service does not accept orders on solana-devnet");
  if (!chain.settlementEnabled) throw new Error("the service's worker does not settle solana-devnet: every trade here must be settled by the worker, so this run would only leave pending matches");

  // ---- keys and wallets ----------------------------------------------------------
  const funder = loadKeypairFile(join(KEYS, "demo-funder.json"), "demo funder");
  const source = loadKeypairFile(join(RUN, "equity-seller.json"), "demo equity-seller wallet");
  const operator = loadKeypairFile(join(KEYS, "settlement-operator.json"), "settlement operator");
  const signers = new Map<string, Keypair>();
  const wallets: DemoWallet[] = [];
  const addWallet = (name: string, kp: Keypair) => {
    signers.set(kp.publicKey.toBase58(), kp);
    wallets.push({ name, address: kp.publicKey.toBase58() });
  };
  addWallet("equity-seller", source);
  addWallet("equity-buyer", loadKeypairFile(join(RUN, "equity-buyer.json"), "demo equity-buyer wallet"));
  const newTraders: { name: string; kp: Keypair; created: boolean }[] = [];
  for (let i = 1; i <= opts.traders; i++) {
    const path = join(KEYS, traderKeyFile(i));
    let kp: Keypair;
    let created = false;
    if (existsSync(path)) kp = loadKeypairFile(path, `demo trader ${i}`);
    else {
      kp = Keypair.generate();
      created = true;
      // A dry run keeps the new key in memory only. The file is created (mode 600) before anything is funded.
      if (!dryRun) writeFileSync(path, JSON.stringify([...kp.secretKey]), { mode: 0o600, flag: "wx" });
    }
    newTraders.push({ name: `trader-${i}`, kp, created });
    addWallet(`trader-${i}`, kp);
  }
  for (const w of wallets) say(`wallet ${w.name}: ${explorer("address", w.address)}`);
  say(`funder: ${funder.publicKey.toBase58()}  token source: equity-seller`);
  say(`settlement operator (settlement-operator.json): ${operator.publicKey.toBase58()}`);

  // ---- the operator can pay for the planned settlements ---------------------------
  const [operatorAccount] = await rpc.getAccounts([operator.publicKey]);
  const operatorLamports = BigInt(operatorAccount?.lamports ?? 0);
  const needed = checkOperatorBalance(operatorLamports, trades);
  say(`operator SOL: ${formatUnits(operatorLamports, 9)}; ${trades} planned settlements need about ${formatUnits(needed, 9)} (assumes the deployed worker uses this operator key)`);

  // ---- funding the new traders -----------------------------------------------------
  const tokenBalance = (a: { data: Uint8Array } | null) => (a ? decodeTokenAccount(a.data).amount : null);
  const ata = (mint: PublicKey, owner: PublicKey, program: PublicKey) => associatedTokenAddress(mint, owner, program);
  const plans: { trader: (typeof newTraders)[number]; topUp: TraderTopUp }[] = [];
  for (const t of newTraders) {
    const [acct, u, a] = await rpc.getAccounts([t.kp.publicKey, ata(usdtMint, t.kp.publicKey, usdtInfo.tokenProgram), ata(ASSET_MINT, t.kp.publicKey, assetInfo.tokenProgram)]);
    plans.push({ trader: t, topUp: planTopUp(opts.funding, { usdtDecimals, assetDecimals }, { lamports: BigInt(acct?.lamports ?? 0), usdt: tokenBalance(u ?? null), asset: tokenBalance(a ?? null) }) });
  }
  const [funderAccount, sourceUsdtAcct, sourceAssetAcct] = await rpc.getAccounts([funder.publicKey, ata(usdtMint, source.publicKey, usdtInfo.tokenProgram), ata(ASSET_MINT, source.publicKey, assetInfo.tokenProgram)]);
  checkFundingSources(plans.map((x) => x.topUp), trades, {
    funderLamports: BigInt(funderAccount?.lamports ?? 0),
    sourceUsdt: tokenBalance(sourceUsdtAcct ?? null),
    sourceAsset: tokenBalance(sourceAssetAcct ?? null),
  });

  const sendTx = async (label: string, instructions: TransactionInstruction[], signersFor: Keypair[]): Promise<string | null> => {
    const { blockhash, lastValidBlockHeight } = await rpc.getLatestBlockhash();
    const tx = new VersionedTransaction(new TransactionMessage({ payerKey: funder.publicKey, recentBlockhash: blockhash, instructions }).compileToV0Message());
    tx.sign([funder, ...signersFor]);
    const sim = await rpc.simulate(tx);
    if (sim.err) {
      const f = mapTransactionError(sim.err, sim.logs);
      throw new Error(`${label}: simulation refused (${f === "already_settled" ? JSON.stringify(sim.err) : f.message}); nothing sent`);
    }
    if (dryRun) return null;
    const sig = await rpc.send(tx);
    const conf = await rpc.confirm(sig, blockhash, lastValidBlockHeight);
    if (conf.err) throw new Error(`${label} failed: ${JSON.stringify(conf.err)}`);
    return sig;
  };

  for (const { trader, topUp } of plans) {
    const what = `${formatUnits(topUp.lamports, 9)} SOL, ${formatUnits(topUp.usdt, usdtDecimals)} mockUSDT, ${formatUnits(topUp.asset, assetDecimals)} tEQTY`;
    if (topUp.lamports === 0n && topUp.usdt === 0n && topUp.asset === 0n && topUp.newAccounts === 0) {
      say(`fund ${trader.name}: already holds the targets`);
      continue;
    }
    const ixs = traderFundingInstructions({ funder: funder.publicKey, source: source.publicKey, trader: trader.kp.publicKey, usdt: usdtInfo, asset: assetInfo, topUp });
    const sig = await sendTx(`funding ${trader.name}`, ixs, [source]);
    say(sig ? `fund ${trader.name}: ${what}: ${explorer("tx", sig)}` : `fund ${trader.name}: ${what}: simulation ok (dry run)`);
  }

  // ---- the walk's machinery: intents, delegations, balances ------------------------
  const market: CounterMarket = {
    program: PROGRAM_ID.toBase58(),
    asset: ASSET_MINT.toBase58(),
    assetDecimals,
    lotSize,
    usdt: usdtMint.toBase58(),
    usdtDecimals,
  };
  const intentFor = (w: DemoWallet, side: Side, lots: number, cents: number, nonce: string) =>
    counterIntent(market, {
      wallet: w.address,
      side,
      quantity: String(lots),
      price: centsToPrice(cents),
      expiresAt: Math.floor(Date.now() / 1000) + ORDER_LIFETIME_SECS,
      nonce,
    });
  const signerOf = (w: DemoWallet) => signers.get(w.address)!;
  const approveInstruction = (w: DemoWallet, side: Side, lots: number, cents: number) => {
    const need = counterDelegation(intentFor(w, side, lots, cents, randomBytes(16).toString("hex")));
    const mint = need.mint === ASSET_MINT.toBase58() ? assetInfo : usdtInfo;
    return approveChecked({
      tokenProgram: mint.tokenProgram,
      source: ata(mint.mint, signerOf(w).publicKey, mint.tokenProgram),
      mint: mint.mint,
      delegate: p.vaultAuthority(),
      owner: signerOf(w).publicKey,
      amount: need.amount,
      decimals: mint.decimals,
    });
  };

  const canAfford: DemoDeps["canAfford"] = async (w, side, lots, cents) => {
    const need = counterDelegation(intentFor(w, side, lots, cents, randomBytes(16).toString("hex")));
    const mint = need.mint === ASSET_MINT.toBase58() ? assetInfo : usdtInfo;
    const [acct] = await rpc.getAccounts([ata(mint.mint, signerOf(w).publicKey, mint.tokenProgram)]);
    return !!acct && decodeTokenAccount(acct.data).amount >= need.amount;
  };

  // ---- dry run: everything is checked, nothing is sent ------------------------------
  if (dryRun) {
    for (const w of wallets) {
      const fresh = newTraders.find((t) => t.name === w.name && t.created);
      if (fresh) {
        say(`check ${w.name}: new wallet, approvals are simulated once it is funded`);
        continue;
      }
      for (const side of ["sell", "buy"] as const) {
        const ok = await canAfford(w, side, 1, 2500);
        if (!ok) {
          say(`check ${w.name}: cannot cover a 1-lot ${side} (it will not be used for ${side}s)`);
          continue;
        }
        await sendTx(`approve ${w.name} ${side}`, [approveInstruction(w, side, 1, 2500)], [signerOf(w)]);
        say(`check ${w.name}: 1-lot ${side} approve simulation ok`);
      }
    }
    say("\nDry run: all checks done. Nothing was sent or submitted, no key file was created.");
    return;
  }

  const priceBase = (cents: number) => BigInt(cents) * 10n ** BigInt(usdtDecimals - 2);
  const levels = (raw: { price: string; quantity: string; orders: number }[]): BookLevel[] => raw.map((l) => ({ price: BigInt(l.price), quantity: BigInt(l.quantity), orders: l.orders }));

  const ctl = new AbortController();
  process.on("SIGINT", () => {
    if (ctl.signal.aborted) {
      say("\nsecond Ctrl+C: exiting at once (open orders may remain; they expire on their own)");
      process.exit(130);
    }
    say("\nCtrl+C: cancelling this script's open orders, then exiting");
    ctl.abort();
  });

  const deps: DemoDeps = {
    now: Date.now,
    rng: () => randomInt(0, 2 ** 30) / 2 ** 30,
    sleep: sleepMs,
    log: say,
    explorerTx: (sig) => explorer("tx", sig),
    wallets,
    canAfford,
    book: async () => {
      const b = await http("GET", `/v1/books/solana-devnet/${ASSET_MINT.toBase58()}`, undefined, ctl.signal);
      if (b.status !== 200) throw new Error(`could not read the book: ${JSON.stringify(b.body)}`);
      return { bids: levels(b.body.bids), asks: levels(b.body.asks) };
    },
    priceOf: priceBase,
    quantityOf: (lots) => BigInt(lots) * lotSize,
    approve: async (w, side, lots, cents) => {
      await sendTx(`approve ${w.name} ${side}`, [approveInstruction(w, side, lots, cents)], [signerOf(w)]);
    },
    place: async (w, side, lots, cents) => {
      const intent = intentFor(w, side, lots, cents, randomBytes(16).toString("hex"));
      const signature = base58.encode(await signAsync(solanaIntentMessage(intent), signerOf(w).secretKey.subarray(0, 32)));
      const reply = await http("POST", "/v1/orders", { intent, signature }, ctl.signal);
      if (reply.status !== 201) throw new Error(`order refused (${reply.status}): ${JSON.stringify(reply.body)}`);
      return { id: reply.body.order.id, nonce: intent.nonce, status: reply.body.order.status, matches: reply.body.matches };
    },
    orderStatus: async (id) => {
      const r = await http("GET", `/v1/orders/${id}`, undefined, ctl.signal);
      if (r.status !== 200) throw new Error(`could not read order ${id}: ${JSON.stringify(r.body)}`);
      return r.body.order.status;
    },
    cancel: async (o) => {
      const cancel: CancelIntent = { version: CANCEL_VERSION, chain: "solana-devnet", settlement: PROGRAM_ID.toBase58(), wallet: o.wallet.address, nonce: o.nonce };
      const signature = base58.encode(await signAsync(solanaCancelMessage(cancel), signerOf(o.wallet).secretKey.subarray(0, 32)));
      // The abort signal is not passed: a cancel after Ctrl+C must still go out.
      const r = await http("POST", "/v1/orders/cancel", { cancel, signature });
      if (r.status === 200) return "cancelled";
      if (r.status === 409) return "gone";
      throw new Error(`cancel refused (${r.status}): ${JSON.stringify(r.body)}`);
    },
    matchStatus: async (id) => {
      const r = await http("GET", `/v1/matches/${id}`, undefined, ctl.signal);
      if (r.status !== 200) throw new Error(`could not read match ${id}: ${JSON.stringify(r.body)}`);
      return { status: r.body.status, txHash: r.body.settlement?.txHash ?? null, error: r.body.settlement?.error ?? null };
    },
  };

  say(`\nstart: ${new Date().toISOString()}; Ctrl+C stops it and cancels the open orders\n`);
  const summary = await runDemo(deps, opts, ctl.signal);
  say(
    `\nend: ${summary.matched} matched, ${summary.settled} settled, ${summary.unsettled} not yet settled, ${summary.cancelled} order(s) cancelled` +
      `${summary.aborted ? " (stopped by Ctrl+C)" : ""}${summary.error ? `; stopped on an error: ${summary.error}` : ""}`,
  );
  if (summary.error) process.exit(1);
}

main().catch((e: unknown) => {
  say(`\nERROR: ${e instanceof DemoError || e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
