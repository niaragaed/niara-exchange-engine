/**
 * End-to-end on Solana DEVNET. TESTNET ONLY: test tokens (tEQTY, mockUSDT), no real
 * assets, no real money. Nothing here can touch mainnet: the RPC's genesis hash must be
 * devnet's.
 *
 *   node --env-file=.env scripts/e2e-devnet.ts [--quantity 10] [--price 25]
 *
 * Prerequisites: the listing sync was applied (tEQTY is an approved market), and the
 * order service is running with its settlement worker (`npm start`).
 *
 * What it does, with the demo investor wallets of the 2026-11-14 demo run (keys stay in
 * ~/.config/niara-exchange/devnet/, are read into memory and never printed):
 *   1. checks devnet, the service, the market and the balances; logs balances before;
 *   2. ONE devnet transaction (paid by the demo funder, co-signed by both investors,
 *      simulated first): the seller approves exactly `quantity` tEQTY and the buyer
 *      exactly `quantity x price` mockUSDT to the program's vault PDA. Both approvals
 *      are needed: `settle` moves both legs through the vault (spec §3.5);
 *   3. signs a sell and a buy order intent (Solana signMessage text, ed25519) and
 *      submits both to the service, which matches them;
 *   4. waits for the worker to settle the match, then shows the transaction on Solana
 *      Explorer (cluster=devnet), the Settled event (fee, cashback) and the balances.
 *
 * Roles: the "equity-buyer" wallet of the demo run holds the tEQTY and sells here; the
 * "equity-seller" wallet holds the mockUSDT and buys (it received USDT in that demo).
 *
 * Log: ~/niara-logs/e2e-devnet-<time>.log.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { signAsync } from "@noble/ed25519";
import { base58 } from "@scure/base";
import {
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type Keypair,
} from "@solana/web3.js";
import { redactSecrets } from "../src/config.ts";
import { solanaIntentMessage } from "../src/intents/solana.ts";
import type { OrderIntent } from "../src/intents/types.ts";
import {
  associatedTokenAddress,
  decodeConfig,
  decodeMintDecimals,
  decodeTokenAccount,
  pdas,
} from "../src/solana/accounts.ts";
import { mapTransactionError } from "../src/solana/errors.ts";
import { fetchSettledEvent } from "../src/solana/events.ts";
import { PROGRAM_ID } from "../src/solana/idl.ts";
import { loadKeypairFile } from "../src/solana/keypair.ts";
import { DEFAULT_DEVNET_RPC, connectDevnet, type SolanaRpc } from "../src/solana/rpc.ts";

const ASSET_MINT = new PublicKey("8LjQkS1rTJGpzz9wbyAmqJk7oZgDsZS6vhPBv2BhzsTo"); // tEQTY (TEST)
const KEYS = join(homedir(), ".config", "niara-exchange", "devnet");
const RUN = join(KEYS, "demo-runs", "2026-11-14T10-31-02-302Z");

const { values: args } = parseArgs({
  options: {
    quantity: { type: "string", default: "10" },
    price: { type: "string", default: "25" },
    service: { type: "string", default: process.env["E2E_SERVICE_URL"] ?? "http://127.0.0.1:8787" },
  },
});

const logDir = join(homedir(), "niara-logs");
mkdirSync(logDir, { recursive: true });
const logFile = join(logDir, `e2e-devnet-${new Date().toISOString().replace(/[:.]/g, "-")}.log`);
function say(line = ""): void {
  const safe = redactSecrets(line);
  console.log(safe);
  appendFileSync(logFile, `${safe}\n`);
}

const explorerTx = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
const units = (raw: bigint, decimals: number) => {
  if (decimals === 0) return raw.toString();
  const s = raw.toString().padStart(decimals + 1, "0");
  return `${s.slice(0, -decimals)}.${s.slice(-decimals)}`;
};

async function http(method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const init: RequestInit =
    body === undefined
      ? { method }
      : {
          method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
        };
  const res = await fetch(new URL(path, args.service), init);
  return { status: res.status, body: await res.json() };
}

/** approve_checked (SPL Token / Token-2022 instruction 13): delegate `amount` to `delegate`. */
function approveChecked(tokenProgram: PublicKey, source: PublicKey, mint: PublicKey, delegate: PublicKey, owner: PublicKey, amount: bigint, decimals: number) {
  const data = new Uint8Array(10);
  data[0] = 13;
  new DataView(data.buffer).setBigUint64(1, amount, true);
  data[9] = decimals;
  return new TransactionInstruction({
    programId: tokenProgram,
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: delegate, isSigner: false, isWritable: false },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data: Buffer.from(data),
  });
}

