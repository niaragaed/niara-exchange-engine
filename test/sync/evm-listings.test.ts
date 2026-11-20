import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getAddress, type Address } from "viem";
import { connectEvm, type EvmClient } from "../../src/evm/client.ts";
import type { DeployedEvmChain } from "../../src/evm/settings.ts";
import { applyEvmListingSync, planEvmListingSync } from "../../src/sync/evm-listings.ts";
import { LotSizeChangeError } from "../../src/sync/solana-listings.ts";
import { resetData, startPglite, type TestDb } from "../db/pglite.ts";
import { MockEvmChain, T } from "../evm/mock-chain.ts";

/**
 * EVM listing sync: ListingRegistry events on a mocked JSON-RPC node (test/evm/mock-chain.ts),
 * the database on PGlite with the real migrations. Patterned test addresses, not
 * deployments. TESTNET ONLY.
 */

const SHARE = 10n ** 18n;
const OPERATOR = getAddress("0x0000000000000000000000000000000000000001");

let t: TestDb;
let mock: MockEvmChain;
let client: EvmClient;

function settings(over: Partial<DeployedEvmChain> = {}): DeployedEvmChain {
  return {
    chain: "base-sepolia",
    evmChainId: 84532,
    deployed: true,
    reviewed: true,
    contracts: { listingRegistry: getAddress(T.registry), settlement: getAddress(T.settlement), cashbackDistributor: getAddress(T.distributor) },
    quoteAsset: getAddress(T.usdt),
    operator: OPERATOR,
    fromBlock: 1n,
    gas: { pricing: "eip1559", multiplierPct: 130, maxGasPerTx: null, feeToken: null },
    explorer: null,
    lotSizes: {
      [getAddress(T.equity)]: { symbol: "tEQTY", lotSize: SHARE },
      [getAddress(T.usdt)]: { symbol: "mockUSDT", lotSize: 1n },
      [getAddress(T.bond)]: { symbol: "tBOND", lotSize: SHARE },
    } as Record<Address, { symbol: string; lotSize: bigint }>,
    ...over,
  };
}

beforeAll(async () => {
  t = await startPglite();
});

afterAll(async () => {
  await t.pglite.close();
});

beforeEach(async () => {
  await resetData(t.pglite);
  mock = new MockEvmChain(84532); // lists mockUSDT, mockBRL, tEQTY and tBOND, all Approved
  client = await connectEvm("base-sepolia", mock.transport());
});

