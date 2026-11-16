import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PublicKey } from "@solana/web3.js";

/**
 * The `niara_exchange` Anchor IDL, vendored from `niara-exchange-solana`
 * (`target/idl/niara_exchange.json`, build of 2026-11-14, deployed to devnet as
 * B311xH3PcEx86gdRbuinrGrh1r9G2qzjDCji8uc6eD9v). A test checks that this copy equals the
 * Solana repo's when that repo is present. Instruction data, account order, account
 * layouts, events and errors are all read from it: nothing about the program is
 * hand-copied elsewhere.
 */

export interface IdlField {
  name: string;
  type: IdlType;
}

export type IdlType =
  | "bool"
  | "u8"
  | "u16"
  | "u32"
  | "u64"
  | "i64"
  | "pubkey"
  | { array: [IdlType, number] }
  | { defined: { name: string } };

export interface IdlTypeDef {
  name: string;
  type: { kind: "struct"; fields: IdlField[] } | { kind: "enum"; variants: { name: string; fields?: unknown }[] };
}

export interface IdlInstructionAccount {
  name: string;
  writable?: boolean;
  signer?: boolean;
  address?: string;
}

export interface IdlInstruction {
  name: string;
  discriminator: number[];
  accounts: IdlInstructionAccount[];
  args: IdlField[];
}

export interface Idl {
  address: string;
  metadata: { name: string; version: string };
  instructions: IdlInstruction[];
  accounts: { name: string; discriminator: number[] }[];
  events: { name: string; discriminator: number[] }[];
  types: IdlTypeDef[];
  errors: { code: number; name: string; msg: string }[];
}

export const IDL_PATH = join(import.meta.dirname, "idl", "niara_exchange.json");

export const IDL: Idl = JSON.parse(readFileSync(IDL_PATH, "utf8")) as Idl;

export const PROGRAM_ID = new PublicKey(IDL.address);

export function idlInstruction(name: string): IdlInstruction {
  const ix = IDL.instructions.find((i) => i.name === name);
  if (!ix) throw new Error(`IDL has no instruction ${name}`);
  return ix;
}

export function idlTypeDef(name: string): IdlTypeDef {
  const t = IDL.types.find((x) => x.name === name);
  if (!t) throw new Error(`IDL has no type ${name}`);
  return t;
}

export function accountDiscriminator(name: string): Uint8Array {
  const a = IDL.accounts.find((x) => x.name === name);
  if (!a) throw new Error(`IDL has no account ${name}`);
  return Uint8Array.from(a.discriminator);
}

export function eventDiscriminator(name: string): Uint8Array {
  const e = IDL.events.find((x) => x.name === name);
  if (!e) throw new Error(`IDL has no event ${name}`);
  return Uint8Array.from(e.discriminator);
}

export function programError(code: number): { code: number; name: string; msg: string } | undefined {
  return IDL.errors.find((e) => e.code === code);
}
