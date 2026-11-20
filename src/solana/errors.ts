import type { TransactionError } from "@solana/web3.js";
import { programError } from "./idl.ts";

export { SettlementFailure, isTransientRpcError, type FailureKind } from "../adapters/failure.ts";
import { SettlementFailure, type FailureKind } from "../adapters/failure.ts";

/** "AnchorError ... Error Code: X. Error Number: N. Error Message: M." */
const ANCHOR_LOG = /Error Code: (\w+)\. Error Number: (\d+)\. Error Message: (.*?)\.?$/;

/**
 * Maps a failed simulation or transaction (its `err` and logs) to a readable failure.
 * Returns "already_settled" when the `["settled", match_id]` record already existed
 * (another send of the same match landed first): that is success, not failure.
 */
export function mapTransactionError(err: TransactionError, logs: readonly string[]): SettlementFailure | "already_settled" {
  // The system program refuses to create the replay guard: the match is settled.
  if (logs.some((l) => /Allocate: account .* already in use/.test(l))) return "already_settled";

  if (logs.some((l) => /insufficient lamports|insufficient funds for (fee|rent)/i.test(l)) || isNoFunds(err)) {
    return new SettlementFailure("operator_funds", "the settlement operator has not enough SOL for the fee and the record's rent");
  }

  const custom = customCode(err);
  if (custom !== undefined) {
    const known = programError(custom);
    if (known) {
      return new SettlementFailure("program", `${known.name} (${known.code}): ${known.msg}`, {
        code: known.code,
        name: known.name,
      });
    }
  }
  for (const line of logs) {
    const m = ANCHOR_LOG.exec(line);
    if (m) {
      const code = Number(m[2]);
      const kind: FailureKind = code >= 6000 ? "program" : "account";
      return new SettlementFailure(kind, `${m[1]} (${code}): ${m[3]}`, { code, name: m[1]! });
    }
  }
  if (custom !== undefined) {
    return new SettlementFailure("account", `instruction failed with custom error ${custom}`, { code: custom });
  }
  return new SettlementFailure("program", `transaction failed: ${JSON.stringify(err)}`);
}

function customCode(err: TransactionError): number | undefined {
  if (typeof err === "object" && err !== null && "InstructionError" in err) {
    const detail = (err as { InstructionError: [number, unknown] }).InstructionError[1];
    if (typeof detail === "object" && detail !== null && "Custom" in detail) {
      return (detail as { Custom: number }).Custom;
    }
  }
  return undefined;
}

function isNoFunds(err: TransactionError): boolean {
  return err === "InsufficientFundsForFee" || err === "InsufficientFundsForRent" ||
    (typeof err === "object" && err !== null && "InsufficientFundsForRent" in err);
}
