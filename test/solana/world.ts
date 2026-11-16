/**
 * TEST ONLY: a mocked Solana devnet "world" for the adapter, delegate check and worker
 * tests: the program's Config, a mock USDT and an equity mint (Token-2022), a seller
 * and a buyer with their token accounts. Keys are generated per run; nothing here
 * exists on any cluster.
 */
import { randomUUID } from "node:crypto";
import { Keypair, PublicKey } from "@solana/web3.js";
import type { Match } from "../../src/engine/types.ts";
import { TOKEN_2022_PROGRAM_ID, associatedTokenAddress, pdas } from "../../src/solana/accounts.ts";
import { PROGRAM_ID, idlInstruction } from "../../src/solana/idl.ts";
import { configData, listingData, mintData, mockRpc, tokenAccount, tokenAccountData, type MockRpc } from "./mock-rpc.ts";

export interface World {
  rpc: MockRpc;
  operator: Keypair;
  usdt: PublicKey;
  asset: PublicKey;
  seller: Keypair;
  buyer: Keypair;
  vault: PublicKey;
  ata(mint: PublicKey, owner: PublicKey): PublicKey;
  /** Sets a token account's balance and delegation (delegate = the vault by default). */
  setTokens(mint: PublicKey, owner: PublicKey, amount: bigint, delegated: bigint, delegate?: PublicKey | null): void;
  setConfig(over?: { paused?: boolean; operator?: PublicKey; feeMint?: PublicKey }): void;
  match(over?: Partial<Match>): Match;
}

export function world(): World {
  const rpc = mockRpc();
  const operator = Keypair.generate();
  const usdt = Keypair.generate().publicKey;
  const asset = Keypair.generate().publicKey;
  const seller = Keypair.generate();
  const buyer = Keypair.generate();
  const p = pdas();
  const vault = p.vaultAuthority();
  const ata = (mint: PublicKey, owner: PublicKey) => associatedTokenAddress(mint, owner, TOKEN_2022_PROGRAM_ID);
  const w: World = {
    rpc,
    operator,
    usdt,
    asset,
    seller,
    buyer,
    vault,
    ata,
    setTokens(mint, owner, amount, delegated, delegate = vault) {
      rpc.set(
        ata(mint, owner),
        tokenAccount(tokenAccountData({ mint, owner, amount, delegate: delegated > 0n ? delegate : null, delegatedAmount: delegated })),
      );
    },
    setConfig(over = {}) {
      rpc.set(p.config(), {
        owner: PROGRAM_ID,
        lamports: 1,
        data: configData({
          settlementOperator: over.operator ?? operator.publicKey,
          feeMint: over.feeMint ?? usdt,
          paused: over.paused ?? false,
        }),
      });
    },
    match(over = {}) {
      return {
        id: randomUUID(),
        sequence: 1,
        chain: "solana-devnet",
        asset: asset.toBase58(),
        paymentAsset: usdt.toBase58(),
        buyOrderId: randomUUID(),
        sellOrderId: randomUUID(),
        buyer: buyer.publicKey.toBase58(),
        seller: seller.publicKey.toBase58(),
        makerOrderId: randomUUID(),
        takerSide: "buy",
        quantity: 10n,
        lotSize: 1n,
        price: 25_000_000n,
        paymentAmount: 250_000_000n,
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        ...over,
      };
    },
  };
  w.setConfig();
  rpc.set(usdt, { owner: TOKEN_2022_PROGRAM_ID, lamports: 1, data: mintData(6) });
  rpc.set(asset, { owner: TOKEN_2022_PROGRAM_ID, lamports: 1, data: mintData(0) });
  rpc.set(p.listing(asset), { owner: PROGRAM_ID, lamports: 1, data: listingData({ mint: asset, assetClass: "Equity", status: "Approved" }) });
  rpc.set(p.listing(usdt), { owner: PROGRAM_ID, lamports: 1, data: listingData({ mint: usdt, assetClass: "Currency", status: "Approved" }) });
  w.setTokens(asset, seller.publicKey, 900n, 10n);
  w.setTokens(usdt, buyer.publicKey, 1_000_000_000n, 250_000_000n);
  w.setTokens(usdt, seller.publicKey, 0n, 0n);
  w.setTokens(asset, buyer.publicKey, 0n, 0n);
  // A landed settle creates the match's record (the IDL's settlement_record account).
  const recordIndex = idlInstruction("settle").accounts.findIndex((a) => a.name === "settlement_record");
  rpc.onSend = (tx) => {
    const ix = tx.message.compiledInstructions[0];
    const keyIndex = ix?.accountKeyIndexes[recordIndex];
    const record = keyIndex === undefined ? undefined : tx.message.staticAccountKeys[keyIndex];
    if (record) rpc.set(record, { owner: PROGRAM_ID, lamports: 695_960, data: new Uint8Array(9) });
  };
  return w;
}
