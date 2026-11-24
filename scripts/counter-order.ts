/**
 * Places ONE resting order on Solana DEVNET from a demo investor wallet, so a browser
 * tester can trade against it from the site. TESTNET ONLY: test tokens (tEQTY,
 * mockUSDT), no real assets, no real money. The RPC's genesis hash must be devnet's.
 *
 *   node --env-file=.env scripts/counter-order.ts --side sell|buy --price 25 --quantity 5
 *        [--wallet equity-seller|equity-buyer] [--expires-hours 24] [--dry-run]
 *        [--engine-url http://127.0.0.1:8787]
 *
 * --engine-url: the order service to trade against (default: the local one). https
 * anywhere; plain http only for localhost. For the deployed service:
 *
 *   node --env-file=.env scripts/counter-order.ts --engine-url https://api.niaraglobal.com \
 *        --side sell --price 25 --quantity 5
 *
 * Prerequisites: the order service is running (`npm start`) with tEQTY as an approved
 * market on solana-devnet.
 *
 * What it does:
 *   1. checks devnet, the service, the market, the wallet's balance, and that the wallet
 *      has no other live order resting on the same token account (`approve` replaces a
 *      token account's delegation; an exact approval would shrink the other order's);
 *   2. ONE devnet transaction (fees paid by the demo funder, simulated first): the
 *      wallet approves EXACTLY what the order needs to the program's vault PDA (sell:
 *      the tEQTY quantity; buy: quantity x price in mockUSDT). --dry-run stops after
 *      the simulation, sending and submitting nothing;
 *   3. signs the order intent (Solana signMessage text, ed25519) and submits it; it
 *      rests in the book unless it crosses a resting order.
 *
 * Wallets: the demo run of 2026-11-14 (~/.config/niara-exchange/devnet/demo-runs/...),
 * "equity-seller" by default (it holds both tEQTY and mockUSDT). Keys are read into
 * memory and never printed. The order expires on its own (`--expires-hours`); until
 * then it can be cancelled only with that wallet's signed cancellation.
 *
 * Log: ~/niara-logs/counter-order-<time>.log.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { signAsync } from "@noble/ed25519";
import { base58 } from "@scure/base";
import { PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { redactSecrets } from "../src/config.ts";
import { DEPLOYED_ENGINE_URL, counterDelegation, counterIntent, engineUrl, ordersSharingDelegation, type CounterMarket } from "../src/devnet/counter-order.ts";
import { solanaIntentMessage } from "../src/intents/solana.ts";
import type { OrderIntent } from "../src/intents/types.ts";
import { associatedTokenAddress, decodeConfig, decodeMintDecimals, decodeTokenAccount, pdas } from "../src/solana/accounts.ts";
import { mapTransactionError } from "../src/solana/errors.ts";
import { PROGRAM_ID } from "../src/solana/idl.ts";
import { loadKeypairFile } from "../src/solana/keypair.ts";
import { DEFAULT_DEVNET_RPC, connectDevnet } from "../src/solana/rpc.ts";
import { approveChecked } from "../src/solana/token-instructions.ts";
import { formatUnits } from "../src/units.ts";

const ASSET_MINT = new PublicKey("8LjQkS1rTJGpzz9wbyAmqJk7oZgDsZS6vhPBv2BhzsTo"); // tEQTY (TEST)
const KEYS = join(homedir(), ".config", "niara-exchange", "devnet");
const RUN = join(KEYS, "demo-runs", "2026-11-14T10-31-02-302Z");
const WALLETS = { "equity-seller": "equity-seller.json", "equity-buyer": "equity-buyer.json" } as const;

const { values: args } = parseArgs({
  options: {
    side: { type: "string" },
    price: { type: "string" },
    quantity: { type: "string" },
    wallet: { type: "string", default: "equity-seller" },
    "expires-hours": { type: "string", default: "24" },
    "engine-url": { type: "string", default: "http://127.0.0.1:8787" },
    "dry-run": { type: "boolean", default: false },
  },
});

let ENGINE = ""; // set (and validated) first thing in main()

const logDir = join(homedir(), "niara-logs");
mkdirSync(logDir, { recursive: true });
const logFile = join(logDir, `counter-order-${new Date().toISOString().replace(/[:.]/g, "-")}.log`);
function say(line = ""): void {
  const safe = redactSecrets(line);
  console.log(safe);
  appendFileSync(logFile, `${safe}\n`);
}
const explorerTx = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;

async function http(method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const init: RequestInit =
    body === undefined
      ? { method }
      : {
          method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
        };
  const res = await fetch(new URL(path, ENGINE), init);
  return { status: res.status, body: await res.json() };
}

async function main(): Promise<void> {
  ENGINE = engineUrl(args["engine-url"]);
  const side = args.side;
  if (side !== "buy" && side !== "sell") throw new Error("--side must be buy or sell");
  if (!args.price || !args.quantity) throw new Error("--price (mockUSDT per share) and --quantity (shares) are required");
  if (!(args.wallet in WALLETS)) throw new Error(`--wallet must be one of ${Object.keys(WALLETS).join(", ")}`);
  const hours = Number(args["expires-hours"]);
  if (!Number.isInteger(hours) || hours < 1 || hours > 720) throw new Error("--expires-hours must be a whole number from 1 to 720");

  say("Niara counter order, Solana DEVNET (TESTNET ONLY: test tokens, no real assets, no real money)");
  say(`log: ${logFile}`);
  say(`engine: ${ENGINE}`);
  say(`deployed service: node --env-file=.env scripts/counter-order.ts --engine-url ${DEPLOYED_ENGINE_URL} --side ${side ?? "sell"} --price ${args.price ?? "25"} --quantity ${args.quantity ?? "5"}`);
  const rpc = await connectDevnet(process.env["SOLANA_RPC_URL"] || DEFAULT_DEVNET_RPC);
  say("cluster: devnet (genesis hash checked)");

  // ---- checks -------------------------------------------------------------------
  const p = pdas();
  const [configAccount, assetMintAccount] = await rpc.getAccounts([p.config(), ASSET_MINT]);
  if (!configAccount || !assetMintAccount) throw new Error("program Config or tEQTY mint not found on devnet");
  const config = decodeConfig(configAccount.data);
  if (config.paused) throw new Error("the protocol is paused");
  const [usdtMintAccount] = await rpc.getAccounts([config.feeMint]);
  if (!usdtMintAccount) throw new Error("mockUSDT mint not found");

  const health = await http("GET", "/health").catch(() => null);
  if (!health || health.status !== 200) throw new Error(`the order service is not reachable at ${ENGINE}: start it with npm start (local) or check the deployment`);
  const book = await http("GET", `/v1/books/solana-devnet/${ASSET_MINT.toBase58()}`);
  if (book.status !== 200 || book.body.status !== "approved") throw new Error(`tEQTY is not an approved market in the service: ${JSON.stringify(book.body)}`);
  if (book.body.quoteAsset !== config.feeMint.toBase58()) throw new Error("the service's quote asset is not the on-chain fee mint");
  const markets = await http("GET", "/v1/markets");
  const chain = markets.body.chains?.find((c: { id: string }) => c.id === "solana-devnet");
  if (!chain?.ordersAccepted) throw new Error("the service does not accept orders on solana-devnet");
  if (!chain.settlementEnabled) say("WARNING: the service's worker does not settle solana-devnet: matches will stay pending");

  const market: CounterMarket = {
    program: PROGRAM_ID.toBase58(),
    asset: ASSET_MINT.toBase58(),
    assetDecimals: decodeMintDecimals(assetMintAccount.data),
    lotSize: BigInt(book.body.lotSize),
    usdt: config.feeMint.toBase58(),
    usdtDecimals: decodeMintDecimals(usdtMintAccount.data),
  };
  const owner = loadKeypairFile(join(RUN, WALLETS[args.wallet as keyof typeof WALLETS]), `demo ${args.wallet} wallet`);
  const funder = loadKeypairFile(join(KEYS, "demo-funder.json"), "demo funder");
  const intent: OrderIntent = counterIntent(market, {
    wallet: owner.publicKey.toBase58(),
    side,
    quantity: args.quantity,
    price: args.price,
    expiresAt: Math.floor(Date.now() / 1000) + hours * 3600,
    nonce: randomBytes(16).toString("hex"),
  });
  const need = counterDelegation(intent);
  const needMint = new PublicKey(need.mint);
  const mintAccount = needMint.equals(ASSET_MINT) ? assetMintAccount : usdtMintAccount;
  const needDecimals = needMint.equals(ASSET_MINT) ? market.assetDecimals : market.usdtDecimals;
  const symbol = needMint.equals(ASSET_MINT) ? "tEQTY" : "mockUSDT";
  const tokenAccount = associatedTokenAddress(needMint, owner.publicKey, mintAccount.owner);

  say(`wallet:  ${owner.publicKey.toBase58()} (demo "${args.wallet}" wallet)`);
  say(`order:   ${side} ${formatUnits(intent.quantity, market.assetDecimals)} tEQTY at ${args.price} mockUSDT per share (limit ${intent.limitPrice} base units per lot), expires ${new Date(intent.expiresAt * 1000).toISOString()}`);
  say(`delegation: exactly ${formatUnits(need.amount, needDecimals)} ${symbol} to the vault PDA ${p.vaultAuthority().toBase58()}`);

  const others = await http("GET", `/v1/orders?chain=solana-devnet&wallet=${owner.publicKey.toBase58()}&limit=100`);
  if (others.status !== 200) throw new Error(`could not list the wallet's orders: ${JSON.stringify(others.body)}`);
  const sharing = ordersSharingDelegation(others.body.orders, intent);
  if (sharing.length > 0) {
    throw new Error(
      `the wallet has ${sharing.length} other live ${side} order(s) on the same token account (${sharing.join(", ")}): ` +
        "approve would replace their delegation. Let them expire or cancel them, or use the other demo wallet (--wallet).",
    );
  }

  const [tokenData] = await rpc.getAccounts([tokenAccount]);
  if (!tokenData) throw new Error(`the wallet has no ${symbol} token account`);
  const held = decodeTokenAccount(tokenData.data);
  say(`balance: ${formatUnits(held.amount, needDecimals)} ${symbol}; current delegation ${formatUnits(held.delegatedAmount, needDecimals)} (replaced by this one)`);
  if (held.amount < need.amount) throw new Error(`the wallet holds less ${symbol} than the order needs`);

  // ---- exact delegation (one devnet transaction) --------------------------------
  const { blockhash, lastValidBlockHeight } = await rpc.getLatestBlockhash();
  const tx = new VersionedTransaction(
    new TransactionMessage({
      payerKey: funder.publicKey,
      recentBlockhash: blockhash,
      instructions: [
        approveChecked({
          tokenProgram: mintAccount.owner,
          source: tokenAccount,
          mint: needMint,
          delegate: p.vaultAuthority(),
          owner: owner.publicKey,
          amount: need.amount,
          decimals: needDecimals,
        }),
      ],
    }).compileToV0Message(),
  );
  tx.sign([funder, owner]);
  const sim = await rpc.simulate(tx);
  if (sim.err) {
    const f = mapTransactionError(sim.err, sim.logs);
    throw new Error(`approve: simulation refused (${f === "already_settled" ? JSON.stringify(sim.err) : f.message}); nothing sent`);
  }
  say("\napprove simulation: ok");
  if (args["dry-run"]) {
    say("Dry run: nothing sent, no order submitted.");
    return;
  }
  const sig = await rpc.send(tx);
  const conf = await rpc.confirm(sig, blockhash, lastValidBlockHeight);
  if (conf.err) throw new Error(`approve failed: ${JSON.stringify(conf.err)}`);
  say(`approved: ${explorerTx(sig)}`);

  // ---- signed intent to the service ---------------------------------------------
  const signature = base58.encode(await signAsync(solanaIntentMessage(intent), owner.secretKey.subarray(0, 32)));
  const reply = await http("POST", "/v1/orders", { intent, signature });
  if (reply.status !== 201) throw new Error(`order refused (${reply.status}): ${JSON.stringify(reply.body)} (the delegation stays; a later order replaces it)`);
  const order = reply.body.order;
  say(`\norder ${order.id}: ${order.status}, nonce ${intent.nonce}`);
  for (const m of reply.body.matches) say(`  matched at once: match ${m.id}, ${m.quantity} at ${m.price} (it crossed a resting order)`);
  const after = await http("GET", `/v1/books/solana-devnet/${ASSET_MINT.toBase58()}`);
  say(`book: bids ${JSON.stringify(after.body.bids)} asks ${JSON.stringify(after.body.asks)}`);
  say(`status: ${ENGINE}/v1/orders/${order.id}`);
}

main().catch((e: unknown) => {
  say(`\nERROR: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
