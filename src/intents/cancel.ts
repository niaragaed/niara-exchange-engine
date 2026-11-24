import { verifyAsync } from "@noble/ed25519";
import { base58 } from "@scure/base";
import { getAddress, hashTypedData, keccak256, recoverTypedDataAddress, toHex, type Hex } from "viem";
import { CHAINS, isChainId } from "../chains.ts";
import { EIP712_DOMAIN_NAME, EIP712_DOMAIN_VERSION, checkEvmSignatureFormat } from "./evm.ts";
import { decodeSolanaSignature } from "./solana.ts";
import { IntentError, type IntentErrorCode } from "./types.ts";
import { NONCE_PATTERN, checkAddress } from "./validate.ts";
import type { ChainConfig } from "./verify.ts";

/**
 * What a wallet signs to cancel one of its orders. It names the order by its chain and
 * nonce: the nonce is unique per (chain, wallet) (`orders` unique constraint), so it
 * designates exactly one order, ever, and a cancellation needs no nonce or expiry of
 * its own (replaying it cancels an order that is already cancelled).
 *
 * The cancellation is enforced off-chain only: the server takes the order out of the
 * book. Until `settle` verifies intents on-chain (spec §3.6), the on-chain guarantee
 * that a cancelled order never settles is the wallet revoking its delegate/allowance.
 *
 * Its version is its own: the cancellation names an order by nonce, which is the same for
 * every order intent version, so v1 cancels both v1 and v2 orders and did not change
 * when order intents gained `timeInForce`.
 */
export const CANCEL_VERSION = 1;

export interface CancelIntent {
  version: typeof CANCEL_VERSION;
  chain: keyof typeof CHAINS;
  /** Same program/contract as the order intent: Solana program id, EVM NiaraSettlement. */
  settlement: string;
  /** The order's wallet, and the signer. */
  wallet: string;
  /** The order intent's nonce (32 lowercase hex chars). */
  nonce: string;
}

/** Validates a cancellation and returns its canonical form (EVM addresses checksummed). */
export function validateCancelIntent(cancel: CancelIntent): CancelIntent {
  if (cancel.version !== CANCEL_VERSION) {
    throw new IntentError("unsupported_version", `cancel version must be ${CANCEL_VERSION}`);
  }
  if (!isChainId(cancel.chain)) throw new IntentError("unknown_chain", `unknown chain: ${String(cancel.chain)}`);
  const kind = CHAINS[cancel.chain].kind;
  const settlement = checkAddress(kind, "settlement", cancel.settlement);
  const wallet = checkAddress(kind, "wallet", cancel.wallet);
  if (typeof cancel.nonce !== "string" || !NONCE_PATTERN.test(cancel.nonce) || /^0+$/.test(cancel.nonce)) {
    throw new IntentError("invalid_nonce", "nonce must be 16 non-zero bytes as 32 lowercase hex chars");
  }
  return { version: cancel.version, chain: cancel.chain, settlement, wallet, nonce: cancel.nonce };
}

/** Parses a cancellation from client JSON; unknown fields are refused. */
export function parseCancelIntent(json: unknown): CancelIntent {
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new IntentError("malformed", "cancel must be an object");
  }
  const o = json as Record<string, unknown>;
  for (const key of Object.keys(o)) {
    if (!["version", "chain", "settlement", "wallet", "nonce"].includes(key)) {
      throw new IntentError("malformed", `unexpected field: ${key}`);
    }
  }
  return validateCancelIntent({
    version: o["version"] as typeof CANCEL_VERSION,
    chain: o["chain"] as CancelIntent["chain"],
    settlement: o["settlement"] as string,
    wallet: o["wallet"] as string,
    nonce: o["nonce"] as string,
  });
}

// ---------------------------------------------------------------------------
// Solana: signMessage text
// ---------------------------------------------------------------------------

/**
 * The exact text a Solana wallet signs to cancel: UTF-8, lines joined by "\n", no
 * trailing newline. Its first line differs from the order intent's, so neither text
 * can ever be taken for the other. As for orders, the verifier rebuilds the text from
 * the structured cancellation and never parses signed text.
 */
export function solanaCancelMessage(cancel: CancelIntent): Uint8Array {
  const c = validateCancelIntent(cancel);
  const chain = CHAINS[c.chain];
  if (chain.kind !== "solana") throw new IntentError("unknown_chain", `${c.chain} is not a Solana chain`);
  const lines = [
    `Niara Exchange cancel order v${c.version}`,
    "TESTNET ONLY: no real assets, no real money.",
    "",
    `Chain: ${chain.caip2}`,
    `Program: ${c.settlement}`,
    `Wallet: ${c.wallet}`,
    `Order nonce: ${c.nonce}`,
  ];
  return new TextEncoder().encode(lines.join("\n"));
}

