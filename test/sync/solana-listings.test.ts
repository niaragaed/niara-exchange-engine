import { Keypair, PublicKey } from "@solana/web3.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asServiceRole, insertOrder } from "../../src/db/repository.ts";
import { pdas } from "../../src/solana/accounts.ts";
import { PROGRAM_ID } from "../../src/solana/idl.ts";
import {
  LotSizeChangeError,
  applyListingSync,
  loadMarketConfig,
  parseMarketConfig,
  planListingSync,
  type MarketConfig,
} from "../../src/sync/solana-listings.ts";
import { resetData, startPglite, type TestDb } from "../db/pglite.ts";
import { configData, listingData, mintData, mockRpc, token2022MintData, type MockRpc } from "../solana/mock-rpc.ts";

// Generated per run: not devnet mints.
const usdt = Keypair.generate().publicKey;
const equity = Keypair.generate().publicKey;
const bond = Keypair.generate().publicKey;
const quoted = Keypair.generate().publicKey;
const unreviewed = Keypair.generate().publicKey;

let t: TestDb;
let rpc: MockRpc;

function config(over: Partial<MarketConfig> = {}): MarketConfig {
  return {
    programId: PROGRAM_ID.toBase58(),
    quoteAsset: usdt.toBase58(),
    reviewed: true,
    lotSizes: {
      [usdt.toBase58()]: { symbol: "mockUSDT", lotSize: 1n },
      [equity.toBase58()]: { symbol: "tEQTY", lotSize: 1n },
      [bond.toBase58()]: { symbol: "tDEB", lotSize: 1n },
      [quoted.toBase58()]: { symbol: "tQ", lotSize: 1n },
    },
    ...over,
  };
}

function chainState(): MockRpc {
  const r = mockRpc();
  const program = (data: Uint8Array) => ({ owner: PROGRAM_ID, lamports: 1, data });
  r.set(pdas().config(), program(configData({ settlementOperator: Keypair.generate().publicKey, feeMint: usdt })));
  const listing = (mint: PublicKey, assetClass: "Equity" | "FixedIncome" | "Currency", status: "Approved" | "Quoted") =>
    r.set(pdas().listing(mint), program(listingData({ mint, assetClass, status })));
  listing(usdt, "Currency", "Approved");
  listing(equity, "Equity", "Approved");
  listing(bond, "FixedIncome", "Approved");
  listing(quoted, "Equity", "Quoted");
  listing(unreviewed, "Equity", "Approved");
  for (const [mint, decimals] of [[usdt, 6], [bond, 2], [quoted, 0], [unreviewed, 0]] as const) {
    r.set(mint, { owner: PROGRAM_ID, lamports: 1, data: mintData(decimals) });
  }
  // A Token-2022 mint with its own TokenMetadata (test values); the others are classic mints without metadata.
  r.set(equity, { owner: PROGRAM_ID, lamports: 1, data: token2022MintData(0, equity, { name: "Test Demo Equity", symbol: "tEQTY" }) });
  return r;
}

beforeAll(async () => {
  t = await startPglite();
});

afterAll(async () => {
  await t.pglite.close();
});

beforeEach(async () => {
  await resetData(t.pglite);
  rpc = chainState();
});

describe("config file", () => {
  it("the committed devnet config parses, names the IDL's program and the devnet mock USDT, and awaits review", () => {
    const c = loadMarketConfig(new URL("../../config/solana-devnet.json", import.meta.url).pathname);
    expect(c.programId).toBe(PROGRAM_ID.toBase58());
    expect(c.quoteAsset).toBe("8iWQ7VxYrkUv471vEoZ664eLwDzWinPiCJpRvcTUA24y");
    expect(c.lotSizes["8LjQkS1rTJGpzz9wbyAmqJk7oZgDsZS6vhPBv2BhzsTo"]).toEqual({ symbol: "tEQTY", lotSize: 1n });
    expect(typeof c.reviewed).toBe("boolean");
  });

  it("refuses another cluster, another program, a bad mint or lot size", () => {
    const base = { cluster: "devnet", programId: PROGRAM_ID.toBase58(), quoteAsset: usdt.toBase58(), reviewed: true, lotSizes: {} };
    expect(() => parseMarketConfig({ ...base, cluster: "mainnet-beta" })).toThrow(/devnet/);
    expect(() => parseMarketConfig({ ...base, programId: usdt.toBase58() })).toThrow(/program/);
    expect(() => parseMarketConfig({ ...base, lotSizes: { "not-a-mint": { lotSize: "1" } } })).toThrow(/mint/);
    expect(() => parseMarketConfig({ ...base, lotSizes: { [equity.toBase58()]: { lotSize: "0" } } })).toThrow(/positive/);
    expect(() => parseMarketConfig({ ...base, lotSizes: { [equity.toBase58()]: { lotSize: 1 } } })).toThrow(/string/);
  });
});

