import { getAddress, hashTypedData, isHex, keccak256, recoverTypedDataAddress, toHex, type Hex } from "viem";
import { CHAINS } from "../chains.ts";
import { IntentError, type OrderIntent } from "./types.ts";
import { validateIntent } from "./validate.ts";

export const EIP712_DOMAIN_NAME = "Niara Exchange";
export const EIP712_DOMAIN_VERSION = "1";

/** Field order is part of the type hash: never reorder. `side`: 0 = buy, 1 = sell. */
export const ORDER_INTENT_TYPES = {
  OrderIntent: [
    { name: "wallet", type: "address" },
    { name: "side", type: "uint8" },
    { name: "asset", type: "address" },
    { name: "quantity", type: "uint256" },
    { name: "lotSize", type: "uint256" },
    { name: "limitPrice", type: "uint256" },
    { name: "paymentAsset", type: "address" },
    { name: "nonce", type: "bytes16" },
    { name: "expiresAt", type: "uint64" },
  ],
} as const;

export const ORDER_INTENT_TYPE =
  "OrderIntent(address wallet,uint8 side,address asset,uint256 quantity,uint256 lotSize," +
  "uint256 limitPrice,address paymentAsset,bytes16 nonce,uint64 expiresAt)";

/** `keccak256(ORDER_INTENT_TYPE)`, for the Solidity verifier. */
export const ORDER_INTENT_TYPEHASH = keccak256(toHex(ORDER_INTENT_TYPE));

// secp256k1 group order / 2: signatures with a larger s are rejected, as OpenZeppelin's
// ECDSA does, so each intent has one valid signature encoding.
const SECP256K1_HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

/**
 * EIP-712 typed data for `intent`. Domain: name "Niara Exchange", version "1", the
 * chain's EIP-155 id, and `verifyingContract` = the NiaraSettlement address.
 */
export function evmIntentTypedData(intent: OrderIntent) {
  const i = validateIntent(intent);
  const chain = CHAINS[i.chain];
  if (chain.kind !== "evm" || chain.evmChainId === null) {
    throw new IntentError("unknown_chain", `${i.chain} is not an EVM chain`);
  }
  return {
    domain: {
      name: EIP712_DOMAIN_NAME,
      version: EIP712_DOMAIN_VERSION,
      chainId: chain.evmChainId,
      verifyingContract: getAddress(i.settlement),
    },
    types: ORDER_INTENT_TYPES,
    primaryType: "OrderIntent" as const,
    message: {
      wallet: getAddress(i.wallet),
      side: i.side === "buy" ? 0 : 1,
      asset: getAddress(i.asset),
      quantity: i.quantity,
      lotSize: i.lotSize,
      limitPrice: i.limitPrice,
      paymentAsset: getAddress(i.paymentAsset),
      nonce: `0x${i.nonce}` as Hex,
      expiresAt: BigInt(i.expiresAt),
    },
  };
}

export function evmIntentDigest(intent: OrderIntent): Hex {
  return hashTypedData(evmIntentTypedData(intent));
}

/** Checks the 65-byte `r || s || v` encoding, v in {27, 28}, low s. */
export function checkEvmSignatureFormat(signature: string): Hex {
  if (!isHex(signature, { strict: true }) || signature.length !== 2 + 65 * 2) {
    throw new IntentError("invalid_signature_format", "signature must be 65 bytes of 0x hex (r, s, v)");
  }
  const s = BigInt(`0x${signature.slice(66, 130)}`);
  const v = Number.parseInt(signature.slice(130, 132), 16);
  if (v !== 27 && v !== 28) throw new IntentError("invalid_signature_format", "v must be 27 or 28");
  if (s === 0n || s > SECP256K1_HALF_N) throw new IntentError("invalid_signature_format", "s must be in the lower half order");
  return signature;
}

/** True when `signature` recovers to `intent.wallet` over the intent's EIP-712 digest. */
export async function verifyEvmIntent(intent: OrderIntent, signature: string): Promise<boolean> {
  const typed = evmIntentTypedData(intent);
  const sig = checkEvmSignatureFormat(signature);
  try {
    const signer = await recoverTypedDataAddress({ ...typed, signature: sig });
    return signer === typed.message.wallet;
  } catch {
    return false;
  }
}
