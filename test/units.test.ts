import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { formatUnits, parseUnits } from "../src/units.ts";

describe("parseUnits / formatUnits", () => {
  it("converts decimal text to base units exactly", () => {
    expect(parseUnits("1000", 6)).toBe(1_000_000_000n);
    expect(parseUnits("0.2", 9)).toBe(200_000_000n);
    expect(parseUnits("25.5", 6)).toBe(25_500_000n);
    expect(parseUnits("20", 0)).toBe(20n);
    expect(parseUnits(" 7 ", 2)).toBe(700n);
  });

  it("refuses signs, exponents, empty parts and excess decimals", () => {
    for (const bad of ["-1", "+1", "1e3", "", ".5", "5.", "1,5", "0x10", "NaN"]) expect(() => parseUnits(bad, 6), bad).toThrow(RangeError);
    expect(() => parseUnits("0.0000001", 6)).toThrow(/more than 6 decimal places/);
    expect(() => parseUnits("1.5", 0)).toThrow(/more than 0/);
  });

  it("formats base units, trimming trailing zeros", () => {
    expect(formatUnits(25_500_000n, 6)).toBe("25.5");
    expect(formatUnits(1_000_000_000n, 6)).toBe("1000");
    expect(formatUnits(5n, 6)).toBe("0.000005");
    expect(formatUnits(20n, 0)).toBe("20");
    expect(formatUnits(-1_250_000n, 6)).toBe("-1.25");
  });

  it("round-trips", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 30n }), fc.integer({ min: 0, max: 18 }), (v, d) => parseUnits(formatUnits(v, d), d) === v),
    );
  });
});
