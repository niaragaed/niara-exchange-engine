import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  associatedTokenAddress,
  decodeConfig,
  decodeListing,
  decodeMintDecimals,
  decodeTokenAccount,
  pdas,
} from "../../src/solana/accounts.ts";
import { encodeFields } from "../../src/solana/borsh.ts";
import { IDL, IDL_PATH, PROGRAM_ID, idlInstruction } from "../../src/solana/idl.ts";
import { SettlementFailure, isTransientRpcError, mapTransactionError } from "../../src/solana/errors.ts";
import { assertDevnet } from "../../src/solana/rpc.ts";
import { configData, listingData, mintData, mockRpc, tokenAccountData } from "./mock-rpc.ts";

const SOLANA_REPO_IDL = join(homedir(), "niara-exchange-solana", "target", "idl", "niara_exchange.json");

describe("vendored IDL", () => {
  it.skipIf(!existsSync(SOLANA_REPO_IDL))("equals the Solana repo's build", () => {
    expect(readFileSync(IDL_PATH, "utf8")).toBe(readFileSync(SOLANA_REPO_IDL, "utf8"));
  });

  it("is the devnet program, with settle(match_id: [u8; 16], asset_amount: u64, payment_amount: u64)", () => {
    expect(PROGRAM_ID.toBase58()).toBe("B311xH3PcEx86gdRbuinrGrh1r9G2qzjDCji8uc6eD9v");
    const settle = idlInstruction("settle");
    expect(settle.args).toEqual([
      { name: "match_id", type: { array: ["u8", 16] } },
      { name: "asset_amount", type: "u64" },
      { name: "payment_amount", type: "u64" },
    ]);
    expect(settle.accounts.at(-2)?.name).toBe("event_authority");
    expect(IDL.errors.find((e) => e.code === 6025)?.name).toBe("DelegateNotSet");
  });
});

