import { describe, expect, it } from "vitest";
import { decryptBackup, encryptBackup, isEncryptedBackup } from "../../windows/backup-crypto.js";

describe("encrypted Windows backup envelope", () => {
  const passphrase = "a-long-owner-chosen-backup-passphrase";

  it("round-trips bytes and identifies the authenticated envelope", () => {
    const payload = Buffer.from("SQLite snapshot plus private configuration", "utf8");
    const encrypted = encryptBackup(payload, passphrase);
    expect(isEncryptedBackup(encrypted)).toBe(true);
    expect(encrypted.includes(payload)).toBe(false);
    expect(decryptBackup(encrypted, passphrase)).toEqual(payload);
  });

  it("rejects a wrong passphrase and modified ciphertext", () => {
    const encrypted = encryptBackup(Buffer.from("private backup"), passphrase);
    expect(() => decryptBackup(encrypted, "a-different-owner-passphrase")).toThrow("authentication failed");
    const modified = Buffer.from(encrypted);
    modified[modified.length - 1] ^= 0x20;
    expect(() => decryptBackup(modified, passphrase)).toThrow("authentication failed");
  });

  it("rejects plaintext, truncated envelopes and weak passphrases", () => {
    expect(isEncryptedBackup(Buffer.from("PK ZIP legacy archive"))).toBe(false);
    expect(() => decryptBackup(Buffer.from("PK ZIP legacy archive"), passphrase)).toThrow("not a supported encrypted");
    const encrypted = encryptBackup(Buffer.from("payload"), passphrase);
    expect(() => decryptBackup(encrypted.subarray(0, 20), passphrase)).toThrow("not a supported encrypted");
    expect(() => encryptBackup(Buffer.from("payload"), "short")).toThrow("at least 12 characters");
  });
});
