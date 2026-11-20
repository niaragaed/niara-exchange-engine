import { createDecipheriv, scryptSync, timingSafeEqual } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import { bytesToHex, concatBytes, hexToBytes, keccak256 } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { REPO_ROOT } from "../solana/keypair.ts";

/**
 * Loads an EVM signer from an encrypted Foundry keystore (Web3 Secret Storage v3:
 * scrypt + AES-128-CTR, what `cast wallet new` / `cast wallet import` write to
 * `~/.foundry/keystores/<name>`). TESTNET ONLY.
 *
 * - The file must live OUTSIDE this repository. Its mode is not checked: the key is
 *   encrypted, and on WSL the Windows keystore directory (/mnt/c/...) shows every file
 *   as 0777 whatever its Windows ACL.
 * - The password comes from the caller (an environment variable); neither the password,
 *   the derived key nor the private key is ever logged or put in an error message.
 * - The MAC is checked before decrypting: a wrong password fails cleanly.
 */

export class KeystoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeystoreError";
  }
}

interface V3 {
  version: number;
  crypto: {
    cipher: string;
    ciphertext: string;
    cipherparams: { iv: string };
    kdf: string;
    kdfparams: { dklen: number; n: number; r: number; p: number; salt: string };
    mac: string;
  };
}

/** scrypt N above this would need more than 256 MB (r = 8): refused on this machine. */
const MAX_SCRYPT_N = 2 ** 18;

const hex = (s: string) => hexToBytes((s.startsWith("0x") ? s : `0x${s}`) as `0x${string}`);

export function decryptKeystore(json: string, password: string, what: string): PrivateKeyAccount {
  let k: V3;
  try {
    k = JSON.parse(json) as V3;
  } catch {
    throw new KeystoreError(`${what} keystore is not valid JSON`);
  }
  const c = (k as { crypto?: V3["crypto"]; Crypto?: V3["crypto"] }).crypto ?? (k as { Crypto?: V3["crypto"] }).Crypto;
  if (k.version !== 3 || !c) throw new KeystoreError(`${what} keystore is not a version 3 keystore`);
  if (c.cipher !== "aes-128-ctr" || c.kdf !== "scrypt") {
    throw new KeystoreError(`${what} keystore uses ${c.cipher}/${c.kdf}; only aes-128-ctr/scrypt is supported`);
  }
  const { n, r, p, dklen, salt } = c.kdfparams;
  if (dklen !== 32 || !Number.isInteger(n) || n < 2 || n > MAX_SCRYPT_N) {
    throw new KeystoreError(`${what} keystore has unsupported scrypt parameters`);
  }
  const derived = new Uint8Array(scryptSync(password.normalize("NFKC"), hex(salt), dklen, { N: n, r, p, maxmem: 128 * n * r + 1024 * 1024 }));
  const ciphertext = hex(c.ciphertext);
  const mac = hexToBytes(keccak256(concatBytes([derived.subarray(16, 32), ciphertext])));
  const expected = hex(c.mac);
  if (mac.length !== expected.length || !timingSafeEqual(mac, expected)) {
    throw new KeystoreError(`${what} keystore: wrong password (MAC mismatch)`);
  }
  const decipher = createDecipheriv("aes-128-ctr", derived.subarray(0, 16), hex(c.cipherparams.iv));
  const key = new Uint8Array([...decipher.update(ciphertext), ...decipher.final()]);
  derived.fill(0);
  if (key.length !== 32) throw new KeystoreError(`${what} keystore does not hold a 32-byte key`);
  try {
    return privateKeyToAccount(bytesToHex(key));
  } catch {
    throw new KeystoreError(`${what} keystore does not hold a valid secp256k1 key`);
  } finally {
    key.fill(0);
  }
}

export function loadKeystoreFile(path: string, password: string | undefined, what: string, repoRoot: string = REPO_ROOT): PrivateKeyAccount {
  if (!password) throw new KeystoreError(`${what} keystore password is not set`);
  let real: string;
  try {
    real = realpathSync(resolve(path));
  } catch {
    throw new KeystoreError(`${what} keystore not found: ${path}`);
  }
  const root = realpathSync(repoRoot);
  if ((real + sep).startsWith(root + sep)) throw new KeystoreError(`${what} keystore is inside the repository: keys must stay outside it`);
  return decryptKeystore(readFileSync(real, "utf8"), password, what);
}
