import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { matchNeeds, orderNeed, solanaCoverageChecker } from "../../src/solana/coverage.ts";
import { PROGRAM_ID } from "../../src/solana/idl.ts";
import { world } from "./world.ts";

describe("on-chain delegate check (spec §3.5)", () => {
  it("covers a sell order with the asset delegation and a buy order with the USDT delegation", async () => {
    const w = world();
    const check = solanaCoverageChecker(w.rpc, PROGRAM_ID);
    const sell = orderNeed({
      side: "sell",
      wallet: w.seller.publicKey.toBase58(),
      asset: w.asset.toBase58(),
      paymentAsset: w.usdt.toBase58(),
      remaining: 10n,
      lotSize: 1n,
      limitPrice: 25_000_000n,
    });
    const buy = orderNeed({
      side: "buy",
      wallet: w.buyer.publicKey.toBase58(),
      asset: w.asset.toBase58(),
      paymentAsset: w.usdt.toBase58(),
      remaining: 10n,
      lotSize: 1n,
      limitPrice: 25_000_000n,
    });
    expect(sell).toEqual({ wallet: w.seller.publicKey.toBase58(), mint: w.asset.toBase58(), amount: 10n });
    expect(buy.amount).toBe(250_000_000n);
    expect(await check.check([sell, buy])).toEqual([null, null]);
    // One more share or one more USDT base unit than delegated is not covered.
    expect(await check.check([{ ...sell, amount: 11n }, { ...buy, amount: 250_000_001n }])).toEqual([
      "delegated 10 < needed 11",
      "delegated 250000000 < needed 250000001",
    ]);
  });

  it("refuses a revoked delegation, another delegate, a short balance and a missing account", async () => {
    const w = world();
    const check = solanaCoverageChecker(w.rpc, PROGRAM_ID);
    const need = { wallet: w.seller.publicKey.toBase58(), mint: w.asset.toBase58(), amount: 10n };
    w.setTokens(w.asset, w.seller.publicKey, 900n, 0n);
    expect(await check.check([need])).toEqual(["the token account does not delegate to the vault"]);
    w.setTokens(w.asset, w.seller.publicKey, 900n, 10n, Keypair.generate().publicKey);
    expect(await check.check([need])).toEqual(["the token account does not delegate to the vault"]);
    w.setTokens(w.asset, w.seller.publicKey, 5n, 10n);
    expect(await check.check([need])).toEqual(["balance 5 < needed 10"]);
    expect(await check.check([{ ...need, wallet: Keypair.generate().publicKey.toBase58() }])).toEqual([
      "the wallet has no token account for this mint",
    ]);
    expect((await check.check([{ ...need, mint: Keypair.generate().publicKey.toBase58() }]))[0]).toMatch(/not found/);
  });

  it("derives a match's two needs: the seller's asset quantity and the buyer's payment", () => {
    const w = world();
    const m = w.match();
    expect(matchNeeds(m)).toEqual({
      seller: { wallet: m.seller, mint: m.asset, amount: 10n },
      buyer: { wallet: m.buyer, mint: m.paymentAsset, amount: 250_000_000n },
    });
  });

  it("propagates RPC failures (the caller decides: refuse the order, or retry the settlement)", async () => {
    const w = world();
    w.rpc.failNextRead = new Error("429 Too Many Requests");
    await expect(
      solanaCoverageChecker(w.rpc, PROGRAM_ID).check([{ wallet: w.seller.publicKey.toBase58(), mint: w.asset.toBase58(), amount: 1n }]),
    ).rejects.toThrow(/429/);
  });
});
