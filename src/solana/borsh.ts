import { PublicKey } from "@solana/web3.js";
import { idlTypeDef, type IdlField, type IdlType } from "./idl.ts";

/**
 * Minimal Borsh codec driven by the IDL, for the types the order book uses: integers
 * (`u64`/`i64` as bigint), bool, pubkey, fixed arrays, unit enums (as the variant name)
 * and structs. Anything else throws, so an IDL change cannot be misread silently.
 */

export type BorshValue = bigint | number | boolean | string | PublicKey | Uint8Array | BorshValue[] | { [k: string]: BorshValue };

const U64_MAX = (1n << 64n) - 1n;

export function encodeFields(fields: readonly IdlField[], values: Record<string, BorshValue>): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const f of fields) {
    if (!(f.name in values)) throw new Error(`missing argument ${f.name}`);
    parts.push(encode(f.type, values[f.name]!, f.name));
  }
  return concat(parts);
}

function encode(type: IdlType, value: BorshValue, path: string): Uint8Array {
  if (typeof type === "string") {
    switch (type) {
      case "u8":
      case "u16":
      case "u32": {
        const bytes = { u8: 1, u16: 2, u32: 4 }[type];
        const v = Number(value);
        if (!Number.isInteger(v) || v < 0 || v >= 2 ** (8 * bytes)) throw new RangeError(`${path} out of ${type} range`);
        const out = new Uint8Array(bytes);
        for (let i = 0; i < bytes; i++) out[i] = (v >>> (8 * i)) & 0xff;
        return out;
      }
      case "u64": {
        if (typeof value !== "bigint" || value < 0n || value > U64_MAX) throw new RangeError(`${path} out of u64 range`);
        const out = new Uint8Array(8);
        new DataView(out.buffer).setBigUint64(0, value, true);
        return out;
      }
      case "i64": {
        if (typeof value !== "bigint") throw new TypeError(`${path} must be a bigint`);
        const out = new Uint8Array(8);
        new DataView(out.buffer).setBigInt64(0, value, true);
        return out;
      }
      case "bool":
        return Uint8Array.of(value ? 1 : 0);
      case "pubkey":
        return (value instanceof PublicKey ? value : new PublicKey(value as string)).toBytes();
    }
  }
  if ("array" in type) {
    const [inner, len] = type.array;
    if (inner === "u8") {
      if (!(value instanceof Uint8Array) || value.length !== len) throw new RangeError(`${path} must be ${len} bytes`);
      return Uint8Array.from(value);
    }
    if (!Array.isArray(value) || value.length !== len) throw new RangeError(`${path} must have ${len} items`);
    return concat(value.map((v, i) => encode(inner, v, `${path}[${i}]`)));
  }
  if ("defined" in type) {
    const def = idlTypeDef(type.defined.name);
    if (def.type.kind === "struct") return encodeFields(def.type.fields, value as Record<string, BorshValue>);
    const index = def.type.variants.findIndex((v) => v.name === value);
    if (index < 0 || def.type.variants[index]!.fields) throw new RangeError(`${path}: not a unit variant of ${def.name}`);
    return Uint8Array.of(index);
  }
  throw new Error(`unsupported IDL type at ${path}: ${JSON.stringify(type)}`);
}

export class Reader {
  offset = 0;
  readonly bytes: Uint8Array;
  // No parameter properties: Node runs these files with type stripping only.
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }
  take(n: number): Uint8Array {
    if (this.offset + n > this.bytes.length) throw new RangeError("account data too short");
    const out = this.bytes.subarray(this.offset, this.offset + n);
    this.offset += n;
    return out;
  }
}

export function decodeType(type: IdlType, r: Reader): BorshValue {
  if (typeof type === "string") {
    const view = (n: number) => {
      const b = r.take(n);
      return new DataView(b.buffer, b.byteOffset, n);
    };
    switch (type) {
      case "u8":
        return view(1).getUint8(0);
      case "u16":
        return view(2).getUint16(0, true);
      case "u32":
        return view(4).getUint32(0, true);
      case "u64":
        return view(8).getBigUint64(0, true);
      case "i64":
        return view(8).getBigInt64(0, true);
      case "bool": {
        const b = view(1).getUint8(0);
        if (b > 1) throw new RangeError("invalid bool");
        return b === 1;
      }
      case "pubkey":
        return new PublicKey(r.take(32));
    }
  }
  if ("array" in type) {
    const [inner, len] = type.array;
    if (inner === "u8") return Uint8Array.from(r.take(len));
    return Array.from({ length: len }, () => decodeType(inner, r));
  }
  if ("defined" in type) {
    const def = idlTypeDef(type.defined.name);
    if (def.type.kind === "struct") return decodeFields(def.type.fields, r);
    const index = r.take(1)[0]!;
    const variant = def.type.variants[index];
    if (!variant) throw new RangeError(`invalid ${def.name} variant ${index}`);
    if (variant.fields) throw new Error(`unsupported enum variant with fields: ${def.name}::${variant.name}`);
    return variant.name;
  }
  throw new Error(`unsupported IDL type: ${JSON.stringify(type)}`);
}

export function decodeFields(fields: readonly IdlField[], r: Reader): Record<string, BorshValue> {
  const out: Record<string, BorshValue> = {};
  for (const f of fields) out[f.name] = decodeType(f.type, r);
  return out;
}

/** Decodes an Anchor account or event body: checks the 8-byte discriminator, then the struct. */
export function decodeWithDiscriminator(
  typeName: string,
  discriminator: Uint8Array,
  data: Uint8Array,
): Record<string, BorshValue> {
  if (data.length < 8 || !equalBytes(data.subarray(0, 8), discriminator)) {
    throw new Error(`not a ${typeName}: discriminator mismatch`);
  }
  const def = idlTypeDef(typeName);
  if (def.type.kind !== "struct") throw new Error(`${typeName} is not a struct`);
  const r = new Reader(data);
  r.offset = 8;
  return decodeFields(def.type.fields, r);
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
