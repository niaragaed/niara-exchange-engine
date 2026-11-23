import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { SolanaSettlementAdapter } from "../../src/adapters/solana-adapter.ts";
import { uuidToBytes } from "../../src/engine/ids.ts";
import { SYSTEM_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, pdas } from "../../src/solana/accounts.ts";
import { SettlementFailure } from "../../src/solana/errors.ts";
import { decodeSettledEvent, fetchSettledEvent } from "../../src/solana/events.ts";
import { PROGRAM_ID, idlInstruction } from "../../src/solana/idl.ts";
import { KeypairFileError, REPO_ROOT, keypairFromJson, loadKeypairFile, loadKeypairSource } from "../../src/solana/keypair.ts";
import { settledEventData } from "../solana/mock-rpc.ts";
import { world, type World } from "../solana/world.ts";

const SETTLE = idlInstruction("settle");

async function adapterFor(w: World) {
  return SolanaSettlementAdapter.create({ rpc: w.rpc, operator: w.operator });
}

async function failure(p: Promise<unknown>): Promise<SettlementFailure> {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  if (!(e instanceof SettlementFailure)) throw new Error(`expected a SettlementFailure, got ${String(e)}`);
  return e;
}

describe("Solana settle transaction", () => {
  it("is built from the IDL: discriminator, the 16 bytes of the match UUID, u64 amounts, and the IDL's account order", async () => {
    const w = world();
    const adapter = await adapterFor(w);
    const match = w.match();
    const outcome = await adapter.settle(match);
    expect(outcome).toEqual({ txHash: "TEST-SIG-1", alreadySettled: false });

    const tx = w.rpc.sent[0]!;
    const ix = tx.message.compiledInstructions[0]!;
    const keys = tx.message.staticAccountKeys;
    expect(keys[ix.programIdIndex]!.equals(PROGRAM_ID)).toBe(true);
    const data = Uint8Array.from(ix.data);
    expect(Array.from(data.subarray(0, 8))).toEqual(SETTLE.discriminator);
    expect(Array.from(data.subarray(8, 24))).toEqual(Array.from(uuidToBytes(match.id)));
    const dv = new DataView(data.buffer, data.byteOffset);
    expect(dv.getBigUint64(24, true)).toBe(10n);
    expect(dv.getBigUint64(32, true)).toBe(250_000_000n);
    expect(data.length).toBe(40);

    const named = Object.fromEntries(SETTLE.accounts.map((a, i) => [a.name, keys[ix.accountKeyIndexes[i]!]!]));
    const p = pdas();
    expect(named["settlement_record"]!.equals(p.settlementRecord(uuidToBytes(match.id)))).toBe(true);
    expect(named["settlement_operator"]!.equals(w.operator.publicKey)).toBe(true);
    expect(named["seller_asset_account"]!.equals(w.ata(w.asset, w.seller.publicKey))).toBe(true);
    expect(named["buyer_payment_account"]!.equals(w.ata(w.usdt, w.buyer.publicKey))).toBe(true);
    expect(named["cashback_ledger"]!.equals(p.cashbackLedger(p.listing(w.asset), w.usdt))).toBe(true);
    expect(named["asset_token_program"]!.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
    expect(named["system_program"]!.equals(SYSTEM_PROGRAM_ID)).toBe(true);
    expect(named["event_authority"]!.equals(p.eventAuthority())).toBe(true);
    // Only the operator signs (fee payer); the parties' wallets never sign.
    expect(tx.message.header.numRequiredSignatures).toBe(1);
    expect(keys[0]!.equals(w.operator.publicKey)).toBe(true);
    for (const [i, a] of SETTLE.accounts.entries()) {
      expect(tx.message.isAccountWritable(ix.accountKeyIndexes[i]!) || a.writable !== true).toBe(true);
    }
  });

  it("simulates before every send, and sends nothing when the simulation fails, with a readable error", async () => {
    const w = world();
    const adapter = await adapterFor(w);
    await adapter.settle(w.match());
    const order = w.rpc.calls.filter((c) => ["simulate", "send", "confirm"].includes(c));
    expect(order).toEqual(["simulate", "send", "confirm"]);

    w.rpc.simulateResults = [{ err: { InstructionError: [0, { Custom: 6025 }] }, logs: [] }];
    const f = await failure(adapter.settle(w.match()));
    expect(f.kind).toBe("program");
    expect(f.message).toMatch(/DelegateNotSet \(6025\): Token account has not delegated to the vault authority/);
    expect(f.transient).toBe(false);
    expect(w.rpc.sent).toHaveLength(1);
  });

  it("treats an existing settlement record as settled: no simulation, no send, the original transaction returned", async () => {
    const w = world();
    const adapter = await adapterFor(w);
    const match = w.match();
    const record = pdas().settlementRecord(uuidToBytes(match.id));
    w.rpc.set(record, { owner: PROGRAM_ID, lamports: 695_960, data: new Uint8Array(9) });
    // Newest first: the oldest successful signature created the record.
    w.rpc.signaturesFor.set(record.toBase58(), ["TEST-LATER-READ", "TEST-ORIGINAL-SETTLE"]);
    expect(await adapter.settle(match)).toEqual({ txHash: "TEST-ORIGINAL-SETTLE", alreadySettled: true });
    expect(w.rpc.calls).not.toContain("simulate");
    expect(w.rpc.calls).not.toContain("send");

    w.rpc.signaturesFor.delete(record.toBase58());
    expect((await failure(adapter.settle(match))).transient).toBe(true);
  });

  it("treats a simulation refused by the replay guard as settled", async () => {
    const w = world();
    const adapter = await adapterFor(w);
    const match = w.match();
    w.rpc.simulateResults = [
      { err: { InstructionError: [0, { Custom: 0 }] }, logs: ["Allocate: account Address { address: X, base: None } already in use"] },
    ];
    w.rpc.signaturesFor.set(pdas().settlementRecord(uuidToBytes(match.id)).toBase58(), ["TEST-OTHER-SEND"]);
    expect(await adapter.settle(match)).toEqual({ txHash: "TEST-OTHER-SEND", alreadySettled: true });
    expect(w.rpc.sent).toEqual([]);
  });

  it("reports RPC trouble as transient, and a retry after an ambiguous confirmation never sends twice", async () => {
    const w = world();
    const adapter = await adapterFor(w);
    w.rpc.sendResults = [new Error("429 Too Many Requests")];
    expect((await failure(adapter.settle(w.match()))).transient).toBe(true);
    expect(w.rpc.sent).toEqual([]);

    w.rpc.sendResults = [];
    const match = w.match();
    w.rpc.confirmResults = [new Error("TransactionExpiredBlockheightExceededError: block height exceeded")];
    const f = await failure(adapter.settle(match));
    expect(f.transient).toBe(true);
    expect(w.rpc.sent).toHaveLength(1); // it landed after all (onSend created the record)
    w.rpc.signaturesFor.set(pdas().settlementRecord(uuidToBytes(match.id)).toBase58(), ["TEST-SIG-1"]);
    w.rpc.confirmResults = [{ err: null }];
    expect(await adapter.settle(match)).toEqual({ txHash: "TEST-SIG-1", alreadySettled: true });
    expect(w.rpc.sent).toHaveLength(1);
  });

  it("refuses with readable preconditions: paused protocol (retryable), payment not in USDT, not a UUID v4", async () => {
    const w = world();
    const adapter = await adapterFor(w);
    w.setConfig({ paused: true });
    const paused = await failure(adapter.settle(w.match()));
    expect([paused.transient, paused.message]).toEqual([true, "the protocol is paused (Config.paused)"]);
    w.setConfig();
    const other = await failure(adapter.settle(w.match({ paymentAsset: w.asset.toBase58() })));
    expect([other.kind, other.message]).toEqual(["precondition", `payment asset ${w.asset.toBase58()} is not the fee mint (USDT)`]);
    expect((await failure(adapter.settle(w.match({ id: "00000000-0000-0000-0000-000000000000" })))).kind).toBe("precondition");
    expect(w.rpc.sent).toEqual([]);
  });

  it("refuses to start with a key that is not the settlement operator, or off devnet", async () => {
    const w = world();
    await expect(SolanaSettlementAdapter.create({ rpc: w.rpc, operator: Keypair.generate() })).rejects.toThrow(
      /not the program's settlement operator/,
    );
    w.rpc.genesis = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
    await expect(adapterFor(w)).rejects.toThrow(/not devnet/);
  });

  it("says whether an asset is an approved Equity listing", async () => {
    const w = world();
    const adapter = await adapterFor(w);
    expect(await adapter.isListed(w.asset.toBase58())).toBe(true);
    expect(await adapter.isListed(w.usdt.toBase58())).toBe(false);
    expect(await adapter.isListed(Keypair.generate().publicKey.toBase58())).toBe(false);
  });
});

describe("Settled event", () => {
  it("is decoded from the settle transaction's inner instructions", async () => {
    const w = world();
    const matchId = uuidToBytes("6f1c1d4e-2a3b-4c5d-8e6f-7a8b9c0d1e2f");
    const data = settledEventData({
      match_id: matchId,
      asset_mint: w.asset,
      payment_mint: w.usdt,
      buyer: w.buyer.publicKey,
      seller: w.seller.publicKey,
      asset_amount: 10n,
      payment_amount: 250_000_000n,
      fee: 1_250_000n,
      cashback: 250_000n,
    });
    w.rpc.transactions.set("TEST-SIG", {
      err: null,
      slot: 1,
      blockTime: 1,
      logs: [],
      innerInstructions: [
        { programId: TOKEN_2022_PROGRAM_ID, data: Uint8Array.of(12) },
        { programId: PROGRAM_ID, data },
      ],
    });
    const e = await fetchSettledEvent(w.rpc, "TEST-SIG");
    expect(e).toMatchObject({ assetAmount: 10n, paymentAmount: 250_000_000n, fee: 1_250_000n, cashback: 250_000n });
    expect(Array.from(e!.matchId)).toEqual(Array.from(matchId));
    expect(e!.buyer.equals(w.buyer.publicKey)).toBe(true);
    expect(decodeSettledEvent(Uint8Array.of(1, 2, 3))).toBeNull();
    expect(await fetchSettledEvent(w.rpc, "TEST-MISSING")).toBeNull();
  });
});

describe("operator keypair file", () => {
  const dir = mkdtempSync(join(tmpdir(), "niara-test-keys-"));
  const kp = Keypair.generate();
  const path = join(dir, "operator.json");
  writeFileSync(path, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });

  it("loads a 600 file outside the repository", () => {
    expect(loadKeypairFile(path, "operator").publicKey.equals(kp.publicKey)).toBe(true);
  });

  it("refuses a file readable by others, one inside the repository, and junk, without quoting the content", () => {
    const open = join(dir, "open.json");
    writeFileSync(open, JSON.stringify(Array.from(kp.secretKey)));
    chmodSync(open, 0o644);
    expect(() => loadKeypairFile(open, "operator")).toThrow(/readable by others/);
    expect(() => loadKeypairFile(join(REPO_ROOT, "package.json"), "operator")).toThrow(/inside the repository/);
    const junk = join(dir, "junk.json");
    writeFileSync(junk, JSON.stringify([1, 2, 3]), { mode: 0o600 });
    let message = "";
    try {
      loadKeypairFile(junk, "operator");
    } catch (e) {
      expect(e).toBeInstanceOf(KeypairFileError);
      message = (e as Error).message;
    }
    expect(message).toMatch(/not a 64-byte keypair/);
    expect(message).not.toContain("[1,2,3]");
    expect(() => loadKeypairFile(join(dir, "missing.json"), "operator")).toThrow(/not found/);
  });

  it("loads the same keypair from a variable's content (SOLANA_OPERATOR_KEYPAIR_JSON), never quoting it in errors", () => {
    const json = JSON.stringify(Array.from(kp.secretKey));
    const fromEnv = loadKeypairSource({ from: "env", variable: "SOLANA_OPERATOR_KEYPAIR_JSON", json }, "operator");
    expect(fromEnv.publicKey.equals(kp.publicKey)).toBe(true);
    expect(loadKeypairSource({ from: "file", path }, "operator").publicKey.equals(kp.publicKey)).toBe(true);
    for (const [bad, why] of [
      ["[1,2,3]", /not a 64-byte keypair/],
      [json.slice(0, -1), /not valid JSON/],
      [JSON.stringify([...Array(64)].map(() => 256)), /not a 64-byte keypair/],
    ] as const) {
      let message = "";
      try {
        loadKeypairSource({ from: "env", variable: "SOLANA_OPERATOR_KEYPAIR_JSON", json: bad }, "operator");
      } catch (e) {
        expect(e).toBeInstanceOf(KeypairFileError);
        message = (e as Error).message;
      }
      expect(message).toMatch(why);
      expect(message).toContain("(SOLANA_OPERATOR_KEYPAIR_JSON)");
      expect(message).not.toContain(bad.slice(0, 8));
    }
    expect(() => keypairFromJson(JSON.stringify(Array(64).fill(0)), "zero key")).not.toThrow(/valid JSON/);
  });
});
