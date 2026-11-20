/**
 * End-to-end on Base Sepolia. TESTNET ONLY: test tokens (tEQTY, mockUSDT), no real
 * assets, no real money. The node's chain id must be 84532: nothing here can reach a
 * mainnet or another chain.
 *
 *   node --env-file=.env scripts/e2e-evm.ts [--quantity 10] [--price 25] [--dry-run]
 *
 * Prerequisites: config/evm-testnets.json marks base-sepolia reviewed; the listing sync
 * was applied for it (tEQTY is an approved market); the order service runs with its
 * worker and EVM_SETTLEMENT_CHAINS=base-sepolia (`npm start`).
 *
 * Wallets: the demo investors of niara-contracts' Base Sepolia demo (2026-11-16), from
 * their Foundry keystores next to the operator's (EVM_OPERATOR_KEYSTORE's directory),
 * passwords EVM_INVESTOR_B_KEYSTORE_PASSWORD (seller: investor B received the tEQTY
 * issuance) and EVM_INVESTOR_A_KEYSTORE_PASSWORD (buyer: investor A holds mockUSDT).
 * Keys are decrypted into memory and never printed.
 *
 * What it does:
 *   1. checks the chain, the contracts, the service, the market and every balance (both
 *      legs and each wallet's gas); logs the balances before. --dry-run stops here;
 *   2. TWO Base Sepolia transactions, each simulated first: the seller approves exactly
 *      `quantity` tEQTY and the buyer exactly `quantity x price` mockUSDT to
 *      NiaraSettlement (settle moves both legs with transferFrom);
 *   3. signs a sell and a buy order intent (EIP-712) and submits both to the service,
 *      which matches them;
 *   4. waits for the worker to settle the match, then shows the transaction on
 *      BaseScan, the Settled event (fee) and the distributor's FeeRecorded event
 *      (cashback), and the balances after, with checks.
 *
 * Log: ~/niara-logs/e2e-evm-<time>.log.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import {
  createWalletClient,
  decodeEventLog,
  formatUnits,
  getAddress,
  isAddressEqual,
  type Address,
  type Hex,
  type PrivateKeyAccount,
} from "viem";
import { decodeSettled, matchIdBytes16 } from "../src/adapters/evm-adapter.ts";
import { redactSecrets } from "../src/config.ts";
import { CASHBACK_DISTRIBUTOR_ABI } from "../src/evm/abi/CashbackDistributor.ts";
import { NATIVE_ASSET_TOKEN_ABI } from "../src/evm/abi/NativeAssetToken.ts";
import { NIARA_SETTLEMENT_ABI } from "../src/evm/abi/NiaraSettlement.ts";
import { VIEM_CHAINS, connectEvm, httpTransport, rpcUrlFor, type EvmClient } from "../src/evm/client.ts";
import { loadKeystoreFile } from "../src/evm/keystore.ts";
import { deployedChain, explorerTx, loadEvmSettings } from "../src/evm/settings.ts";
import { evmIntentTypedData } from "../src/intents/evm.ts";
import type { OrderIntent } from "../src/intents/types.ts";

const CHAIN = "base-sepolia" as const;
const EQUITY = getAddress("0x0f1c771c8943cD7EC2b4c654CEea49B41336bDD7"); // Niara Demo Equity (TEST), tEQTY
/** The demo wallets (niara-contracts broadcast/Demo.s.sol/84532/run-latest.json). */
const INVESTOR_A = getAddress("0x20fFBc64D8b8941003e0B10e07a4e0BfAcEcAE85"); // buyer here
const INVESTOR_B = getAddress("0xEda1A2ED4B76c8F0EE471B4DB750CAdBf6Fd9E06"); // seller here
/** Gas budget of one approve on Base Sepolia (the demo's approvals used ~46k). */
const APPROVE_GAS = 60_000n;

const { values: args } = parseArgs({
  options: {
    quantity: { type: "string", default: "10" },
    price: { type: "string", default: "25" },
    "dry-run": { type: "boolean", default: false },
    service: { type: "string", default: process.env["E2E_SERVICE_URL"] ?? "http://127.0.0.1:8787" },
  },
});

const logDir = join(homedir(), "niara-logs");
mkdirSync(logDir, { recursive: true });
const logFile = join(logDir, `e2e-evm-${new Date().toISOString().replace(/[:.]/g, "-")}.log`);
function say(line = ""): void {
  const safe = redactSecrets(line);
  console.log(safe);
  appendFileSync(logFile, `${safe}\n`);
}

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

