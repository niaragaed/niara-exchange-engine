import type { TransactionError } from "@solana/web3.js";
import { programError } from "./idl.ts";

/**
 * Readable settlement failures. Every failure is either `transient` (RPC trouble: the
 * worker retries with a bounded backoff) or not (the chain refused the settlement, or
 * the setup is wrong: retrying would not help).
 */

export type FailureKind =
  /** niara_exchange refused: `code`/`name` from the IDL (e.g. 6025 DelegateNotSet). */
  | "program"
  /** An Anchor account constraint refused (e.g. 3012 AccountNotInitialized). */
  | "account"
  /** The settlement operator cannot pay the fee or the record's rent. */
  | "operator_funds"
  /** Setup problem found before sending (wrong operator, paused, missing account). */
  | "precondition"
  /** RPC trouble: rate limit, timeout, expired blockhash, node behind. */
  | "transient";

export class SettlementFailure extends Error {
  readonly kind: FailureKind;
  readonly code: number | undefined;
  readonly errorName: string | undefined;
  constructor(kind: FailureKind, message: string, details: { code?: number; name?: string } = {}) {
    super(message);
    this.name = "SettlementFailure";
    this.kind = kind;
    this.code = details.code;
    this.errorName = details.name;
  }
  get transient(): boolean {
    return this.kind === "transient";
  }
}

const TRANSIENT = [
  /\b429\b/,
  /too many requests/i,
  /\b50[0-4]\b/,
  /ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR/,
  /fetch failed/i,
  /socket hang up/i,
  /timed? ?out/i,
  /blockhash not found/i,
  /block height exceeded/i,
  /TransactionExpired/i,
  /node is behind/i,
  /minimum context slot/i,
];

export function isTransientRpcError(e: unknown): boolean {
  const text = e instanceof Error ? `${e.name} ${e.message}` : String(e);
  return TRANSIENT.some((re) => re.test(text));
}

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
