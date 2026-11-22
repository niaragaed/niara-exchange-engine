import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, SYSTEM_PROGRAM_ID, associatedTokenAddress, isTokenProgram } from "./accounts.ts";

/**
 * SPL Token / Token-2022 and Associated Token Account instructions used by the devnet
 * scripts (scripts/fund-tester.ts, scripts/counter-order.ts). Built by hand (no
 * @solana/spl-token dependency); both token programs share these encodings.
 * TESTNET ONLY.
 */

const U64_MAX = (1n << 64n) - 1n;

function checkedAmountData(tag: number, amount: bigint, decimals: number): Buffer {
  if (amount <= 0n || amount > U64_MAX) throw new RangeError("amount must be a positive u64");
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new RangeError("decimals must be a u8");
  const data = new Uint8Array(10);
  data[0] = tag;
  new DataView(data.buffer).setBigUint64(1, amount, true);
  data[9] = decimals;
  return Buffer.from(data);
}

function tokenProgramOrThrow(tokenProgram: PublicKey): PublicKey {
  if (!isTokenProgram(tokenProgram)) throw new Error(`${tokenProgram.toBase58()} is not an SPL token program`);
  return tokenProgram;
}

/** TransferChecked (instruction 12): `amount` from `source` to `destination`, signed by `owner`. */
export function transferChecked(v: {
  tokenProgram: PublicKey;
  source: PublicKey;
  mint: PublicKey;
  destination: PublicKey;
  owner: PublicKey;
  amount: bigint;
  decimals: number;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: tokenProgramOrThrow(v.tokenProgram),
    keys: [
      { pubkey: v.source, isSigner: false, isWritable: true },
      { pubkey: v.mint, isSigner: false, isWritable: false },
      { pubkey: v.destination, isSigner: false, isWritable: true },
      { pubkey: v.owner, isSigner: true, isWritable: false },
    ],
    data: checkedAmountData(12, v.amount, v.decimals),
  });
}

/**
 * ApproveChecked (instruction 13): `delegate` may move up to `amount` from `source`.
 * It REPLACES the account's current delegation (delegate and amount); it does not add.
 */
export function approveChecked(v: {
  tokenProgram: PublicKey;
  source: PublicKey;
  mint: PublicKey;
  delegate: PublicKey;
  owner: PublicKey;
  amount: bigint;
  decimals: number;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: tokenProgramOrThrow(v.tokenProgram),
    keys: [
      { pubkey: v.source, isSigner: false, isWritable: true },
      { pubkey: v.mint, isSigner: false, isWritable: false },
      { pubkey: v.delegate, isSigner: false, isWritable: false },
      { pubkey: v.owner, isSigner: true, isWritable: false },
    ],
    data: checkedAmountData(13, v.amount, v.decimals),
  });
}

/**
 * Associated Token Account program, CreateIdempotent (instruction 1): creates `owner`'s
 * associated token account for `mint` if it does not exist (paid by `payer`), and does
 * nothing if it does. Returns the instruction and the account's address.
 */
export function createAssociatedTokenAccountIdempotent(v: {
  payer: PublicKey;
  owner: PublicKey;
  mint: PublicKey;
  tokenProgram: PublicKey;
}): { instruction: TransactionInstruction; address: PublicKey } {
  const address = associatedTokenAddress(v.mint, v.owner, tokenProgramOrThrow(v.tokenProgram));
  return {
    address,
    instruction: new TransactionInstruction({
      programId: ASSOCIATED_TOKEN_PROGRAM_ID,
      keys: [
        { pubkey: v.payer, isSigner: true, isWritable: true },
        { pubkey: address, isSigner: false, isWritable: true },
        { pubkey: v.owner, isSigner: false, isWritable: false },
        { pubkey: v.mint, isSigner: false, isWritable: false },
        { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: v.tokenProgram, isSigner: false, isWritable: false },
      ],
      data: Buffer.from([1]),
    }),
  };
}
