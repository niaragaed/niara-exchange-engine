import { getAddress, hashTypedData, isHex, keccak256, recoverTypedDataAddress, toHex, type Hex, type TypedDataDefinition } from "viem";
import { CHAINS } from "../chains.ts";
import { IntentError, type OrderIntent } from "./types.ts";
import { validateIntent } from "./validate.ts";

export const EIP712_DOMAIN_NAME = "Niara Exchange";
export const EIP712_DOMAIN_VERSION = "1";

/** Field order is part of the type hash: never reorder. `side`: 0 = buy, 1 = sell. v1 intents. */
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

/**
 * v2 intents: v1's fields, then `timeInForce` (0 = GTC, 1 = IOC). Same primary type name
 * and domain; the type hash differs, so a v1 and a v2 digest never coincide.
 */
export const ORDER_INTENT_V2_TYPES = {
  OrderIntent: [...ORDER_INTENT_TYPES.OrderIntent, { name: "timeInForce", type: "uint8" }],
} as const;

/**
 * v3 intents (iceberg): v2's fields, then `displayQuantity` (asset base units shown in the
 * book at a time). Same primary type name and domain; a third type hash.
 */
export const ORDER_INTENT_V3_TYPES = {
  OrderIntent: [...ORDER_INTENT_V2_TYPES.OrderIntent, { name: "displayQuantity", type: "uint256" }],
} as const;

export const ORDER_INTENT_TYPE =
  "OrderIntent(address wallet,uint8 side,address asset,uint256 quantity,uint256 lotSize," +
  "uint256 limitPrice,address paymentAsset,bytes16 nonce,uint64 expiresAt)";

export const ORDER_INTENT_V2_TYPE =
  "OrderIntent(address wallet,uint8 side,address asset,uint256 quantity,uint256 lotSize," +
  "uint256 limitPrice,address paymentAsset,bytes16 nonce,uint64 expiresAt,uint8 timeInForce)";

export const ORDER_INTENT_V3_TYPE =
  "OrderIntent(address wallet,uint8 side,address asset,uint256 quantity,uint256 lotSize," +
  "uint256 limitPrice,address paymentAsset,bytes16 nonce,uint64 expiresAt,uint8 timeInForce,uint256 displayQuantity)";

/** `keccak256(ORDER_INTENT_TYPE)` (v1), for the Solidity verifier. */
export const ORDER_INTENT_TYPEHASH = keccak256(toHex(ORDER_INTENT_TYPE));
/** `keccak256(ORDER_INTENT_V2_TYPE)`, for the Solidity verifier. */
export const ORDER_INTENT_V2_TYPEHASH = keccak256(toHex(ORDER_INTENT_V2_TYPE));
/** `keccak256(ORDER_INTENT_V3_TYPE)`, for the Solidity verifier. */
export const ORDER_INTENT_V3_TYPEHASH = keccak256(toHex(ORDER_INTENT_V3_TYPE));

// secp256k1 group order / 2: signatures with a larger s are rejected, as OpenZeppelin's
// ECDSA does, so each intent has one valid signature encoding.
const SECP256K1_HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

/**
 * EIP-712 typed data for `intent`, with the v1, v2 or v3 type by `intent.version`. Domain:
 * name "Niara Exchange", version "1", the chain's EIP-155 id, and `verifyingContract` =
 * the NiaraSettlement address (unchanged in v2 and v3: the contract did not change).
 */
export function evmIntentTypedData(intent: OrderIntent): TypedDataDefinition {
  const i = validateIntent(intent);
  const chain = CHAINS[i.chain];
  if (chain.kind !== "evm" || chain.evmChainId === null) {
    throw new IntentError("unknown_chain", `${i.chain} is not an EVM chain`);
  }
  const domain = {
    name: EIP712_DOMAIN_NAME,
    version: EIP712_DOMAIN_VERSION,
    chainId: chain.evmChainId,
    verifyingContract: getAddress(i.settlement),
  };
  const message = {
    wallet: getAddress(i.wallet),
    side: i.side === "buy" ? 0 : 1,
    asset: getAddress(i.asset),
    quantity: i.quantity,
    lotSize: i.lotSize,
    limitPrice: i.limitPrice,
    paymentAsset: getAddress(i.paymentAsset),
    nonce: `0x${i.nonce}` as Hex,
    expiresAt: BigInt(i.expiresAt),
  };
  if (i.version === 1) return { domain, types: ORDER_INTENT_TYPES, primaryType: "OrderIntent" as const, message };
  const v2 = { ...message, timeInForce: i.timeInForce === "IOC" ? 1 : 0 };
  if (i.version === 2) return { domain, types: ORDER_INTENT_V2_TYPES, primaryType: "OrderIntent" as const, message: v2 };
  return {
    domain,
    types: ORDER_INTENT_V3_TYPES,
    primaryType: "OrderIntent" as const,
    message: { ...v2, displayQuantity: i.displayQuantity! },
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
