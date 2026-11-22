import { Keypair, SystemProgram } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import {
  FundingError,
  checkFundingBalances,
  checkFundingRequest,
  fundingInstructions,
  type FundingRequest,
} from "../../src/devnet/funding.ts";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  associatedTokenAddress,
  pdas,
} from "../../src/solana/accounts.ts";
import { approveChecked, createAssociatedTokenAccountIdempotent, transferChecked } from "../../src/solana/token-instructions.ts";

/** The devnet tester-funding plan and the SPL instructions it uses. Keys generated per run: no devnet keys. */

const key = () => Keypair.generate().publicKey;

function request(over: Partial<FundingRequest> = {}): FundingRequest {
  return {
    tester: key(),
    funder: key(),
    source: key(),
    usdt: { mint: key(), tokenProgram: TOKEN_2022_PROGRAM_ID, decimals: 6 },
    asset: { mint: key(), tokenProgram: TOKEN_2022_PROGRAM_ID, decimals: 0 },
    lamports: 200_000_000n,
    usdtAmount: 1_000_000_000n,
    assetAmount: 20n,
    forbidden: [],
    ...over,
  };
}

describe("SPL instructions", () => {
  const [source, mint, dest, owner] = [key(), key(), key(), key()];

  it("transfer_checked: tag 12, u64 LE amount, decimals; source and destination writable, owner signs", () => {
    const ix = transferChecked({ tokenProgram: TOKEN_2022_PROGRAM_ID, source, mint, destination: dest, owner, amount: 1_000_000_000n, decimals: 6 });
    expect(ix.programId.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
    expect([...ix.data]).toEqual([12, 0x00, 0xca, 0x9a, 0x3b, 0, 0, 0, 0, 6]);
    expect(ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable])).toEqual([
      [source.toBase58(), false, true],
      [mint.toBase58(), false, false],
      [dest.toBase58(), false, true],
      [owner.toBase58(), true, false],
    ]);
  });

  it("approve_checked: tag 13, the delegate read-only", () => {
    const delegate = pdas().vaultAuthority();
    const ix = approveChecked({ tokenProgram: TOKEN_PROGRAM_ID, source, mint, delegate, owner, amount: 10n, decimals: 0 });
    expect([...ix.data]).toEqual([13, 10, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(ix.keys[2]).toEqual({ pubkey: delegate, isSigner: false, isWritable: false });
  });

  it("refuses a zero or over-u64 amount and a program that is not a token program", () => {
    const base = { tokenProgram: TOKEN_PROGRAM_ID, source, mint, destination: dest, owner, decimals: 6 };
    expect(() => transferChecked({ ...base, amount: 0n })).toThrow(/positive u64/);
    expect(() => transferChecked({ ...base, amount: 1n << 64n })).toThrow(/positive u64/);
    expect(() => transferChecked({ ...base, tokenProgram: SYSTEM_PROGRAM_ID, amount: 1n })).toThrow(/not an SPL token program/);
  });

  it("create associated token account (idempotent): instruction 1, the derived address, payer signs", () => {
    const payer = key();
    const { instruction, address } = createAssociatedTokenAccountIdempotent({ payer, owner, mint, tokenProgram: TOKEN_2022_PROGRAM_ID });
    expect(address.equals(associatedTokenAddress(mint, owner, TOKEN_2022_PROGRAM_ID))).toBe(true);
    expect(instruction.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)).toBe(true);
    expect([...instruction.data]).toEqual([1]);
    expect(instruction.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable])).toEqual([
      [payer.toBase58(), true, true],
      [address.toBase58(), false, true],
      [owner.toBase58(), false, false],
      [mint.toBase58(), false, false],
      [SYSTEM_PROGRAM_ID.toBase58(), false, false],
      [TOKEN_2022_PROGRAM_ID.toBase58(), false, false],
    ]);
  });
});

describe("funding plan", () => {
  it("sends SOL, creates both token accounts, then moves mockUSDT and tEQTY from the source", () => {
    const r = request();
    const { instructions, accounts } = fundingInstructions(r);
    expect(instructions.map((i) => i.programId.toBase58())).toEqual([
      SystemProgram.programId.toBase58(),
      ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(),
      ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(),
      TOKEN_2022_PROGRAM_ID.toBase58(),
      TOKEN_2022_PROGRAM_ID.toBase58(),
    ]);
    expect(accounts.testerUsdt.equals(associatedTokenAddress(r.usdt.mint, r.tester, r.usdt.tokenProgram))).toBe(true);
    expect(accounts.sourceAsset.equals(associatedTokenAddress(r.asset.mint, r.source, r.asset.tokenProgram))).toBe(true);
    // The token transfers go from the source's accounts to the tester's, signed by the source.
    expect(instructions[3]!.keys[0]!.pubkey.equals(accounts.sourceUsdt)).toBe(true);
    expect(instructions[3]!.keys[2]!.pubkey.equals(accounts.testerUsdt)).toBe(true);
    expect(instructions[4]!.keys[3]).toMatchObject({ pubkey: r.source, isSigner: true });
    expect([...instructions[4]!.data]).toEqual([12, 20, 0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("refuses a PDA, one of our own keys, and amounts out of bounds", () => {
    expect(() => checkFundingRequest(request({ tester: pdas().vaultAuthority() }))).toThrow(/off curve/);
    const own = key();
    expect(() => checkFundingRequest(request({ tester: own, forbidden: [own] }))).toThrow(/demo or operator keys/);
    expect(() => checkFundingRequest(request({ lamports: 0n }))).toThrow(FundingError);
    expect(() => checkFundingRequest(request({ lamports: 1_000_000_001n }))).toThrow(/at most 1/);
    expect(() => checkFundingRequest(request({ usdtAmount: 10_000_000_001n }))).toThrow(/at most 10000/);
    expect(() => checkFundingRequest(request({ assetAmount: 101n }))).toThrow(/at most 100/);
    expect(() => checkFundingRequest(request())).not.toThrow();
  });

  it("refuses when the funder or the source cannot cover it", () => {
    const r = request();
    const ok = { funderLamports: 220_000_000n, sourceUsdt: 1_000_000_000n, sourceAsset: 20n };
    expect(() => checkFundingBalances(r, ok)).not.toThrow();
    expect(() => checkFundingBalances(r, { ...ok, funderLamports: 219_999_999n })).toThrow(/demo funder/);
    expect(() => checkFundingBalances(r, { ...ok, sourceUsdt: 999_999_999n })).toThrow(/mockUSDT/);
    expect(() => checkFundingBalances(r, { ...ok, sourceAsset: null })).toThrow(/no tEQTY/);
  });
});
