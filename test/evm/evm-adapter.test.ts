import { beforeEach, describe, expect, it } from "vitest";
import { getAddress, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { EvmSettlementAdapter, decodeSettled, matchIdBytes16 } from "../../src/adapters/evm-adapter.ts";
import { SettlementFailure } from "../../src/adapters/failure.ts";
import type { Match } from "../../src/engine/types.ts";
import { WrongChainError, connectEvm, type EvmClient } from "../../src/evm/client.ts";
import { evmCoverageChecker } from "../../src/evm/coverage.ts";
import type { DeployedEvmChain, EvmChainId, GasRules } from "../../src/evm/settings.ts";
import { MockEvmChain, T } from "./mock-chain.ts";

/**
 * The EVM settlement adapter against a mocked JSON-RPC node (test/evm/mock-chain.ts):
 * real viem encoding, signing and decoding; keys generated per run; patterned addresses.
 * TESTNET ONLY: nothing here touches a network.
 */

const SHARE = 10n ** 18n;
const USDT = 1_000_000n;
const CHAIN_IDS: Record<EvmChainId, number> = { "base-sepolia": 84532, "robinhood-testnet": 46630, "tempo-testnet": 42431, "hyperevm-testnet": 998 };
const GAS: Record<EvmChainId, GasRules> = {
  "base-sepolia": { pricing: "eip1559", multiplierPct: 130, maxGasPerTx: null, feeToken: null },
  "robinhood-testnet": { pricing: "eip1559", multiplierPct: 200, maxGasPerTx: null, feeToken: null },
  "tempo-testnet": { pricing: "tempo", multiplierPct: 200, maxGasPerTx: 30_000_000n, feeToken: getAddress(T.pathUsd) },
  "hyperevm-testnet": { pricing: "legacy", multiplierPct: 130, maxGasPerTx: 3_000_000n, feeToken: null },
};

let operator: PrivateKeyAccount;
let mock: MockEvmChain;
let client: EvmClient;
let n = 0;

function settings(chain: EvmChainId, over: Partial<DeployedEvmChain> = {}): DeployedEvmChain {
  return {
    chain,
    evmChainId: CHAIN_IDS[chain],
    deployed: true,
    reviewed: true,
    contracts: { listingRegistry: getAddress(T.registry), settlement: getAddress(T.settlement), cashbackDistributor: getAddress(T.distributor) },
    quoteAsset: getAddress(T.usdt),
    operator: operator.address,
    fromBlock: 1n,
    gas: GAS[chain],
    explorer: null,
    lotSizes: {},
    ...over,
  };
}

function match(chain: EvmChainId, over: Partial<Match> = {}): Match {
  n += 1;
  return {
    id: `6f1c1d4e-2a3b-4c5d-8e6f-${n.toString(16).padStart(12, "0")}`,
    sequence: n,
    chain,
    asset: getAddress(T.equity),
    paymentAsset: getAddress(T.usdt),
    buyOrderId: "b",
    sellOrderId: "s",
    buyer: getAddress(T.buyer),
    seller: getAddress(T.seller),
    makerOrderId: "s",
    takerSide: "buy",
    quantity: 10n * SHARE,
    lotSize: SHARE,
    price: 25n * USDT,
    paymentAmount: 250n * USDT,
    expiresAt: 1_900_000_000,
    ...over,
  };
}

async function setup(chain: EvmChainId = "base-sepolia"): Promise<void> {
  mock = new MockEvmChain(CHAIN_IDS[chain]);
  mock.operators.add(operator.address.toLowerCase());
  mock.nativeBalances.set(operator.address.toLowerCase(), 10n ** 18n);
  mock.fund(T.pathUsd, operator.address, 1_000n * USDT);
  mock.fund(T.equity, T.seller, 100n * SHARE);
  mock.fund(T.usdt, T.buyer, 1_000n * USDT);
  // Enough for several matches; tests that need a short allowance set it themselves.
  mock.approve(T.equity, T.seller, T.settlement, 50n * SHARE);
  mock.approve(T.usdt, T.buyer, T.settlement, 1_000n * USDT);
  client = await connectEvm(chain, mock.transport());
}

function adapter(chain: EvmChainId = "base-sepolia", over: Partial<DeployedEvmChain> = {}) {
  return EvmSettlementAdapter.create({ client, settings: settings(chain, over), operator, receiptTimeoutMs: 60, receiptPollMs: 5, logChunk: 1_000n });
}

async function failure(p: Promise<unknown>): Promise<SettlementFailure> {
  const e = await p.then(() => null, (x: unknown) => x);
  expect(e).toBeInstanceOf(SettlementFailure);
  return e as SettlementFailure;
}

beforeEach(async () => {
  operator = privateKeyToAccount(generatePrivateKey());
  await setup();
});

describe("connecting and creating", () => {
  it("refuses an RPC that answers another chain id", async () => {
    await expect(connectEvm("tempo-testnet", new MockEvmChain(1).transport())).rejects.toThrow(WrongChainError);
  });

  it("checks the key is the configured operator and holds SETTLEMENT_OPERATOR_ROLE", async () => {
    const other = privateKeyToAccount(generatePrivateKey()).address;
    expect((await failure(adapter("base-sepolia", { operator: other }))).message).toMatch(/not the configured operator/);
    mock.operators.clear();
    expect((await failure(adapter())).message).toMatch(/does not hold SETTLEMENT_OPERATOR_ROLE/);
  });

  it("checks NiaraSettlement's fee token, registry and distributor against the config", async () => {
    mock.feeToken = getAddress(T.brl);
    expect((await failure(adapter())).message).toMatch(/feeToken/);
    mock.feeToken = getAddress(T.usdt);
    mock.listingRegistryLink = getAddress(T.distributor);
    expect((await failure(adapter())).message).toMatch(/listingRegistry/);
  });

  it("reports a listing tradable only when Approved Equity", async () => {
    const a = await adapter();
    expect(await a.isListed(T.equity)).toBe(true);
    expect(await a.isListed(T.bond)).toBe(false);
    expect(await a.isListed(T.usdt)).toBe(false);
    mock.setListing(T.equity, { assetClass: 0, status: 3 });
    expect(await a.isListed(T.equity)).toBe(false);
  });
});

describe("settle on Base Sepolia (EIP-1559)", () => {
  it("simulates, sends one type-2 transaction with gas = estimate x 1.30, and moves both legs and the fee", async () => {
    const a = await adapter();
    const m = match("base-sepolia");
    const out = await a.settle(m);
    expect(out.alreadySettled).toBe(false);
    // Simulated before the send.
    const order = mock.calls.filter((c) => c.fn === "settle" || c.method === "eth_sendRawTransaction").map((c) => c.fn ?? c.method);
    expect(order).toEqual(["settle", "eth_sendRawTransaction"]);
    const [tx] = mock.sent();
    expect(tx).toMatchObject({ hash: out.txHash, from: operator.address, type: "eip1559", gas: (204_428n * 130n + 99n) / 100n, status: "success" });
    // fee = ceil(250 x 50 / 10,000) = 1.25 mockUSDT
    expect(mock.balanceOf(T.equity, T.buyer)).toBe(10n * SHARE);
    expect(mock.balanceOf(T.usdt, T.seller)).toBe(248_750_000n);
    expect(mock.balanceOf(T.usdt, T.distributor)).toBe(1_250_000n);
    const event = decodeSettled(mock.logs.at(-1)! as never);
    expect(event).toMatchObject({ matchId: matchIdBytes16(m.id), buyer: getAddress(T.buyer), seller: getAddress(T.seller), feeCharged: 1_250_000n });
  });

  it("uses the match UUID's 16 bytes as matchId", () => {
    expect(matchIdBytes16("6f1c1d4e-2a3b-4c5d-8e6f-7a8b9c0d1e2f")).toBe("0x6f1c1d4e2a3b4c5d8e6f7a8b9c0d1e2f");
    expect(() => matchIdBytes16("not-a-uuid")).toThrow(SettlementFailure);
  });

  it("checks the replay record first: an already settled match sends nothing and returns the transaction that settled it", async () => {
    const a = await adapter();
    const m = match("base-sepolia");
    const first = await a.settle(m);
    mock.maxLogRange = 400n; // the Settled event is found through refused and halved log ranges
    expect(await a.findSettlement(m)).toBe(first.txHash);
    const again = await a.settle(m);
    expect(again).toEqual({ txHash: first.txHash, alreadySettled: true });
    expect(mock.count("eth_sendRawTransaction")).toBe(1);
    expect(await a.findSettlement(match("base-sepolia"))).toBeNull();
  });

  it("never sends a settlement whose simulation reverts, and names the token's error", async () => {
    const a = await adapter();
    mock.approve(T.usdt, T.buyer, T.settlement, 100n * USDT);
    const f = await failure(a.settle(match("base-sepolia")));
    expect([f.kind, f.errorName, f.transient]).toEqual(["program", "ERC20InsufficientAllowance", false]);
    mock.approve(T.usdt, T.buyer, T.settlement, 250n * USDT);
    mock.fund(T.equity, T.seller, 1n);
    expect((await failure(a.settle(match("base-sepolia")))).errorName).toBe("ERC20InsufficientBalance");
    expect(mock.count("eth_sendRawTransaction")).toBe(0);
  });

  it("treats a paused protocol and RPC trouble as transient, the operator's missing gas as operator_funds", async () => {
    const a = await adapter();
    mock.paused = true;
    expect((await failure(a.settle(match("base-sepolia")))).kind).toBe("transient");
    mock.paused = false;
    mock.failNext.set("eth_estimateGas", { code: 429, message: "429 Too Many Requests" });
    expect((await failure(a.settle(match("base-sepolia")))).kind).toBe("transient");
    mock.nativeBalances.set(operator.address.toLowerCase(), 1n);
    expect((await failure(a.settle(match("base-sepolia")))).kind).toBe("operator_funds");
    expect(mock.count("eth_sendRawTransaction")).toBe(0);
  });

  it("refuses a payment asset that is not the fee token, and a match of another chain", async () => {
    const a = await adapter();
    expect((await failure(a.settle(match("base-sepolia", { paymentAsset: getAddress(T.brl) })))).kind).toBe("precondition");
    expect((await failure(a.settle(match("tempo-testnet")))).kind).toBe("precondition");
  });

  it("does not send twice while its transaction is pending, and reports it once mined", async () => {
    const a = await adapter();
    const m = match("base-sepolia");
    mock.holdReceipts = true;
    expect((await failure(a.settle(m))).kind).toBe("transient"); // receipt timeout
    expect((await failure(a.settle(m))).message).toMatch(/still pending/);
    expect(mock.count("eth_sendRawTransaction")).toBe(1);
    mock.release();
    const out = await a.settle(m);
    expect(out).toEqual({ txHash: mock.sent()[0]!.hash, alreadySettled: false });
    expect(mock.count("eth_sendRawTransaction")).toBe(1);
  });
});

describe("per-chain gas rules", () => {
  it("Robinhood: gas = estimate x 2", async () => {
    await setup("robinhood-testnet");
    await (await adapter("robinhood-testnet")).settle(match("robinhood-testnet"));
    expect(mock.sent()[0]).toMatchObject({ type: "eip1559", gas: 408_856n });
  });

  it("Tempo: a 0x76 transaction paying the fee in pathUSD; the operator's pathUSD must cover gas x max fee (attodollars)", async () => {
    await setup("tempo-testnet");
    mock.nativeBalances.clear(); // Tempo has no native gas token
    await (await adapter("tempo-testnet")).settle(match("tempo-testnet"));
    expect(mock.sent()[0]).toMatchObject({ type: "tempo", feeToken: getAddress(T.pathUsd), gas: 408_856n, status: "success" });

    mock.fund(T.pathUsd, operator.address, 0n);
    const f = await failure((await adapter("tempo-testnet")).settle(match("tempo-testnet")));
    expect([f.kind, f.message]).toEqual(["operator_funds", expect.stringMatching(/fee token/)]);
    expect(mock.count("eth_sendRawTransaction")).toBe(1);
  });

  it("legacy pricing (HyperEVM): a type-0 transaction with gasPrice, refused above the small-block cap", async () => {
    await setup("hyperevm-testnet");
    await (await adapter("hyperevm-testnet")).settle(match("hyperevm-testnet"));
    expect(mock.sent()[0]).toMatchObject({ type: "legacy", gasPrice: mock.gasPrice });
    mock.estimate = 2_400_000n; // x 1.30 = 3.12M > 3M
    const f = await failure((await adapter("hyperevm-testnet")).settle(match("hyperevm-testnet")));
    expect([f.kind, f.message]).toEqual(["precondition", expect.stringMatching(/per-transaction cap 3000000/)]);
  });
});

describe("allowance check (spec §3.5 on EVM)", () => {
  it("names what does not cover a need: allowance, balance, or an unknown token", async () => {
    const check = evmCoverageChecker(client, getAddress(T.settlement));
    const need = (mint: Address, wallet: Address, amount: bigint) => ({ mint, wallet, amount });
    expect(
      await check.check([
        need(T.equity, T.seller, 10n * SHARE),
        need(T.usdt, T.buyer, 250n * USDT),
        need(T.equity, T.seller, 50n * SHARE),
        need(T.usdt, T.issuer, 0n),
        need("0x0000000000000000000000000000000000000bad", T.buyer, 1n),
      ]),
    ).toEqual([
      null,
      null,
      null,
      null,
      expect.stringMatching(/^token 0x0+bad not found$/i),
    ]);
    expect(await check.check([need(T.equity, T.seller, 51n * SHARE)])).toEqual([`allowance ${50n * SHARE} < needed ${51n * SHARE}`]);
    mock.approve(T.usdt, T.buyer, T.settlement, 10n ** 30n);
    mock.fund(T.usdt, T.buyer, 5n);
    expect(await check.check([need(T.usdt, T.buyer, 250n * USDT)])).toEqual([`balance 5 < needed ${250n * USDT}`]);
  });
});
