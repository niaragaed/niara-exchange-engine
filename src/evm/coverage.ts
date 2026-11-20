import { getAddress, type Address } from "viem";
import type { CoverageChecker } from "../solana/coverage.ts";
import { NATIVE_ASSET_TOKEN_ABI } from "./abi/NativeAssetToken.ts";
import type { EvmClient } from "./client.ts";

/**
 * Allowance check, the EVM equivalent of the Solana delegate check (spec §3.5).
 * `NiaraSettlement.settle` moves both legs with `transferFrom`, so each side needs, on
 * its own leg's token:
 *
 *   sell order  asset token  allowance(wallet, NiaraSettlement) >= remaining, balance >= remaining
 *   buy order   mock USDT    allowance(wallet, NiaraSettlement) >= payment,   balance >= payment
 *
 * `CoverageNeed.mint` is the token address here. As on Solana the check is per order: one
 * allowance per (wallet, token, spender), so several open orders of one wallet on one
 * token need an aggregate approval, which this does not sum. Read-only.
 */
export function evmCoverageChecker(client: EvmClient, settlement: Address): CoverageChecker {
  return {
    async check(needs) {
      return Promise.all(
        needs.map(async (n) => {
          const token = getAddress(n.mint);
          const wallet = getAddress(n.wallet);
          const code = await client.getCode({ address: token });
          if (!code || code === "0x") return `token ${token} not found`;
          const [allowance, balance] = await Promise.all([
            client.readContract({ address: token, abi: NATIVE_ASSET_TOKEN_ABI, functionName: "allowance", args: [wallet, settlement] }),
            client.readContract({ address: token, abi: NATIVE_ASSET_TOKEN_ABI, functionName: "balanceOf", args: [wallet] }),
          ]);
          if (allowance < n.amount) return `allowance ${allowance} < needed ${n.amount}`;
          if (balance < n.amount) return `balance ${balance} < needed ${n.amount}`;
          return null;
        }),
      );
    },
  };
}
