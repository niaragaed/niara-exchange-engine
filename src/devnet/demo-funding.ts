import { PublicKey, SystemProgram, type TransactionInstruction } from "@solana/web3.js";
import { associatedTokenAddress } from "../solana/accounts.ts";
import { createAssociatedTokenAccountIdempotent, transferChecked } from "../solana/token-instructions.ts";
import { DemoError, DEMO_CAPS, type DemoOptions } from "./demo-activity.ts";
import type { MintInfo } from "./funding.ts";

/**
 * Funding the demo traders of scripts/demo-activity.ts on Solana DEVNET: devnet SOL from
 * the demo funder, mockUSDT and tEQTY from the demo "equity-seller" wallet, topped up
 * TO the per-trader targets (never above the caps). Pure: plans and builds instructions;
 * the script reads the chain, simulates and sends. TESTNET ONLY.
 */

/** Key files of the new demo traders, next to the other demo keys; never inside the repository. */
export const traderKeyFile = (index: number): string => {
  if (!Number.isInteger(index) || index < 1 || index > DEMO_CAPS.maxTraders) throw new DemoError(`trader index must be 1 to ${DEMO_CAPS.maxTraders}`);
  return `demo-trader-${index}.json`;
};

/** Rent of the two token accounts a new trader needs, plus slack. */
export const TRADER_ACCOUNTS_RENT_LAMPORTS = 5_000_000n;
/** Fees of one `approve` transaction (two signatures), paid by the funder. */
export const APPROVE_FEE_LAMPORTS = 10_000n;
/** Kept back in the funder on top of everything planned. */
export const FUNDER_SAFETY_LAMPORTS = 20_000_000n;

export interface TraderHoldings {
  lamports: bigint;
  /** mockUSDT base units; null = no token account yet. */
  usdt: bigint | null;
  asset: bigint | null;
}

export interface TraderTopUp {
  lamports: bigint;
  usdt: bigint;
  asset: bigint;
  /** The trader needs a new token account (rent paid by the funder). */
  newAccounts: number;
}

const up = (target: bigint, held: bigint | null) => (held !== null && held >= target ? 0n : target - (held ?? 0n));

/** What to send to bring a trader up to the targets: nothing for a trader that already holds enough. */
export function planTopUp(targets: DemoOptions["funding"], mints: { usdtDecimals: number; assetDecimals: number }, held: TraderHoldings): TraderTopUp {
  const topUp = {
    lamports: up(targets.lamports, held.lamports),
    usdt: up(targets.usdtWhole * 10n ** BigInt(mints.usdtDecimals), held.usdt),
    asset: up(targets.eqtyWhole * 10n ** BigInt(mints.assetDecimals), held.asset),
    newAccounts: (held.usdt === null ? 1 : 0) + (held.asset === null ? 1 : 0),
  };
  // Never above the caps, whatever the targets say.
  if (topUp.lamports > DEMO_CAPS.funding.lamports) throw new DemoError("a SOL top-up above the cap");
  if (topUp.usdt > DEMO_CAPS.funding.usdtWhole * 10n ** BigInt(mints.usdtDecimals)) throw new DemoError("a mockUSDT top-up above the cap");
  if (topUp.asset > DEMO_CAPS.funding.eqtyWhole * 10n ** BigInt(mints.assetDecimals)) throw new DemoError("a tEQTY top-up above the cap");
  return topUp;
}

/** Refuses when the funder or the token source cannot cover the plan plus the approvals of `trades` trades. */
export function checkFundingSources(
  plans: readonly TraderTopUp[],
  trades: number,
  have: { funderLamports: bigint; sourceUsdt: bigint | null; sourceAsset: bigint | null },
): void {
  const sum = (f: (p: TraderTopUp) => bigint) => plans.reduce((a, p) => a + f(p), 0n);
  const lamports =
    sum((p) => p.lamports) + sum((p) => BigInt(p.newAccounts) * (TRADER_ACCOUNTS_RENT_LAMPORTS / 2n)) + APPROVE_FEE_LAMPORTS * BigInt(2 * trades) + FUNDER_SAFETY_LAMPORTS;
  if (have.funderLamports < lamports) throw new DemoError(`the demo funder holds ${have.funderLamports} lamports; the plan needs about ${lamports}`);
  if (have.sourceUsdt === null || have.sourceUsdt < sum((p) => p.usdt)) throw new DemoError("the token source holds less mockUSDT than the top-ups need");
  if (have.sourceAsset === null || have.sourceAsset < sum((p) => p.asset)) throw new DemoError("the token source holds less tEQTY than the top-ups need");
}

/** The instructions that fund one trader: SOL, its token accounts (idempotent), then the tokens. */
export function traderFundingInstructions(v: {
  funder: PublicKey;
  source: PublicKey;
  trader: PublicKey;
  usdt: MintInfo;
  asset: MintInfo;
  topUp: TraderTopUp;
}): TransactionInstruction[] {
  if (!PublicKey.isOnCurve(v.trader.toBytes())) throw new DemoError(`${v.trader.toBase58()} is not a wallet address`);
  if (v.trader.equals(v.funder) || v.trader.equals(v.source)) throw new DemoError("a trader cannot be the funder or the token source");
  const usdtAta = createAssociatedTokenAccountIdempotent({ payer: v.funder, owner: v.trader, mint: v.usdt.mint, tokenProgram: v.usdt.tokenProgram });
  const assetAta = createAssociatedTokenAccountIdempotent({ payer: v.funder, owner: v.trader, mint: v.asset.mint, tokenProgram: v.asset.tokenProgram });
  const out: TransactionInstruction[] = [];
  if (v.topUp.lamports > 0n) out.push(SystemProgram.transfer({ fromPubkey: v.funder, toPubkey: v.trader, lamports: v.topUp.lamports }));
  out.push(usdtAta.instruction, assetAta.instruction);
  if (v.topUp.usdt > 0n) {
    out.push(
      transferChecked({
        tokenProgram: v.usdt.tokenProgram,
        source: associatedTokenAddress(v.usdt.mint, v.source, v.usdt.tokenProgram),
        mint: v.usdt.mint,
        destination: usdtAta.address,
        owner: v.source,
        amount: v.topUp.usdt,
        decimals: v.usdt.decimals,
      }),
    );
  }
  if (v.topUp.asset > 0n) {
    out.push(
      transferChecked({
        tokenProgram: v.asset.tokenProgram,
        source: associatedTokenAddress(v.asset.mint, v.source, v.asset.tokenProgram),
        mint: v.asset.mint,
        destination: assetAta.address,
        owner: v.source,
        amount: v.topUp.asset,
        decimals: v.asset.decimals,
      }),
    );
  }
  return out;
}