describe("plan (read-only on-chain)", () => {
  it("upserts approved listings with reviewed lot sizes, skips unreviewed ones, and only updates the others' status", async () => {
    const plan = await planListingSync(rpc, config());
    expect(plan.settlementProgram).toBe(PROGRAM_ID.toBase58());
    expect(plan.quoteAsset).toBe(usdt.toBase58());
    const byAsset = Object.fromEntries(plan.upserts.map((u) => [u.asset, u]));
    expect(byAsset[equity.toBase58()]).toMatchObject({ assetClass: "equity", status: "approved", assetDecimals: 0, lotSize: 1n });
    expect(byAsset[equity.toBase58()]!.docHash).toBe("ab".repeat(32));
    expect(byAsset[usdt.toBase58()]).toMatchObject({ assetClass: "currency", issuer: null, docHash: null, cashbackEligible: false });
    expect(byAsset[bond.toBase58()]).toMatchObject({ assetClass: "fixed_income", assetDecimals: 2 });
    // symbol and name from the mint's Token-2022 metadata; null for a mint without it.
    expect(byAsset[equity.toBase58()]!.metadata).toEqual({ symbol: "tEQTY", name: "Test Demo Equity" });
    expect(byAsset[usdt.toBase58()]!.metadata).toEqual({ symbol: null, name: null });
    expect(plan.warnings).toEqual([]);
    expect(plan.statusOnly).toEqual([{ asset: quoted.toBase58(), status: "quoted" }]);
    expect(plan.skipped).toEqual([{ asset: unreviewed.toBase58(), reason: "no reviewed lot size in the config file" }]);
    // Read-only: nothing was simulated or sent.
    expect(rpc.calls.filter((c) => c === "send" || c === "simulate")).toEqual([]);
  });

  it("stores no metadata, with a warning, when the extension names another mint or holds unstorable text", async () => {
    rpc.set(bond, { owner: PROGRAM_ID, lamports: 1, data: token2022MintData(2, bond, { name: "Bond", symbol: "B", metadataMint: usdt }) });
    rpc.set(usdt, { owner: PROGRAM_ID, lamports: 1, data: token2022MintData(6, usdt, { name: "n".repeat(200), symbol: " TUSD " }) });
    const plan = await planListingSync(rpc, config());
    const byAsset = Object.fromEntries(plan.upserts.map((u) => [u.asset, u]));
    expect(byAsset[bond.toBase58()]!.metadata).toEqual({ symbol: null, name: null });
    expect(byAsset[usdt.toBase58()]!.metadata).toEqual({ symbol: "TUSD", name: null }); // trimmed; the name is too long
    expect(plan.warnings).toHaveLength(2);
    expect(plan.warnings).toEqual(
      expect.arrayContaining([
        expect.stringMatching(new RegExp(`^${bond.toBase58()}: Token-2022 metadata not read \\(TokenMetadata names another mint\\)`)),
        expect.stringMatching(new RegExp(`^${usdt.toBase58()}: on-chain name not stored`)),
      ]),
    );
  });

  it("refuses a quote asset that is not the on-chain fee mint, and any cluster but devnet", async () => {
    await expect(planListingSync(rpc, config({ quoteAsset: equity.toBase58() }))).rejects.toThrow(/fee mint/);
    rpc.genesis = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
    await expect(planListingSync(rpc, config())).rejects.toThrow(/not devnet/);
  });
});

describe("apply (PGlite, real migrations)", () => {
  it("writes the listings and the chain's program and USDT, and is idempotent", async () => {
    const plan = await planListingSync(rpc, config());
    expect(await applyListingSync(t.db, plan)).toEqual({ upserted: 3, statusUpdated: 0 });
    expect(await applyListingSync(t.db, plan)).toEqual({ upserted: 3, statusUpdated: 0 });
    const rows = await t.pglite.query<{ asset: string; asset_class: string; lot_size: string }>(
      "select asset, asset_class::text, lot_size::text from public.listings order by asset",
    );
    expect(rows.rows.map((r) => r.asset).sort()).toEqual([usdt, equity, bond].map((k) => k.toBase58()).sort());
    const meta = await t.pglite.query<{ symbol: string | null; name: string | null }>(
      "select symbol, name from public.listings where asset = $1",
      [equity.toBase58()],
    );
    expect(meta.rows[0]).toEqual({ symbol: "tEQTY", name: "Test Demo Equity" });
    const chain = await t.pglite.query<{ settlement_program: string; quote_asset: string }>(
      "select settlement_program, quote_asset from public.chains where id = 'solana-devnet'",
    );
    expect(chain.rows[0]).toEqual({ settlement_program: PROGRAM_ID.toBase58(), quote_asset: usdt.toBase58() });
  });

  it("mirrors a suspension of an already mirrored listing", async () => {
    await applyListingSync(t.db, await planListingSync(rpc, config()));
    rpc.set(pdas().listing(equity), { owner: PROGRAM_ID, lamports: 1, data: listingData({ mint: equity, assetClass: "Equity", status: "Suspended" }) });
    expect(await applyListingSync(t.db, await planListingSync(rpc, config()))).toEqual({ upserted: 2, statusUpdated: 1 });
    const r = await t.pglite.query<{ status: string }>("select status::text from public.listings where asset = $1", [equity.toBase58()]);
    expect(r.rows[0]!.status).toBe("suspended");
  });

  it("refuses to change a lot size while the market has live orders, and writes nothing", async () => {
    await applyListingSync(t.db, await planListingSync(rpc, config()));
    await asServiceRole(t.db, (tx) =>
      insertOrder(tx, {
        id: crypto.randomUUID(),
        seq: 1,
        chain: "solana-devnet",
        asset: equity.toBase58(),
        side: "sell",
        quantity: 10n,
        lotSize: 1n,
        limitPrice: 25_000_000n,
        paymentAsset: usdt.toBase58(),
        wallet: "TEST-WALLET",
        nonce: "1".padStart(32, "0"),
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        intentVersion: 1,
        intentSignature: "TEST-SIGNATURE",
        filledQuantity: 0n,
        status: "open",
      }),
    );
    const bigger = config({ lotSizes: { ...config().lotSizes, [equity.toBase58()]: { symbol: "tEQTY", lotSize: 10n } } });
    await expect(applyListingSync(t.db, await planListingSync(rpc, bigger))).rejects.toThrow(LotSizeChangeError);
    const r = await t.pglite.query<{ lot_size: string }>("select lot_size::text from public.listings where asset = $1", [
      equity.toBase58(),
    ]);
    expect(r.rows[0]!.lot_size).toBe("1");
  });
});
