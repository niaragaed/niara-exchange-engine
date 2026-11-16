import type { SettlementAdapter } from "../adapters/settlement-adapter.ts";

/**
 * Settlement worker: STUB. Nothing is settled here yet.
 *
 * Planned (spec §5): read `matches` with status `pending`, call the chain's
 * `SettlementAdapter.settle`, and record the outcome in `settlements` (unique on
 * `match_id`, so a match is settled at most once off-chain as well as on-chain). It
 * will hold one operator key per chain, loaded from the server environment, never from
 * `NEXT_PUBLIC_*` and never from git.
 */
export class SettlementWorkerNotImplemented extends Error {
  constructor() {
    super("settlement worker not implemented: no match is ever settled by this build");
    this.name = "SettlementWorkerNotImplemented";
  }
}

export function startWorker(_adapters: readonly SettlementAdapter[]): never {
  throw new SettlementWorkerNotImplemented();
}
