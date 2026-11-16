import { PublicKey } from "@solana/web3.js";
import { decodeWithDiscriminator } from "./borsh.ts";
import { PROGRAM_ID, accountDiscriminator } from "./idl.ts";

/**
 * Program addresses (spec §3.2) and decoded accounts of `niara_exchange`, plus the SPL
 * token account and mint layouts (identical in Token and Token-2022 for the base
 * fields; Token-2022 extensions come after byte 165 / 82).
 */

export const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
export const SYSTEM_PROGRAM_ID = new PublicKey("11111111111111111111111111111111");

const seed = (s: string) => new TextEncoder().encode(s);
const find = (programId: PublicKey, ...seeds: Uint8Array[]) => PublicKey.findProgramAddressSync(seeds, programId)[0];

export function pdas(programId: PublicKey = PROGRAM_ID) {
  return {
    config: () => find(programId, seed("config")),
    vaultAuthority: () => find(programId, seed("vault")),
    listing: (mint: PublicKey) => find(programId, seed("listing"), mint.toBytes()),
    feeLedger: (feeMint: PublicKey) => find(programId, seed("fees"), feeMint.toBytes()),
    feeVault: (feeMint: PublicKey) => find(programId, seed("fee_vault"), feeMint.toBytes()),
    cashbackLedger: (listing: PublicKey, feeMint: PublicKey) =>
      find(programId, seed("cashback"), listing.toBytes(), feeMint.toBytes()),
    settlementRecord: (matchId: Uint8Array) => find(programId, seed("settled"), matchId),
    /** Anchor `#[event_cpi]` authority. */
    eventAuthority: () => find(programId, seed("__event_authority")),
  };
}

export function associatedTokenAddress(mint: PublicKey, owner: PublicKey, tokenProgram: PublicKey): PublicKey {
  return find(ASSOCIATED_TOKEN_PROGRAM_ID, owner.toBytes(), tokenProgram.toBytes(), mint.toBytes());
}

export function isTokenProgram(owner: PublicKey): boolean {
  return owner.equals(TOKEN_PROGRAM_ID) || owner.equals(TOKEN_2022_PROGRAM_ID);
}

// ---------------------------------------------------------------------------
// niara_exchange accounts
// ---------------------------------------------------------------------------

export interface ConfigAccount {
  settlementOperator: PublicKey;
  feeMint: PublicKey;
  feeBps: number;
  cashbackBps: number;
  paused: boolean;
}

export function decodeConfig(data: Uint8Array): ConfigAccount {
  const c = decodeWithDiscriminator("Config", accountDiscriminator("Config"), data);
  return {
    settlementOperator: c["settlement_operator"] as PublicKey,
    feeMint: c["fee_mint"] as PublicKey,
    feeBps: c["fee_bps"] as number,
    cashbackBps: c["cashback_bps"] as number,
    paused: c["paused"] as boolean,
  };
}

export type OnChainAssetClass = "Equity" | "FixedIncome" | "Credit" | "Currency";
export type OnChainListingStatus = "Pending" | "Approved" | "Suspended" | "Delisted" | "Quoted";

export interface ListingAccount {
  assetMint: PublicKey;
  issuer: PublicKey;
  assetClass: OnChainAssetClass;
  status: OnChainListingStatus;
  cashbackEligible: boolean;
  docHash: Uint8Array;
}

export const LISTING_DISCRIMINATOR = accountDiscriminator("Listing");

export function decodeListing(data: Uint8Array): ListingAccount {
  const l = decodeWithDiscriminator("Listing", LISTING_DISCRIMINATOR, data);
  return {
    assetMint: l["asset_mint"] as PublicKey,
    issuer: l["issuer"] as PublicKey,
    assetClass: l["asset_class"] as OnChainAssetClass,
    status: l["status"] as OnChainListingStatus,
    cashbackEligible: l["cashback_eligible"] as boolean,
    docHash: l["doc_hash"] as Uint8Array,
  };
}

// ---------------------------------------------------------------------------
// SPL token layouts (base part, same in Token and Token-2022)
// ---------------------------------------------------------------------------

export interface TokenAccount {
  mint: PublicKey;
  owner: PublicKey;
  amount: bigint;
  delegate: PublicKey | null;
  /** 0 = uninitialized, 1 = initialized, 2 = frozen. */
  state: number;
  delegatedAmount: bigint;
}

export function decodeTokenAccount(data: Uint8Array): TokenAccount {
  if (data.length < 165) throw new RangeError("not a token account: too short");
  const dv = new DataView(data.buffer, data.byteOffset, data.length);
  const hasDelegate = dv.getUint32(72, true);
  if (hasDelegate > 1) throw new RangeError("not a token account: bad delegate option");
  return {
    mint: new PublicKey(data.subarray(0, 32)),
    owner: new PublicKey(data.subarray(32, 64)),
    amount: dv.getBigUint64(64, true),
    delegate: hasDelegate === 1 ? new PublicKey(data.subarray(76, 108)) : null,
    state: data[108]!,
    delegatedAmount: dv.getBigUint64(121, true),
  };
}

/** Decimals of an SPL mint (byte 44 of the base mint layout). */
export function decodeMintDecimals(data: Uint8Array): number {
  if (data.length < 82) throw new RangeError("not a mint: too short");
  if (data[45] !== 1) throw new RangeError("mint is not initialized");
  return data[44]!;
}