export async function verifySolanaCancel(cancel: CancelIntent, signature: string): Promise<boolean> {
  const message = solanaCancelMessage(cancel);
  const sig = decodeSolanaSignature(signature);
  try {
    return await verifyAsync(sig, message, base58.decode(cancel.wallet), { zip215: false });
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// EVM: EIP-712
// ---------------------------------------------------------------------------

/** Same domain as `OrderIntent`; a distinct primary type, so the digests never collide. */
export const CANCEL_ORDER_TYPES = {
  CancelOrder: [
    { name: "wallet", type: "address" },
    { name: "nonce", type: "bytes16" },
  ],
} as const;

export const CANCEL_ORDER_TYPE = "CancelOrder(address wallet,bytes16 nonce)";

/** `keccak256(CANCEL_ORDER_TYPE)`, for a future Solidity verifier. */
export const CANCEL_ORDER_TYPEHASH = keccak256(toHex(CANCEL_ORDER_TYPE));

/**
 * EIP-712 typed data for `cancel`. Domain: name "Niara Exchange", version "1", the
 * chain's EIP-155 id, `verifyingContract` = the NiaraSettlement address.
 */
export function evmCancelTypedData(cancel: CancelIntent) {
  const c = validateCancelIntent(cancel);
  const chain = CHAINS[c.chain];
  if (chain.kind !== "evm" || chain.evmChainId === null) {
    throw new IntentError("unknown_chain", `${c.chain} is not an EVM chain`);
  }
  return {
    domain: {
      name: EIP712_DOMAIN_NAME,
      version: EIP712_DOMAIN_VERSION,
      chainId: chain.evmChainId,
      verifyingContract: getAddress(c.settlement),
    },
    types: CANCEL_ORDER_TYPES,
    primaryType: "CancelOrder" as const,
    message: { wallet: getAddress(c.wallet), nonce: `0x${c.nonce}` as Hex },
  };
}

export function evmCancelDigest(cancel: CancelIntent): Hex {
  return hashTypedData(evmCancelTypedData(cancel));
}

export async function verifyEvmCancel(cancel: CancelIntent, signature: string): Promise<boolean> {
  const typed = evmCancelTypedData(cancel);
  const sig = checkEvmSignatureFormat(signature);
  try {
    return (await recoverTypedDataAddress({ ...typed, signature: sig })) === typed.message.wallet;
  } catch {
    return false;
  }
}

/** Verifies `signature` over `cancel` with the scheme of the cancellation's chain. */
export async function verifyCancelSignature(cancel: CancelIntent, signature: string): Promise<boolean> {
  return CHAINS[validateCancelIntent(cancel).chain].kind === "solana"
    ? verifySolanaCancel(cancel, signature)
    : verifyEvmCancel(cancel, signature);
}

// ---------------------------------------------------------------------------
// Admission
// ---------------------------------------------------------------------------

export type CancelAdmissionRejectReason =
  | IntentErrorCode
  | "wrong_chain"
  | "chain_not_ready"
  | "wrong_settlement"
  | "bad_signature";

export type CancelAdmissionResult =
  | { ok: true; cancel: CancelIntent }
  | { ok: false; reason: CancelAdmissionRejectReason; detail: string };

/**
 * The server-side gate for cancellations: the chain's configuration, then the wallet's
 * signature. Finding the order (by chain, wallet and nonce) and checking it is live
 * are the order service's.
 */
export async function admitCancelIntent(args: {
  cancel: CancelIntent;
  signature: string;
  chain: ChainConfig;
}): Promise<CancelAdmissionResult> {
  const reject = (reason: CancelAdmissionRejectReason, detail: string): CancelAdmissionResult => ({
    ok: false,
    reason,
    detail,
  });
  let cancel: CancelIntent;
  try {
    cancel = validateCancelIntent(args.cancel);
  } catch (e) {
    if (e instanceof IntentError) return reject(e.code, e.message);
    throw e;
  }
  const { chain } = args;
  if (cancel.chain !== chain.chain) return reject("wrong_chain", `cancel is for ${cancel.chain}, config for ${chain.chain}`);
  if (chain.settlementProgram === null) return reject("chain_not_ready", `${chain.chain} has no settlement program`);
  const same = CHAINS[chain.chain].kind === "evm" ? getAddress(cancel.settlement) === getAddress(chain.settlementProgram) : cancel.settlement === chain.settlementProgram;
  if (!same) return reject("wrong_settlement", "cancel is signed for another program or contract");
  let valid: boolean;
  try {
    valid = await verifyCancelSignature(cancel, args.signature);
  } catch (e) {
    if (e instanceof IntentError) return reject(e.code, e.message);
    throw e;
  }
  if (!valid) return reject("bad_signature", "signature does not match the wallet and cancellation");
  return { ok: true, cancel };
}
