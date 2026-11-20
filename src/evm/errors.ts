import { BaseError, ContractFunctionRevertedError, InsufficientFundsError, type Abi } from "viem";
import { SettlementFailure, isTransientRpcError } from "../adapters/failure.ts";
import { NATIVE_ASSET_TOKEN_ABI } from "./abi/NativeAssetToken.ts";
import { NIARA_SETTLEMENT_ABI } from "./abi/NiaraSettlement.ts";

/**
 * NiaraSettlement's ABI plus the token errors a `settle` can bubble up (OpenZeppelin
 * ERC20 v5: ERC20InsufficientAllowance, ERC20InsufficientBalance, ...), so a simulated
 * revert decodes to its name whichever contract raised it.
 */
export const SETTLE_ABI = [
  ...NIARA_SETTLEMENT_ABI,
  ...NATIVE_ASSET_TOKEN_ABI.filter((i) => i.type === "error" && i.name.startsWith("ERC20")),
] as const satisfies Abi;

/** Errors that mean a leg's allowance or balance does not cover the match. */
export const EVM_COVERAGE_ERRORS = new Set([
  "ERC20InsufficientAllowance",
  "ERC20InsufficientBalance",
  "SafeERC20FailedOperation",
]);

const text = (e: unknown) => (e instanceof BaseError ? e.shortMessage : e instanceof Error ? e.message : String(e));

/**
 * Maps a failed simulation, estimate or send to a readable failure. Returns
 * "already_settled" for `MatchAlreadySettled` (another send of the match landed first:
 * success, not failure).
 *
 * - the contract's or a token's custom error: `program` with its name (permanent);
 *   `EnforcedPause` (protocol paused) is transient, as on Solana;
 *   `AccessControlUnauthorizedAccount` (the operator lost its role) is a setup problem;
 * - the operator cannot pay the gas: `operator_funds`;
 * - anything else (RPC trouble, timeouts, unknown node errors): transient, so the worker
 *   retries with a bounded backoff.
 */
export function mapEvmError(e: unknown): SettlementFailure | "already_settled" {
  if (e instanceof SettlementFailure) return e;
  if (e instanceof BaseError) {
    const reverted = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError) {
      const name = reverted.data?.errorName;
      if (name === "MatchAlreadySettled") return "already_settled";
      if (name === "EnforcedPause") return new SettlementFailure("transient", "the protocol is paused (EnforcedPause)", { name });
      if (name === "AccessControlUnauthorizedAccount") {
        return new SettlementFailure("precondition", "the operator key does not hold SETTLEMENT_OPERATOR_ROLE", { name });
      }
      if (name) {
        const args = (reverted.data?.args ?? []).map((a) => String(a)).join(", ");
        return new SettlementFailure("program", `${name}(${args})`, { name });
      }
      return new SettlementFailure("program", `settle reverted: ${reverted.reason ?? reverted.signature ?? reverted.shortMessage}`);
    }
    if (e.walk((x) => x instanceof InsufficientFundsError)) {
      return new SettlementFailure("operator_funds", "the settlement operator cannot pay the gas");
    }
  }
  const label = isTransientRpcError(e) ? "RPC" : "RPC (unclassified)";
  return new SettlementFailure("transient", `${label}: ${text(e)}`);
}
