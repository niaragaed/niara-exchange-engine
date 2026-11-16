import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { Keypair } from "@solana/web3.js";

/**
 * Loads a keypair file (Solana CLI format: a JSON array of 64 bytes) that must live
 * OUTSIDE this repository and be readable by its owner only (mode 600 or stricter).
 * Errors never quote the file's content. The secret key is never logged.
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
  let bytes: unknown;
  try {
    bytes = JSON.parse(readFileSync(real, "utf8"));
  } catch {
    throw new KeypairFileError(`${what} keypair file ${path} is not valid JSON`);
  }
  if (!Array.isArray(bytes) || bytes.length !== 64 || !bytes.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) {
    throw new KeypairFileError(`${what} keypair file ${path} is not a 64-byte keypair`);
  }
  try {
    return Keypair.fromSecretKey(Uint8Array.from(bytes as number[]));
  } catch {
    throw new KeypairFileError(`${what} keypair file ${path} does not hold a valid ed25519 keypair`);
  }
}