describe("program addresses", () => {
  it("knows the token programs", () => {
    expect(TOKEN_PROGRAM_ID.toBase58()).toBe("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
    expect(TOKEN_2022_PROGRAM_ID.toBase58()).toBe("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
    expect(ASSOCIATED_TOKEN_PROGRAM_ID.toBase58()).toBe("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
  });

  it("derives the devnet deployment's PDAs (deployment.json)", () => {
    const p = pdas();
    expect(p.config().toBase58()).toBe("HRbQRCDQDRe4BxfRJfPaywyqeWks9SjoH9jpMsRJDAFE");
    expect(p.vaultAuthority().toBase58()).toBe("84kn8YgJXxTVSRkBuNXLtxmeHDUiBMSSVzfgqzGmuu8U");
    const usdt = new PublicKey("8iWQ7VxYrkUv471vEoZ664eLwDzWinPiCJpRvcTUA24y");
    expect(p.feeVault(usdt).toBase58()).toBe("2A7HdMHydgPvjxrZgU2XEHPCKxhJkkp7eA1JfhWajqCE");
    expect(p.feeLedger(usdt).toBase58()).toBe("FVpx3pynbAiTDmAeCEco7ug4XRf4Pcb1jKeQj5LU4Qf");
    expect(p.listing(usdt).toBase58()).toBe("3akRnDyay46DHopQzEJrcAybki99LKyjVM2YhyhisYNy");
  });

  it("derives associated token accounts per token program", () => {
    const mint = Keypair.generate().publicKey;
    const owner = Keypair.generate().publicKey;
    expect(associatedTokenAddress(mint, owner, TOKEN_2022_PROGRAM_ID)).not.toEqual(
      associatedTokenAddress(mint, owner, TOKEN_PROGRAM_ID),
    );
  });
});

describe("account decoding", () => {
  it("decodes Config and Listing from their IDL layouts, and refuses another account", () => {
    const op = Keypair.generate().publicKey;
    const fee = Keypair.generate().publicKey;
    expect(decodeConfig(configData({ settlementOperator: op, feeMint: fee, paused: true }))).toEqual({
      settlementOperator: op,
      feeMint: fee,
      feeBps: 50,
      cashbackBps: 2000,
      paused: true,
    });
    const mint = Keypair.generate().publicKey;
    const l = decodeListing(listingData({ mint, assetClass: "Equity", status: "Quoted" }));
    expect([l.assetMint, l.assetClass, l.status, l.cashbackEligible]).toEqual([mint, "Equity", "Quoted", true]);
    expect(() => decodeListing(configData({ settlementOperator: op, feeMint: fee }))).toThrow(/discriminator/);
  });

  it("decodes token accounts (delegate, delegated amount) and mint decimals", () => {
    const mint = Keypair.generate().publicKey;
    const owner = Keypair.generate().publicKey;
    const delegate = Keypair.generate().publicKey;
    expect(decodeTokenAccount(tokenAccountData({ mint, owner, amount: 900n, delegate, delegatedAmount: 10n }))).toEqual({
      mint,
      owner,
      amount: 900n,
      delegate,
      state: 1,
      delegatedAmount: 10n,
    });
    expect(decodeTokenAccount(tokenAccountData({ mint, owner, amount: 5n })).delegate).toBeNull();
    expect(decodeMintDecimals(mintData(6))).toBe(6);
    expect(() => decodeTokenAccount(new Uint8Array(10))).toThrow(/too short/);
  });

  it("encodes u64 little-endian and refuses out-of-range values", () => {
    const fields = idlInstruction("settle").args;
    const bytes = encodeFields(fields, { match_id: new Uint8Array(16).fill(1), asset_amount: 10n, payment_amount: 258n });
    expect(Array.from(bytes.subarray(16, 24))).toEqual([10, 0, 0, 0, 0, 0, 0, 0]);
    expect(Array.from(bytes.subarray(24, 26))).toEqual([2, 1]);
    expect(() => encodeFields(fields, { match_id: new Uint8Array(16), asset_amount: 1n << 64n, payment_amount: 1n })).toThrow(
      /u64/,
    );
    expect(() => encodeFields(fields, { match_id: new Uint8Array(15), asset_amount: 1n, payment_amount: 1n })).toThrow(
      /16 bytes/,
    );
  });
});

describe("errors and cluster", () => {
  it("maps program errors from the IDL, Anchor constraint logs, operator funds and the replay guard", () => {
    const delegate = mapTransactionError({ InstructionError: [0, { Custom: 6025 }] }, []);
    expect(delegate).toBeInstanceOf(SettlementFailure);
    expect((delegate as SettlementFailure).message).toMatch(/DelegateNotSet \(6025\): Token account has not delegated/);
    expect((delegate as SettlementFailure).transient).toBe(false);
    const constraint = mapTransactionError({ InstructionError: [0, { Custom: 3012 }] }, [
      "Program log: AnchorError caused by account: cashback_ledger. Error Code: AccountNotInitialized. Error Number: 3012. Error Message: The program expected this account to be already initialized.",
    ]);
    expect(constraint).toMatchObject({ kind: "account", code: 3012, errorName: "AccountNotInitialized" });
    expect(mapTransactionError({ InstructionError: [0, { Custom: 0 }] }, [
      "Allocate: account Address { address: X, base: None } already in use",
    ])).toBe("already_settled");
    expect(mapTransactionError("InsufficientFundsForFee", [])).toMatchObject({ kind: "operator_funds" });
  });

  it("classifies transient RPC errors", () => {
    for (const m of ["429 Too Many Requests", "fetch failed", "Blockhash not found", "block height exceeded", "ETIMEDOUT"]) {
      expect(isTransientRpcError(new Error(m))).toBe(true);
    }
    expect(isTransientRpcError(new Error("custom program error: 0x1789"))).toBe(false);
  });

  it("refuses any cluster but devnet", async () => {
    const rpc = mockRpc();
    await expect(assertDevnet(rpc)).resolves.toBeUndefined();
    rpc.genesis = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"; // mainnet-beta
    await expect(assertDevnet(rpc)).rejects.toThrow(/not devnet/);
  });
});
