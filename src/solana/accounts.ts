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

/** SPL Token-2022: account type byte after the 165-byte base, then TLV extensions. */
const TOKEN_2022_ACCOUNT_TYPE_OFFSET = 165;
const TOKEN_2022_ACCOUNT_TYPE_MINT = 1;
/** ExtensionType::TokenMetadata (spl-token-2022), the metadata stored in the mint itself. */
const EXTENSION_TOKEN_METADATA = 19;

/**
 * The name and symbol of a Token-2022 mint's TokenMetadata extension (the metadata kept
 * in the mint account itself), or null when the mint has none: a classic SPL Token mint
 * (82 bytes), a Token-2022 mint without the extension, or metadata stored in another
 * account (MetadataPointer elsewhere, Metaplex), which is not read. The extension's own
 * `mint` field must be `mint`. Throws on a malformed extension.
 *
 * Layout: TLV entries `type: u16 LE, length: u16 LE, value` from byte 166; TokenMetadata
 * is Borsh `update_authority [32], mint [32], name: string, symbol: string, uri: string,
 * additional_metadata: Vec<(string, string)>` (strings: u32 LE length + UTF-8).
 */
export function decodeToken2022Metadata(data: Uint8Array, mint: PublicKey): { name: string; symbol: string } | null {
  if (data.length <= TOKEN_2022_ACCOUNT_TYPE_OFFSET) return null;
  if (data[TOKEN_2022_ACCOUNT_TYPE_OFFSET] !== TOKEN_2022_ACCOUNT_TYPE_MINT) return null;
  const dv = new DataView(data.buffer, data.byteOffset, data.length);
  let at = TOKEN_2022_ACCOUNT_TYPE_OFFSET + 1;
  while (at + 4 <= data.length) {
    const type = dv.getUint16(at, true);
    const length = dv.getUint16(at + 2, true);
    if (type === 0) return null; // Uninitialized: the rest is padding
    const start = at + 4;
    const end = start + length;
    if (end > data.length) throw new RangeError("Token-2022 extension runs past the account");
    if (type === EXTENSION_TOKEN_METADATA) {
      const value = data.subarray(start, end);
      if (value.length < 64) throw new RangeError("TokenMetadata too short");
      if (!new PublicKey(value.subarray(32, 64)).equals(mint)) throw new RangeError("TokenMetadata names another mint");
      const vv = new DataView(value.buffer, value.byteOffset, value.length);
      let p = 64;
      const str = (): string => {
        if (p + 4 > value.length) throw new RangeError("TokenMetadata string runs past the extension");
        const n = vv.getUint32(p, true);
        if (p + 4 + n > value.length) throw new RangeError("TokenMetadata string runs past the extension");
        const s = new TextDecoder("utf-8", { fatal: true }).decode(value.subarray(p + 4, p + 4 + n));
        p += 4 + n;
        return s;
      };
      const name = str();
      const symbol = str();
      return { name, symbol };
    }
    at = end;
  }
  return null;
}
