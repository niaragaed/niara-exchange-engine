import type { ChainId } from "../chains.ts";
import type { Match } from "../engine/types.ts";

/**
 * The single off-chain settlement interface (spec §2). One implementation per chain:
 * Solana devnet in `solana-adapter.ts`; EVM not written yet.
 *
 * `settle` submits `match` to the chain's settlement program/contract with
 * `match_id = match.id` (16 bytes, spec §3.4), `asset_amount = match.quantity` and
 * `payment_amount = match.paymentAmount`. The chain rejects a second settlement of the
 * same id (`SettlementRecord` on Solana, `settledMatches` on EVM).
 *
 * Extension of the spec's `{ txHash }`: `alreadySettled` is true when the chain already
 * held the match's replay guard, so nothing was sent; `txHash` is then the transaction
 * that created it. Failures throw `SettlementFailure` (`src/solana/errors.ts`), which says
 * whether a retry can help.
 */
export interface SettleOutcome {
  txHash: string;
  alreadySettled: boolean;
}

export interface SettlementAdapter {
  chain: ChainId;
  settle(match: Match): Promise<SettleOutcome>;
  isListed(asset: string): Promise<boolean>;
}

export type { Match };
