import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { DEMO_CAPS, DemoError, parseDemoOptions } from "../../src/devnet/demo-activity.ts";
import { TOKEN_PROGRAM_ID } from "../../src/solana/accounts.ts";
import { checkFundingSources, planTopUp, traderFundingInstructions, traderKeyFile } from "../../src/devnet/demo-funding.ts";

/** Funding the demo traders: top-up to the targets, within the caps; no keys involved (generated per run). */

const mints = { usdtDecimals: 6, assetDecimals: 0 };
const targets = parseDemoOptions({}).funding;
const kp = () => Keypair.generate().publicKey;
const mint = (decimals: number) => ({ mint: kp(), tokenProgram: TOKEN_PROGRAM_ID, decimals });

describe("trader funding", () => {
  it("names at most four trader key files", () => {
    expect(traderKeyFile(1)).toBe("demo-trader-1.json");
    expect(traderKeyFile(4)).toBe("demo-trader-4.json");
    for (const i of [0, 5, -1, 1.5]) expect(() => traderKeyFile(i)).toThrow(DemoError);
  });

  it("tops up TO the targets, never sends more than missing", () => {
    expect(planTopUp(targets, mints, { lamports: 0n, usdt: null, asset: null })).toEqual({
      lamports: 10_000_000n,
      usdt: 500_000_000n,
      asset: 20n,
      newAccounts: 2,
    });
    expect(planTopUp(targets, mints, { lamports: 4_000_000n, usdt: 300_000_000n, asset: 5n })).toEqual({
      lamports: 6_000_000n,
      usdt: 200_000_000n,
      asset: 15n,
      newAccounts: 0,
    });
    expect(planTopUp(targets, mints, { lamports: 99n * 10_000_000n, usdt: 10n ** 12n, asset: 99n })).toEqual({ lamports: 0n, usdt: 0n, asset: 0n, newAccounts: 0 });
  });

  it("never exceeds the caps, even for targets built by hand", () => {
    const huge = { lamports: DEMO_CAPS.funding.lamports + 1n, usdtWhole: 1n, eqtyWhole: 1n };
    expect(() => planTopUp(huge, mints, { lamports: 0n, usdt: 0n, asset: 0n })).toThrow(/above the cap/);
    expect(() => planTopUp({ ...targets, usdtWhole: DEMO_CAPS.funding.usdtWhole + 1n }, mints, { lamports: 0n, usdt: null, asset: null })).toThrow(/above the cap/);
    expect(() => planTopUp({ ...targets, eqtyWhole: DEMO_CAPS.funding.eqtyWhole + 1n }, mints, { lamports: 0n, usdt: null, asset: null })).toThrow(/above the cap/);
  });

  it("refuses when the funder or the token source falls short", () => {
    const plan = planTopUp(targets, mints, { lamports: 0n, usdt: null, asset: null });
    const plans = [plan, plan, plan, plan];
    const ok = { funderLamports: 1_000_000_000n, sourceUsdt: 2_000_000_000n, sourceAsset: 100n };
    expect(() => checkFundingSources(plans, 20, ok)).not.toThrow();
    expect(() => checkFundingSources(plans, 20, { ...ok, funderLamports: 50_000_000n })).toThrow(/demo funder holds/);
    expect(() => checkFundingSources(plans, 20, { ...ok, sourceUsdt: 1_999_999_999n })).toThrow(/mockUSDT/);
    expect(() => checkFundingSources(plans, 20, { ...ok, sourceAsset: 79n })).toThrow(/tEQTY/);
    expect(() => checkFundingSources(plans, 20, { ...ok, sourceUsdt: null })).toThrow(DemoError);
  });

  it("builds only the instructions a trader still needs", () => {
    const usdt = mint(6);
    const asset = mint(0);
    const base = { funder: kp(), source: kp(), trader: Keypair.generate().publicKey, usdt, asset };
    const full = traderFundingInstructions({ ...base, topUp: { lamports: 1n, usdt: 1n, asset: 1n, newAccounts: 2 } });
    expect(full).toHaveLength(5); // SOL, two token accounts, two token transfers
    const none = traderFundingInstructions({ ...base, topUp: { lamports: 0n, usdt: 0n, asset: 0n, newAccounts: 0 } });
    expect(none).toHaveLength(2); // only the idempotent token-account creations
    expect(() => traderFundingInstructions({ ...base, trader: base.funder, topUp: { lamports: 1n, usdt: 1n, asset: 1n, newAccounts: 0 } })).toThrow(DemoError);
  });
});
