import { createCipheriv, randomBytes, scryptSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bytesToHex, concatBytes, hexToBytes, keccak256 } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { KeystoreError, decryptKeystore, loadKeystoreFile } from "../../src/evm/keystore.ts";

/**
 * Foundry keystores (Web3 Secret Storage v3, scrypt + AES-128-CTR), written here the way
 * `cast wallet new` writes them, with a throwaway key and a small scrypt N for speed.
 * TEST ONLY: no real key is read.
 */

function keystore(privateKey: `0x${string}`, password: string, n = 1024): string {
  const salt = randomBytes(32);
  const iv = randomBytes(16);
  const derived = scryptSync(password, salt, 32, { N: n, r: 8, p: 1 });
  const cipher = createCipheriv("aes-128-ctr", derived.subarray(0, 16), iv);
  const ciphertext = Buffer.concat([cipher.update(hexToBytes(privateKey)), cipher.final()]);
  const mac = keccak256(concatBytes([derived.subarray(16, 32), ciphertext]));
  // Foundry writes no "address" field.
  return JSON.stringify({
    crypto: {
      cipher: "aes-128-ctr",
      cipherparams: { iv: iv.toString("hex") },
      ciphertext: ciphertext.toString("hex"),
      kdf: "scrypt",
      kdfparams: { dklen: 32, n, p: 1, r: 8, salt: salt.toString("hex") },
      mac: mac.slice(2),
    },
    id: "00000000-0000-4000-8000-000000000000",
    version: 3,
  });
}

describe("Foundry keystore", () => {
  const key = generatePrivateKey();
  const address = privateKeyToAccount(key).address;
  const PASSWORD = "TEST-ONLY password";

  it("decrypts to the key's account", () => {
    const account = decryptKeystore(keystore(key, PASSWORD), PASSWORD, "test operator");
    expect(account.address).toBe(address);
  });

  it("refuses a wrong password by its MAC, without quoting the password or the key", () => {
    const e = (() => {
      try {
        decryptKeystore(keystore(key, PASSWORD), "wrong", "test operator");
      } catch (x) {
        return x as Error;
      }
      return null;
    })();
    expect(e).toBeInstanceOf(KeystoreError);
    expect(e!.message).toBe("test operator keystore: wrong password (MAC mismatch)");
    expect(e!.message).not.toContain(PASSWORD);
    expect(e!.message).not.toContain(key.slice(2, 10));
  });

  it("refuses other formats and oversized scrypt parameters", () => {
    expect(() => decryptKeystore("{", PASSWORD, "k")).toThrow(/not valid JSON/);
    expect(() => decryptKeystore(JSON.stringify({ version: 1 }), PASSWORD, "k")).toThrow(/version 3/);
    const big = JSON.parse(keystore(key, PASSWORD));
    big.crypto.kdfparams.n = 2 ** 20;
    expect(() => decryptKeystore(JSON.stringify(big), PASSWORD, "k")).toThrow(/unsupported scrypt/);
    const pbkdf2 = JSON.parse(keystore(key, PASSWORD));
    pbkdf2.crypto.kdf = "pbkdf2";
    expect(() => decryptKeystore(JSON.stringify(pbkdf2), PASSWORD, "k")).toThrow(/only aes-128-ctr\/scrypt/);
  });

  it("loads a file outside the repository only, and requires a password", () => {
    const dir = mkdtempSync(join(tmpdir(), "niara-keystore-test-"));
    const path = join(dir, "niara-evm-operator");
    writeFileSync(path, keystore(key, PASSWORD));
    expect(loadKeystoreFile(path, PASSWORD, "test operator").address).toBe(address);
    expect(() => loadKeystoreFile(path, undefined, "test operator")).toThrow(/password is not set/);
    expect(() => loadKeystoreFile(join(dir, "missing"), PASSWORD, "test operator")).toThrow(/not found/);
    // Pretend the temp directory is the repository.
    expect(() => loadKeystoreFile(path, PASSWORD, "test operator", dir)).toThrow(/inside the repository/);
    expect(bytesToHex(hexToBytes(key))).toBe(key);
  });
});
