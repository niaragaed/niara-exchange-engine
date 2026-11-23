import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { Keypair } from "@solana/web3.js";
import type { KeySource } from "../key-source.ts";

/**
 * Loads a keypair (Solana CLI format: a JSON array of 64 bytes) from a file that must
 * live OUTSIDE this repository and be readable by its owner only (mode 600 or
 * stricter), or from a variable holding that JSON (SOLANA_OPERATOR_KEYPAIR_JSON on a
 * host such as Railway). Errors never quote the content. The secret key is never logged.
 */

export const REPO_ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..", "..");

export class KeypairFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeypairFileError";
  }
}

export function loadKeypairFile(path: string, what: string, repoRoot: string = REPO_ROOT): Keypair {
  let real: string;
  try {
    real = realpathSync(resolve(path));
  } catch {
    throw new KeypairFileError(`${what} keypair file not found: ${path}`);
  }
  const root = realpathSync(repoRoot);
  if ((real + sep).startsWith(root + sep)) {
    throw new KeypairFileError(`${what} keypair file is inside the repository: keys must stay outside it`);
  }
  if ((statSync(real).mode & 0o077) !== 0) {
    throw new KeypairFileError(`${what} keypair file ${path} is readable by others: chmod 600 it`);
  }
  return keypairFromJson(readFileSync(real, "utf8"), `${what} keypair file ${path}`);
}

/** Parses a 64-byte keypair from JSON text. `label` names the source in errors; the text is never quoted. */
export function keypairFromJson(text: string, label: string): Keypair {
  let bytes: unknown;
  try {
    bytes = JSON.parse(text);
  } catch {
    throw new KeypairFileError(`${label} is not valid JSON`);
  }
  if (!Array.isArray(bytes) || bytes.length !== 64 || !bytes.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) {
    throw new KeypairFileError(`${label} is not a 64-byte keypair`);
  }
  try {
    return Keypair.fromSecretKey(Uint8Array.from(bytes as number[]));
  } catch {
    throw new KeypairFileError(`${label} does not hold a valid ed25519 keypair`);
  }
}

/** The keypair of a file or variable source. */
export function loadKeypairSource(source: KeySource, what: string, repoRoot: string = REPO_ROOT): Keypair {
  return source.from === "file" ? loadKeypairFile(source.path, what, repoRoot) : keypairFromJson(source.json, `${what} keypair (${source.variable})`);
}
