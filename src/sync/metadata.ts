/**
 * Token metadata (symbol, name) as the listing syncs store it in `listings.symbol` and
 * `listings.name` (migration 20261122120000): display only, never trusted for identity.
 * TESTNET ONLY.
 */

export const SYMBOL_MAX = 32;
export const NAME_MAX = 128;

export interface TokenMetadata {
  symbol: string | null;
  name: string | null;
}

// Control characters (C0, DEL, C1): refused by the table check too.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * A metadata string as stored: trimmed; null when absent, empty, longer than `max`
 * characters, or holding control characters (the migration's checks). `refused` tells
 * a value that was published but not stored, for the sync's report.
 */
export function cleanMetadataText(raw: string | null | undefined, max: number): { value: string | null; refused: boolean } {
  if (raw === null || raw === undefined) return { value: null, refused: false };
  const v = raw.trim();
  if (v === "") return { value: null, refused: false };
  if (CONTROL.test(v) || [...v].length > max) return { value: null, refused: true };
  return { value: v, refused: false };
}

/** Cleans both fields; `warnings` names each refused one. */
export function cleanMetadata(raw: { symbol: string | null; name: string | null }, asset: string): { metadata: TokenMetadata; warnings: string[] } {
  const symbol = cleanMetadataText(raw.symbol, SYMBOL_MAX);
  const name = cleanMetadataText(raw.name, NAME_MAX);
  const warnings: string[] = [];
  if (symbol.refused) warnings.push(`${asset}: on-chain symbol not stored (over ${SYMBOL_MAX} characters, or control characters)`);
  if (name.refused) warnings.push(`${asset}: on-chain name not stored (over ${NAME_MAX} characters, or control characters)`);
  return { metadata: { symbol: symbol.value, name: name.value }, warnings };
}