describe("plan (read-only on-chain)", () => {
  it("finds tokens from the registry's events, reads their current listing, and needs a reviewed lot size", async () => {
    const pending = getAddress("0x7e57000000000000000000000000000000000e02");
    mock.addToken(pending, 18);
    mock.setListing(pending, { assetClass: 0, status: 1, issuer: T.issuer });
    mock.setListing(T.bond, { assetClass: 1, status: 4, issuer: T.issuer }); // delisted since
    const plan = await planEvmListingSync(client, settings());
    expect(plan).toMatchObject({ chain: "base-sepolia", settlementProgram: getAddress(T.settlement), quoteAsset: getAddress(T.usdt), fromBlock: 1n });
    expect(plan.upserts.map((u) => [u.symbol, u.assetClass, u.assetDecimals, u.lotSize])).toEqual([
      ["mockUSDT", "currency", 6, 1n],
      ["tEQTY", "equity", 18, SHARE],
    ]);
    const equity = plan.upserts.find((u) => u.symbol === "tEQTY")!;
    expect(equity).toMatchObject({ issuer: getAddress(T.issuer), cashbackEligible: true, docHash: "ab".repeat(32), status: "approved" });
    expect(equity.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    const usdt = plan.upserts.find((u) => u.symbol === "mockUSDT")!;
    expect(usdt).toMatchObject({ issuer: null, cashbackEligible: false, docHash: null });
    expect(plan.statusOnly).toEqual([
      { asset: getAddress(T.bond), status: "delisted" },
      { asset: pending, status: "pending" },
    ]);
    expect(plan.skipped).toEqual([{ asset: getAddress(T.brl), reason: "no reviewed lot size in the config file" }]);
  });

  it("scans in chunks, halving a range the RPC refuses", async () => {
    mock.maxLogRange = 300n;
    const plan = await planEvmListingSync(client, settings(), { logChunk: 10_000n });
    expect(plan.upserts).toHaveLength(3); // mockUSDT, tEQTY, tBOND
    expect(mock.count("eth_getLogs")).toBeGreaterThan(5);
  });

  it("refuses a config whose quote asset or registry is not NiaraSettlement's", async () => {
    await expect(planEvmListingSync(client, settings({ quoteAsset: getAddress(T.brl) }))).rejects.toThrow(/not NiaraSettlement.feeToken/);
    await expect(
      planEvmListingSync(client, settings({ contracts: { ...settings().contracts, listingRegistry: getAddress(T.distributor) } })),
    ).rejects.toThrow(/not NiaraSettlement.listingRegistry/);
  });
});

describe("apply (PGlite, real migrations)", () => {
  async function listings() {
    const r = await t.pglite.query<{ asset: string; asset_class: string; status: string; lot_size: string; tx_hash: string | null; issuer: string | null }>(
      `select asset, asset_class::text, status::text, lot_size::text, tx_hash, issuer from public.listings where chain_id = 'base-sepolia' order by asset`,
    );
    return r.rows;
  }

  it("writes the listings with their approval transaction, and the chain's settlement and USDT; idempotent", async () => {
    const plan = await planEvmListingSync(client, settings());
    expect(await applyEvmListingSync(t.db, plan)).toEqual({ upserted: 3, statusUpdated: 0 });
    expect(await applyEvmListingSync(t.db, plan)).toEqual({ upserted: 3, statusUpdated: 0 });
    const rows = await listings();
    // tBOND (FixedIncome) is mirrored for the listing view; the engine refuses it as a market.
    expect(rows.map((r) => [r.asset, r.asset_class, r.status, r.lot_size])).toEqual([
      [getAddress(T.bond), "fixed_income", "approved", SHARE.toString()],
      [getAddress(T.usdt), "currency", "approved", "1"],
      [getAddress(T.equity), "equity", "approved", SHARE.toString()],
    ]);
    expect(rows.every((r) => /^0x[0-9a-f]{64}$/.test(r.tx_hash ?? ""))).toBe(true);
    const chain = await t.pglite.query<{ settlement_program: string; quote_asset: string }>(
      `select settlement_program, quote_asset from public.chains where id = 'base-sepolia'`,
    );
    expect(chain.rows[0]).toEqual({ settlement_program: getAddress(T.settlement), quote_asset: getAddress(T.usdt) });
  });

  it("keeps the stored spelling of an address, and mirrors a suspension", async () => {
    await applyEvmListingSync(t.db, await planEvmListingSync(client, settings()));
    await t.pglite.query(`update public.listings set asset = lower(asset) where asset = $1`, [getAddress(T.equity)]);
    mock.setListing(T.equity, { assetClass: 0, status: 3, issuer: T.issuer });
    expect(await applyEvmListingSync(t.db, await planEvmListingSync(client, settings()))).toEqual({ upserted: 2, statusUpdated: 1 });
    expect((await listings()).find((r) => r.asset === T.equity.toLowerCase())?.status).toBe("suspended");
  });

  it("refuses to change a lot size while the market has live orders, and writes nothing", async () => {
    await applyEvmListingSync(t.db, await planEvmListingSync(client, settings()));
    await t.pglite.query(
      `insert into public.orders (chain_id, asset, side, quantity, lot_size, limit_price, payment_asset, wallet, nonce,
         expires_at, intent_version, intent_signature, filled_quantity, status)
       values ('base-sepolia', $1, 'sell', $2, $2, 25000000, $3, $4, repeat('1', 32), now() + interval '1 day', 1, 'TEST-SIGNATURE', 0, 'open')`,
      [getAddress(T.equity), SHARE.toString(), getAddress(T.usdt), getAddress(T.seller)],
    );
    const changed = settings({
      lotSizes: { ...settings().lotSizes, [getAddress(T.equity)]: { symbol: "tEQTY", lotSize: 10n * SHARE } },
    });
    await expect(applyEvmListingSync(t.db, await planEvmListingSync(client, changed))).rejects.toThrow(LotSizeChangeError);
    expect((await listings()).find((r) => r.asset === getAddress(T.equity))?.lot_size).toBe(SHARE.toString());
  });
});
