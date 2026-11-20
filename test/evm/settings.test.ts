import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_EVM_CONFIG, EvmSettingsError, deployedChain, explorerTx, loadEvmSettings, parseEvmSettings } from "../../src/evm/settings.ts";

/** config/evm-testnets.json: the per-chain settings taken from niara-contracts. */

const raw = () => JSON.parse(readFileSync(DEFAULT_EVM_CONFIG, "utf8"));

describe("EVM chain settings", () => {
  it("reads the repository's config file: the v1 deployments and each chain's gas rules", () => {
    const s = loadEvmSettings();
    for (const chain of ["base-sepolia", "robinhood-testnet", "tempo-testnet"] as const) {
      // Same deployer nonces on all three chains, so the same addresses (niara-contracts README).
      expect(s[chain]).toMatchObject({
        deployed: true,
        contracts: {
          listingRegistry: "0x883081A2f4D1860aa92f03Cb3FE0f0aDcEc0C58f",
          settlement: "0x14C6F9DeD6C97F67149B4305c57331F9d3820B6F",
          cashbackDistributor: "0x4b10fF1a44Aca4118F75b1f326cC2EE46b73ADD4",
        },
        quoteAsset: "0x4ED579b02B53d050624c0F04Fb1F4D9b1d347457",
        operator: "0x59ff48062E4BfAb0F0DD94377b0C6f8203f078f3",
      });
      expect(s[chain].lotSizes["0x0f1c771c8943cD7EC2b4c654CEea49B41336bDD7"]).toEqual({ symbol: "tEQTY", lotSize: 10n ** 18n });
    }
    expect(s["base-sepolia"].gas).toEqual({ pricing: "eip1559", multiplierPct: 130, maxGasPerTx: null, feeToken: null });
    expect(s["robinhood-testnet"].gas).toMatchObject({ pricing: "eip1559", multiplierPct: 200 });
    expect(s["tempo-testnet"].gas).toEqual({
      pricing: "tempo",
      multiplierPct: 200,
      maxGasPerTx: 30_000_000n,
      feeToken: "0x20C0000000000000000000000000000000000000", // pathUSD, checksummed
    });
    expect(s["hyperevm-testnet"]).toMatchObject({ deployed: false, contracts: null, gas: { pricing: "legacy", maxGasPerTx: 3_000_000n } });
    expect(s["base-sepolia"].fromBlock).toBe(59_342_255n);
    expect(explorerTx(s["base-sepolia"], "0xabc")).toBe("https://sepolia.basescan.org/tx/0xabc");
  });

  it("refuses an undeployed chain, and an unreviewed one where review is required", () => {
    const s = loadEvmSettings();
    expect(() => deployedChain(s, "hyperevm-testnet", { requireReviewed: false })).toThrow(/no deployment/);
    const unreviewed = { ...s, "base-sepolia": { ...s["base-sepolia"], reviewed: false } };
    expect(() => deployedChain(unreviewed, "base-sepolia", { requireReviewed: true })).toThrow(/not marked reviewed/);
    expect(deployedChain(unreviewed, "base-sepolia", { requireReviewed: false }).chain).toBe("base-sepolia");
  });

  it("validates the file: chain ids, addresses, gas rules, lot sizes", () => {
    const bad = (edit: (j: any) => void) => {
      const j = raw();
      edit(j);
      return () => parseEvmSettings(j);
    };
    expect(bad((j) => (j.chains["base-sepolia"].evmChainId = 8453))).toThrow(/must be 84532/);
    expect(bad((j) => (j.chains["tempo-testnet"].gas.feeToken = null))).toThrow(/feeToken is required with tempo/);
    expect(bad((j) => (j.chains["base-sepolia"].gas.feeToken = "0x20c0000000000000000000000000000000000000"))).toThrow(/only then/);
    expect(bad((j) => (j.chains["base-sepolia"].gas.multiplierPct = 50))).toThrow(/multiplierPct/);
    expect(bad((j) => (j.chains["base-sepolia"].contracts.settlement = "0x123"))).toThrow(/must be an address/);
    expect(bad((j) => (j.chains["base-sepolia"].lotSizes["0x0f1c771c8943cD7EC2b4c654CEea49B41336bDD7"].lotSize = "1.5"))).toThrow(/positive integer/);
    expect(bad((j) => (j.chains["base-sepolia"].operator = null))).toThrow(/deployed but/);
    expect(bad((j) => (j.chains["ethereum"] = {}))).toThrow(/unknown chain ethereum/);
    expect(bad((j) => delete j.chains["tempo-testnet"])).toThrow(/tempo-testnet is missing/);
    expect(() => parseEvmSettings({})).toThrow(EvmSettingsError);
  });
});
