/**
 * Decimal text <-> integer base units, exactly (bigint; never floats). Used by the
 * scripts' command-line amounts ("1000", "0.2", "25.5").
 */

/** "25.5" with 6 decimals -> 25500000n. Refuses signs, exponents, empty parts and excess decimals. */
export function parseUnits(text: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new RangeError("decimals must be 0..255");
  const m = /^([0-9]+)(?:\.([0-9]+))?$/.exec(text.trim());
  if (!m) throw new RangeError(`not a decimal amount: ${JSON.stringify(text)}`);
  const whole = m[1]!;
  const frac = m[2] ?? "";
  if (frac.length > decimals) throw new RangeError(`${text} has more than ${decimals} decimal places`);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
}

/** 25500000n with 6 decimals -> "25.5" (trailing zeros trimmed). */
export function formatUnits(value: bigint, decimals: number): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  if (decimals === 0) return `${negative ? "-" : ""}${abs}`;
  const s = abs.toString().padStart(decimals + 1, "0");
  const frac = s.slice(-decimals).replace(/0+$/, "");
  return `${negative ? "-" : ""}${s.slice(0, -decimals)}${frac ? `.${frac}` : ""}`;
}
