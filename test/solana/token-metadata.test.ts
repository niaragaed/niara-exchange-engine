import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { decodeToken2022Metadata } from "../../src/solana/accounts.ts";
import { NAME_MAX, SYMBOL_MAX, cleanMetadata, cleanMetadataText } from "../../src/sync/metadata.ts";
import { mintData, token2022MintData } from "./mock-rpc.ts";

/** Token-2022 TokenMetadata decoding and the stored form of symbol and name. Keys generated per run. */

describe("decodeToken2022Metadata", () => {
  const mint = Keypair.generate().publicKey;

  it("reads name and symbol after other extensions", () => {
    const data = token2022MintData(6, mint, { name: "Test Demo Equity", symbol: "tEQTY", uri: "https://example.invalid/meta.json" });
    expect(decodeToken2022Metadata(data, mint)).toEqual({ name: "Test Demo Equity", symbol: "tEQTY" });
  });

  it("reads UTF-8", () => {
    expect(decodeToken2022Metadata(token2022MintData(0, mint, { name: "Ação Teste", symbol: "AÇÃO" }), mint)).toEqual({
      name: "Ação Teste",
      symbol: "AÇÃO",
    });
  });

  it("is null for a classic mint, and for a Token-2022 mint without the extension", () => {
    expect(decodeToken2022Metadata(mintData(6), mint)).toBeNull();
    const bare = new Uint8Array(170);
    bare[45] = 1;
    bare[165] = 1; // a mint; TLV area all zeros (Uninitialized)
    expect(decodeToken2022Metadata(bare, mint)).toBeNull();
    const account = token2022MintData(6, mint, { name: "n", symbol: "s" });
    account[165] = 2; // AccountType::Account: a token account, not a mint
    expect(decodeToken2022Metadata(account, mint)).toBeNull();
  });

  it("refuses metadata naming another mint, truncated data and invalid UTF-8", () => {
    const other = Keypair.generate().publicKey;
    expect(() => decodeToken2022Metadata(token2022MintData(6, mint, { name: "n", symbol: "s", metadataMint: other }), mint)).toThrow(
      /another mint/,
    );
    const full = token2022MintData(6, mint, { name: "Test Demo Equity", symbol: "tEQTY" });
    expect(() => decodeToken2022Metadata(full.subarray(0, full.length - 10), mint)).toThrow(RangeError);
    const bad = token2022MintData(6, mint, { name: "ab", symbol: "s" });
    // From the end: additional_metadata (4), uri (4 + 0), symbol (4 + 1), then the name's 2 bytes.
    const nameAt = bad.length - (4 + 4 + 5 + 2);
    expect(bad[nameAt]).toBe("a".charCodeAt(0));
    bad[nameAt] = 0xff; // an invalid UTF-8 lead byte
    expect(() => decodeToken2022Metadata(bad, mint)).toThrow(TypeError);
  });
});

describe("stored metadata text", () => {
  it("trims, keeps null for absent or empty values, and refuses control characters and long values", () => {
    expect(cleanMetadataText("  tEQTY ", SYMBOL_MAX)).toEqual({ value: "tEQTY", refused: false });
    expect(cleanMetadataText(null, SYMBOL_MAX)).toEqual({ value: null, refused: false });
    expect(cleanMetadataText("   ", SYMBOL_MAX)).toEqual({ value: null, refused: false });
    expect(cleanMetadataText("t\u0000EQTY", SYMBOL_MAX)).toEqual({ value: null, refused: true });
    expect(cleanMetadataText("t\u0085EQTY", SYMBOL_MAX)).toEqual({ value: null, refused: true });
    expect(cleanMetadataText("x".repeat(SYMBOL_MAX), SYMBOL_MAX).value).toHaveLength(SYMBOL_MAX);
    expect(cleanMetadataText("x".repeat(SYMBOL_MAX + 1), SYMBOL_MAX)).toEqual({ value: null, refused: true });
    // Characters, not UTF-16 units or bytes, as Postgres char_length counts them.
    expect(cleanMetadataText("😀".repeat(NAME_MAX), NAME_MAX).value).not.toBeNull();
  });

  it("reports each refused field", () => {
    const r = cleanMetadata({ symbol: "x".repeat(40), name: "Test Name" }, "ASSET");
    expect(r.metadata).toEqual({ symbol: null, name: "Test Name" });
    expect(r.warnings).toEqual([expect.stringMatching(/^ASSET: on-chain symbol not stored/)]);
  });
});
