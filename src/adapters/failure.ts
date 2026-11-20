/**
 * Readable settlement failures, shared by every chain adapter. TESTNET ONLY. Every failure is either `transient` (RPC trouble: the
 * worker retries with a bounded backoff) or not (the chain refused the settlement, or
 * the setup is wrong: retrying would not help).
 */

export type FailureKind =
  /**
   * The settlement program/contract refused: Solana `code`/`name` from the IDL (e.g.
   * 6025 DelegateNotSet); EVM the custom error's name (e.g. ERC20InsufficientAllowance).
   */
  | "program"
  /** An Anchor account constraint refused (e.g. 3012 AccountNotInitialized). */
  | "account"
  /** The settlement operator cannot pay the fee (and on Solana the record's rent). */
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
  /HTTP request failed/i,
  /nonce too low|replacement transaction underpriced|already known/i,
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