async function sendSimulated(rpc: SolanaRpc, label: string, ixs: TransactionInstruction[], payer: Keypair, signers: Keypair[]): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await rpc.getLatestBlockhash();
  const tx = new VersionedTransaction(
    new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message(),
  );
  tx.sign([payer, ...signers]);
  const sim = await rpc.simulate(tx);
  if (sim.err) {
    const f = mapTransactionError(sim.err, sim.logs);
    throw new Error(`${label}: simulation refused (${f === "already_settled" ? "already settled" : f.message}); nothing sent`);
  }
  const sig = await rpc.send(tx);
  const conf = await rpc.confirm(sig, blockhash, lastValidBlockHeight);
  if (conf.err) throw new Error(`${label}: transaction failed: ${JSON.stringify(conf.err)}`);
  say(`  ${label}\n    ${explorerTx(sig)}`);
  return sig;
}

async function signIntent(owner: Keypair, intent: OrderIntent): Promise<string> {
  // Keypair.secretKey = 32-byte seed || 32-byte public key; ed25519 signs with the seed.
  return base58.encode(await signAsync(solanaIntentMessage(intent), owner.secretKey.subarray(0, 32)));
}

async function main(): Promise<void> {
  const quantity = BigInt(args.quantity);
  const priceWhole = BigInt(args.price);
  if (quantity <= 0n || priceWhole <= 0n) throw new Error("--quantity and --price must be positive integers");

  say("Niara Exchange end-to-end, Solana DEVNET (TESTNET ONLY: test tokens, no real assets, no real money)");
  say(`log: ${logFile}`);
  const rpc = await connectDevnet(process.env["SOLANA_RPC_URL"] || DEFAULT_DEVNET_RPC);
  say("cluster: devnet (genesis hash checked)");

  // ---- 1. checks --------------------------------------------------------------
  const p = pdas();
  const [configAccount, assetMintAccount] = await rpc.getAccounts([p.config(), ASSET_MINT]);
  if (!configAccount || !assetMintAccount) throw new Error("program Config or tEQTY mint not found on devnet");
  const config = decodeConfig(configAccount.data);
  if (config.paused) throw new Error("the protocol is paused");
  const usdtMint = config.feeMint;
  const [usdtMintAccount] = await rpc.getAccounts([usdtMint]);
  if (!usdtMintAccount) throw new Error("mock USDT mint not found");
  const assetDecimals = decodeMintDecimals(assetMintAccount.data);
  const usdtDecimals = decodeMintDecimals(usdtMintAccount.data);
  const assetProgram = assetMintAccount.owner;
  const usdtProgram = usdtMintAccount.owner;

  const seller = loadKeypairFile(join(RUN, "equity-buyer.json"), "demo seller");
  const buyer = loadKeypairFile(join(RUN, "equity-seller.json"), "demo buyer");
  const funder = loadKeypairFile(join(KEYS, "demo-funder.json"), "demo funder");
  const price = priceWhole * 10n ** BigInt(usdtDecimals); // mockUSDT base units per lot (lot = 1 share)
  const payment = quantity * price;
  const fee = (payment * BigInt(config.feeBps) + 9_999n) / 10_000n;
  const cashback = (fee * BigInt(config.cashbackBps)) / 10_000n;
  say(`seller (demo "equity-buyer" wallet): ${seller.publicKey.toBase58()}`);
  say(`buyer  (demo "equity-seller" wallet): ${buyer.publicKey.toBase58()}`);
  say(`trade: ${quantity} tEQTY at ${priceWhole} mockUSDT = ${units(payment, usdtDecimals)} mockUSDT`);
  say(`expected: fee ${units(fee, usdtDecimals)} (${config.feeBps} bps, rounded up), cashback ${units(cashback, usdtDecimals)} (${config.cashbackBps} bps of the fee)`);

  const health = await http("GET", "/health").catch(() => null);
  if (!health || health.status !== 200) throw new Error(`the order service is not reachable at ${args.service}: start it with npm start`);
  const book = await http("GET", `/v1/books/solana-devnet/${ASSET_MINT.toBase58()}`);
  if (book.status !== 200 || book.body.status !== "approved" || book.body.lotSize !== "1") {
    throw new Error(`tEQTY is not an approved market with lot size 1 in the service (${JSON.stringify(book.body)}): apply the listing sync`);
  }
  if (book.body.quoteAsset !== usdtMint.toBase58()) throw new Error("the service's quote asset is not the on-chain fee mint");

  const accounts = {
    sellerAsset: associatedTokenAddress(ASSET_MINT, seller.publicKey, assetProgram),
    sellerUsdt: associatedTokenAddress(usdtMint, seller.publicKey, usdtProgram),
    buyerAsset: associatedTokenAddress(ASSET_MINT, buyer.publicKey, assetProgram),
    buyerUsdt: associatedTokenAddress(usdtMint, buyer.publicKey, usdtProgram),
    feeVault: p.feeVault(usdtMint),
  };
  const balances = async () => {
    const keys = Object.values(accounts);
    const data = await rpc.getAccounts(keys);
    return Object.fromEntries(
      Object.keys(accounts).map((name, i) => [name, data[i] ? decodeTokenAccount(data[i]!.data).amount : null]),
    ) as Record<keyof typeof accounts, bigint | null>;
  };
  const show = (title: string, b: Record<keyof typeof accounts, bigint | null>) => {
    say(title);
    const fmt = (v: bigint | null, d: number) => (v === null ? "(no account)" : units(v, d));
    say(`  seller  tEQTY ${fmt(b.sellerAsset, assetDecimals)}  mockUSDT ${fmt(b.sellerUsdt, usdtDecimals)}`);
    say(`  buyer   tEQTY ${fmt(b.buyerAsset, assetDecimals)}  mockUSDT ${fmt(b.buyerUsdt, usdtDecimals)}`);
    say(`  fee vault mockUSDT ${fmt(b.feeVault, usdtDecimals)}`);
  };
  const before = await balances();
  show("\nbalances before:", before);
  for (const [name, v] of Object.entries(before)) if (v === null) throw new Error(`token account missing: ${name}`);
  if (before.sellerAsset! < quantity) throw new Error("the seller holds less tEQTY than the trade");
  if (before.buyerUsdt! < payment) throw new Error("the buyer holds less mockUSDT than the payment");

  // ---- 2. delegations (one devnet transaction) ---------------------------------
  say("\n[1] delegations to the program's vault PDA (exact amounts; simulated first)");
  const vault = p.vaultAuthority();
  await sendSimulated(
    rpc,
    `seller approves ${quantity} tEQTY, buyer approves ${units(payment, usdtDecimals)} mockUSDT (fees paid by the demo funder)`,
    [
      approveChecked(assetProgram, accounts.sellerAsset, ASSET_MINT, vault, seller.publicKey, quantity, assetDecimals),
      approveChecked(usdtProgram, accounts.buyerUsdt, usdtMint, vault, buyer.publicKey, payment, usdtDecimals),
    ],
    funder,
    [seller, buyer],
  );

  // ---- 3. signed intents to the service ----------------------------------------
  say("\n[2] signed order intents submitted to the order service");
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  const intent = (wallet: Keypair, side: "buy" | "sell"): OrderIntent => ({
    version: 1,
    chain: "solana-devnet",
    settlement: PROGRAM_ID.toBase58(),
    wallet: wallet.publicKey.toBase58(),
    side,
    asset: ASSET_MINT.toBase58(),
    quantity,
    lotSize: 1n,
    limitPrice: price,
    paymentAsset: usdtMint.toBase58(),
    nonce: randomBytes(16).toString("hex"),
    expiresAt,
  });
  const sell = intent(seller, "sell");
  const sellReply = await http("POST", "/v1/orders", { intent: sell, signature: await signIntent(seller, sell) });
  if (sellReply.status !== 201) throw new Error(`sell order refused: ${JSON.stringify(sellReply.body)}`);
  say(`  sell order ${sellReply.body.order.id}: ${sellReply.body.order.status}`);
  const buy = intent(buyer, "buy");
  const buyReply = await http("POST", "/v1/orders", { intent: buy, signature: await signIntent(buyer, buy) });
  if (buyReply.status !== 201) throw new Error(`buy order refused: ${JSON.stringify(buyReply.body)}`);
  say(`  buy order  ${buyReply.body.order.id}: ${buyReply.body.order.status}`);
  const match = buyReply.body.matches[0];
  if (!match) throw new Error("the orders did not match");
  say(`  match ${match.id}: ${match.quantity} tEQTY at ${units(BigInt(match.price), usdtDecimals)} mockUSDT, payment ${units(BigInt(match.paymentAmount), usdtDecimals)}`);

  // ---- 4. settlement by the worker ---------------------------------------------
  say("\n[3] waiting for the settlement worker (up to 3 minutes)");
  let status: any = null;
  for (let i = 0; i < 90; i++) {
    status = (await http("GET", `/v1/matches/${match.id}`)).body;
    if (status.status === "settled" || status.status === "failed") break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (status?.status !== "settled") throw new Error(`match not settled: ${JSON.stringify(status)}`);
  const sig: string = status.settlement.txHash;
  say(`  settled after ${status.settlement.attempts} attempt(s)`);
  say(`  transaction: ${explorerTx(sig)}`);

  const event = await fetchSettledEvent(rpc, sig);
  if (!event) throw new Error("no Settled event in the settle transaction");
  say("\nSettled event (from the transaction's inner instructions):");
  say(`  match_id       ${Buffer.from(event.matchId).toString("hex")} (= ${match.id.replaceAll("-", "")})`);
  say(`  asset_amount   ${event.assetAmount} tEQTY`);
  say(`  payment_amount ${units(event.paymentAmount, usdtDecimals)} mockUSDT`);
  say(`  fee            ${units(event.fee, usdtDecimals)} mockUSDT`);
  say(`  cashback       ${units(event.cashback, usdtDecimals)} mockUSDT (to the tEQTY issuer)`);
  say(`  buyer ${event.buyer.toBase58()}  seller ${event.seller.toBase58()}`);

  const after = await balances();
  show("\nbalances after:", after);
  const checks: [string, bigint, bigint][] = [
    ["event match_id = match UUID", BigInt(`0x${Buffer.from(event.matchId).toString("hex")}`), BigInt(`0x${match.id.replaceAll("-", "")}`)],
    ["event fee", event.fee, fee],
    ["event cashback", event.cashback, cashback],
    ["seller tEQTY delta", before.sellerAsset! - after.sellerAsset!, quantity],
    ["buyer tEQTY delta", after.buyerAsset! - before.buyerAsset!, quantity],
    ["buyer mockUSDT paid", before.buyerUsdt! - after.buyerUsdt!, payment],
    ["seller mockUSDT received", after.sellerUsdt! - before.sellerUsdt!, payment - fee],
    ["fee vault delta", after.feeVault! - before.feeVault!, fee],
  ];
  say("\nchecks:");
  let ok = true;
  for (const [what, actual, expected] of checks) {
    const pass = actual === expected;
    ok &&= pass;
    say(`  ${pass ? "ok  " : "FAIL"} ${what}: ${actual}${pass ? "" : ` (expected ${expected})`}`);
  }
  // Balances read right after confirmation can lag on a load-balanced public RPC.
  if (!ok) throw new Error("some checks failed (re-read the balances in a few seconds if only balances differ)");
  say("\nEnd-to-end complete on devnet: every check passed.");
}

main().catch((e: unknown) => {
  say(`\nERROR: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
