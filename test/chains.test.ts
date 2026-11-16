import { describe, expect, it } from "vitest";
import { CHAIN_IDS, CHAINS, isChainId } from "../src/chains.ts";

describe("chains", () => {
  it("lists exactly the five v1 chains of spec §2", () => {
    expect([...CHAIN_IDS]).toEqual([
      "solana-devnet",
      "base-sepolia",
      "robinhood-testnet",
      "hyperevm-testnet",
      "tempo-testnet",
    ]);
  });

  it("uses the chain ids of spec §4 and §9.9 as CAIP-2 ids", () => {
    expect(CHAINS["solana-devnet"].caip2).toBe("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1");
    expect(CHAINS["base-sepolia"].caip2).toBe("eip155:84532");
    expect(CHAINS["robinhood-testnet"].caip2).toBe("eip155:46630");
    expect(CHAINS["hyperevm-testnet"].caip2).toBe("eip155:998");
    expect(CHAINS["tempo-testnet"].caip2).toBe("eip155:42431");
  });

  it("does not accept Ethereum Sepolia (deferred from v1, §9.9) or a mainnet", () => {
    expect(isChainId("sepolia")).toBe(false);
    expect(isChainId("solana-mainnet")).toBe(false);
    expect(isChainId("base-sepolia")).toBe(true);
  });
});