async function main(): Promise<void> {
  const quantityShares = BigInt(args.quantity);
  const priceWhole = BigInt(args.price);
  if (quantityShares <= 0n || priceWhole <= 0n) throw new Error("--quantity and --price must be positive integers");

  say("Niara Exchange end-to-end, Base Sepolia (TESTNET ONLY: test tokens, no real assets, no real money)");
  say(`log: ${logFile}`);
  const s = deployedChain(loadEvmSettings(), CHAIN, { requireReviewed: true });
  const client: EvmClient = await connectEvm(CHAIN, httpTransport(rpcUrlFor(CHAIN)));
  say(`chain: ${CHAIN} (chain id ${s.evmChainId} checked)`);
  const tx = (h: string) => explorerTx(s, h) ?? h;

  // ---- 1. checks --------------------------------------------------------------
  const settlement = s.contracts.settlement;
  const read = <T>(address: Address, abi: readonly unknown[], functionName: string, a: readonly unknown[] = []) =>
    client.readContract({ address, abi: abi as never, functionName: functionName as never, args: a as never }) as Promise<T>;
  const [feeToken, paused, feeBps, cashbackBps] = await Promise.all([
    read<Address>(settlement, NIARA_SETTLEMENT_ABI, "feeToken"),
    read<boolean>(settlement, NIARA_SETTLEMENT_ABI, "paused"),
    read<number>(settlement, NIARA_SETTLEMENT_ABI, "feeBps"),
    read<number>(s.contracts.cashbackDistributor, CASHBACK_DISTRIBUTOR_ABI, "cashbackBps"),
  ]);
  if (!isAddressEqual(feeToken, s.quoteAsset)) throw new Error(`NiaraSettlement.feeToken ${feeToken} is not the configured mockUSDT`);
  if (paused) throw new Error("the protocol is paused");
  const usdt = s.quoteAsset;
  const [assetDecimals, usdtDecimals] = await Promise.all([
    read<number>(EQUITY, NATIVE_ASSET_TOKEN_ABI, "decimals"),
    read<number>(usdt, NATIVE_ASSET_TOKEN_ABI, "decimals"),
  ]);

  const keystores = process.env["EVM_OPERATOR_KEYSTORE"];
  if (!keystores) throw new Error("EVM_OPERATOR_KEYSTORE is not set (the investors' keystores are in its directory)");
  const dir = dirname(keystores);
  const seller = loadKeystoreFile(join(dir, "niara-evm-investor-b"), process.env["EVM_INVESTOR_B_KEYSTORE_PASSWORD"], "demo investor B (seller)");
  const buyer = loadKeystoreFile(join(dir, "niara-evm-investor-a"), process.env["EVM_INVESTOR_A_KEYSTORE_PASSWORD"], "demo investor A (buyer)");
  if (!isAddressEqual(seller.address, INVESTOR_B) || !isAddressEqual(buyer.address, INVESTOR_A)) {
    throw new Error(`the keystores are not the Base Sepolia demo investors (got ${seller.address}, ${buyer.address})`);
  }

  const lot = 10n ** BigInt(assetDecimals); // one share per lot (config lot size)
  if (s.lotSizes[EQUITY]?.lotSize !== lot) throw new Error("the reviewed lot size of tEQTY is not one share");
  const quantity = quantityShares * lot;
  const price = priceWhole * 10n ** BigInt(usdtDecimals); // mockUSDT base units per share
  const payment = quantityShares * price;
  const fee = (payment * BigInt(feeBps) + 9_999n) / 10_000n;
  const cashback = (fee * BigInt(cashbackBps)) / 10_000n;
  const usd = (v: bigint) => formatUnits(v, usdtDecimals);
  const shares = (v: bigint) => formatUnits(v, assetDecimals);
  say(`seller (demo investor B): ${seller.address}`);
  say(`buyer  (demo investor A): ${buyer.address}`);
  say(`trade: ${quantityShares} tEQTY at ${priceWhole} mockUSDT = ${usd(payment)} mockUSDT`);
  say(`expected: fee ${usd(fee)} (${feeBps} bps, rounded up), cashback ${usd(cashback)} (${cashbackBps} bps of the fee), seller receives ${usd(payment - fee)}`);

  const health = await http("GET", "/health").catch(() => null);
  if (!health || health.status !== 200) throw new Error(`the order service is not reachable at ${args.service}: start it with npm start`);
  const book = await http("GET", `/v1/books/${CHAIN}/${EQUITY}`);
  if (book.status !== 200 || book.body.status !== "approved" || book.body.lotSize !== lot.toString()) {
    throw new Error(`tEQTY is not an approved market with lot size ${lot} in the service (${JSON.stringify(book.body)}): apply the listing sync`);
  }
  if (!isAddressEqual(book.body.quoteAsset, usdt)) throw new Error("the service's quote asset is not NiaraSettlement.feeToken");

  const balances = async () => {
    const [sa, su, ba, bu, d] = await Promise.all([
      read<bigint>(EQUITY, NATIVE_ASSET_TOKEN_ABI, "balanceOf", [seller.address]),
      read<bigint>(usdt, NATIVE_ASSET_TOKEN_ABI, "balanceOf", [seller.address]),
      read<bigint>(EQUITY, NATIVE_ASSET_TOKEN_ABI, "balanceOf", [buyer.address]),
      read<bigint>(usdt, NATIVE_ASSET_TOKEN_ABI, "balanceOf", [buyer.address]),
      read<bigint>(usdt, NATIVE_ASSET_TOKEN_ABI, "balanceOf", [s.contracts.cashbackDistributor]),
    ]);
    return { sellerAsset: sa, sellerUsdt: su, buyerAsset: ba, buyerUsdt: bu, distributor: d };
  };
  const show = (title: string, b: Awaited<ReturnType<typeof balances>>) => {
    say(title);
    say(`  seller  tEQTY ${shares(b.sellerAsset)}  mockUSDT ${usd(b.sellerUsdt)}`);
    say(`  buyer   tEQTY ${shares(b.buyerAsset)}  mockUSDT ${usd(b.buyerUsdt)}`);
    say(`  CashbackDistributor mockUSDT ${usd(b.distributor)}`);
  };
  const before = await balances();
  show("\nbalances before:", before);
  if (before.sellerAsset < quantity) throw new Error("the seller holds less tEQTY than the trade");
  if (before.buyerUsdt < payment) throw new Error("the buyer holds less mockUSDT than the payment");
  const fees = await client.estimateFeesPerGas();
  for (const [who, w] of [["seller", seller], ["buyer", buyer]] as const) {
    const eth = await client.getBalance({ address: w.address });
    const needed = APPROVE_GAS * fees.maxFeePerGas;
    say(`  ${who} gas: ${formatUnits(eth, 18)} test ETH (one approve needs up to ${formatUnits(needed, 18)})`);
    if (eth < needed) throw new Error(`the ${who} cannot pay the gas of its approval`);
  }
  if (args["dry-run"]) {
    say("\nDry run: every check passed; nothing sent.");
    return;
  }

  // ---- 2. allowances (two Base Sepolia transactions) ---------------------------
  say("\n[1] allowances to NiaraSettlement (exact amounts; each simulated first)");
  const approve = async (owner: PrivateKeyAccount, token: Address, amount: bigint, label: string): Promise<Hex> => {
    const wallet = createWalletClient({ account: owner, chain: VIEM_CHAINS[CHAIN], transport: httpTransport(rpcUrlFor(CHAIN)) });
    const { request } = await client.simulateContract({
      account: owner,
      address: token,
      abi: NATIVE_ASSET_TOKEN_ABI,
      functionName: "approve",
      args: [settlement, amount],
    });
    const hash = await wallet.writeContract({ ...request, gas: APPROVE_GAS });
    const receipt = await client.waitForTransactionReceipt({ hash, timeout: 120_000 });
    if (receipt.status !== "success") throw new Error(`${label}: transaction reverted (${tx(hash)})`);
    say(`  ${label}\n    ${tx(hash)}`);
    return hash;
  };
  await approve(seller, EQUITY, quantity, `seller approves ${quantityShares} tEQTY`);
  await approve(buyer, usdt, payment, `buyer approves ${usd(payment)} mockUSDT`);

  // ---- 3. signed intents to the service ----------------------------------------
  say("\n[2] signed order intents (EIP-712) submitted to the order service");
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  const intent = (wallet: Address, side: "buy" | "sell"): OrderIntent => ({
    version: 1,
    chain: CHAIN,
    settlement,
    wallet,
    side,
    asset: EQUITY,
    quantity,
    lotSize: lot,
    limitPrice: price,
    paymentAsset: usdt,
    nonce: randomBytes(16).toString("hex"),
    expiresAt,
  });
  const sell = intent(seller.address, "sell");
  const sellReply = await http("POST", "/v1/orders", { intent: sell, signature: await seller.signTypedData(evmIntentTypedData(sell)) });
  if (sellReply.status !== 201) throw new Error(`sell order refused: ${JSON.stringify(sellReply.body)}`);
  say(`  sell order ${sellReply.body.order.id}: ${sellReply.body.order.status}`);
  const buy = intent(buyer.address, "buy");
  const buyReply = await http("POST", "/v1/orders", { intent: buy, signature: await buyer.signTypedData(evmIntentTypedData(buy)) });
  if (buyReply.status !== 201) throw new Error(`buy order refused: ${JSON.stringify(buyReply.body)}`);
  say(`  buy order  ${buyReply.body.order.id}: ${buyReply.body.order.status}`);
  const match = buyReply.body.matches[0];
  if (!match) throw new Error("the orders did not match");
  say(`  match ${match.id}: ${shares(BigInt(match.quantity))} tEQTY at ${usd(BigInt(match.price))} mockUSDT, payment ${usd(BigInt(match.paymentAmount))}`);

  // ---- 4. settlement by the worker ---------------------------------------------
  say("\n[3] waiting for the settlement worker (up to 3 minutes)");
  let status: any = null;
  for (let i = 0; i < 90; i++) {
    status = (await http("GET", `/v1/matches/${match.id}`)).body;
    if (status.status === "settled" || status.status === "failed") break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (status?.status !== "settled") throw new Error(`match not settled: ${JSON.stringify(status)}`);
  const hash = status.settlement.txHash as Hex;
  say(`  settled after ${status.settlement.attempts} attempt(s)`);
  say(`  transaction: ${tx(hash)}`);

  const receipt = await client.getTransactionReceipt({ hash });
  const settledLog = receipt.logs.find((l) => isAddressEqual(l.address, settlement) && decodeSettled(l));
  const event = settledLog ? decodeSettled(settledLog) : null;
  if (!event) throw new Error("no Settled event in the settle transaction");
  const recorded = receipt.logs
    .filter((l) => isAddressEqual(l.address, s.contracts.cashbackDistributor))
    .map(feeRecorded)
    .find((r) => r !== null);
  if (!recorded) throw new Error("no FeeRecorded event from the CashbackDistributor");
  say("\nSettled event (NiaraSettlement):");
  say(`  matchId       ${event.matchId} (= ${match.id})`);
  say(`  assetAmount   ${shares(event.assetAmount)} tEQTY`);
  say(`  paymentAmount ${usd(event.paymentAmount)} mockUSDT`);
  say(`  feeCharged    ${usd(event.feeCharged)} mockUSDT`);
  say(`  buyer ${event.buyer}  seller ${event.seller}`);
  say("FeeRecorded event (CashbackDistributor):");
  say(`  fee ${usd(recorded.feeAmount)}  cashback ${usd(recorded.cashbackAmount)} (to the tEQTY issuer)  eligible ${recorded.eligible}`);

  const after = await balances();
  show("\nbalances after:", after);
  const checks: [string, bigint | string, bigint | string][] = [
    ["event matchId = match UUID", event.matchId.toLowerCase(), matchIdBytes16(match.id)],
    ["event fee", event.feeCharged, fee],
    ["recorded cashback", recorded.cashbackAmount, cashback],
    ["seller tEQTY delta", before.sellerAsset - after.sellerAsset, quantity],
    ["buyer tEQTY delta", after.buyerAsset - before.buyerAsset, quantity],
    ["buyer mockUSDT paid", before.buyerUsdt - after.buyerUsdt, payment],
    ["seller mockUSDT received", after.sellerUsdt - before.sellerUsdt, payment - fee],
    ["CashbackDistributor delta", after.distributor - before.distributor, fee],
  ];
  say("\nchecks:");
  let ok = true;
  for (const [what, actual, expected] of checks) {
    const pass = actual === expected;
    ok &&= pass;
    say(`  ${pass ? "ok  " : "FAIL"} ${what}: ${actual}${pass ? "" : ` (expected ${expected})`}`);
  }
  if (!ok) throw new Error("some checks failed (re-read the balances in a few seconds if only balances differ)");
  say("\nEnd-to-end complete on Base Sepolia: every check passed.");
}

/** The CashbackDistributor's FeeRecorded event in a log, if it is one. */
function feeRecorded(l: { data: Hex; topics: readonly Hex[] }): { feeAmount: bigint; cashbackAmount: bigint; eligible: boolean } | null {
  try {
    const d = decodeEventLog({ abi: CASHBACK_DISTRIBUTOR_ABI, data: l.data, topics: l.topics as never });
    return d.eventName === "FeeRecorded" ? (d.args as unknown as { feeAmount: bigint; cashbackAmount: bigint; eligible: boolean }) : null;
  } catch {
    return null; // another distributor event
  }
}

main().catch((e: unknown) => {
  say(`\nERROR: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
