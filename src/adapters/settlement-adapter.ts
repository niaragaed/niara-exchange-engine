import type { ChainId } from "../chains.ts";
import type { Match } from "../engine/types.ts";

/**
 * The single off-chain settlement interface (spec §2). One implementation per chain;
 * none exists yet (Solana: week 4, EVM: week 3, spec §7).
 *
 * `settle` submits `match` to the chain's settlement program/contract with
 * `match_id = match.id` (16 bytes, spec §3.4), `asset_amount = match.quantity` and
 * `payment_amount = match.paymentAmount`. The chain rejects a second settlement of the
 * same id (`SettlementRecord` on Solana, `settledMatches` on EVM).
 */
export interface SettlementAdapter {
  chain: ChainId;
  settle(match: Match): Promise<{ txHash: string }>;
  isListed(asset: string): Promise<boolean>;
}

export type { Match };
