import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const MAGIC = Buffer.from([83, 79, 68, 66, 65, 67, 75, 85, 80, 0, 1]);
const SALT_BYTES = 16;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const KDF_ITERATIONS = 310_000;
const MIN_KDF_ITERATIONS = 200_000;
const MAX_KDF_ITERATIONS = 1_000_000;
const HEADER_BYTES = MAGIC.length + 4 + SALT_BYTES + NONCE_BYTES;

function validatePassphrase(passphrase: string): Buffer {
  if (typeof passphrase !== "string" || Array.from(passphrase).length < 12) {
    throw new Error("Backup passphrase must contain at least 12 characters.");
  }
  return Buffer.from(passphrase.normalize("NFKC"), "utf8");
}

/** AES-256-GCM authenticated encryption; the passphrase is never written to the archive. */
export function encryptBackup(plaintext: Uint8Array, passphrase: string): Buffer {
  const password = validatePassphrase(passphrase);
  const salt = randomBytes(SALT_BYTES);
  const nonce = randomBytes(NONCE_BYTES);
  const iterations = Buffer.alloc(4);
  iterations.writeUInt32LE(KDF_ITERATIONS);
  const header = Buffer.concat([MAGIC, iterations, salt, nonce]);
  const key = pbkdf2Sync(password, salt, KDF_ITERATIONS, KEY_BYTES, "sha256");
  try {
    const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
    cipher.setAAD(header);
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([header, cipher.getAuthTag(), encrypted]);
  } finally {
    password.fill(0);
    key.fill(0);
  }
}

export function isEncryptedBackup(contents: Uint8Array): boolean {
  return contents.byteLength >= MAGIC.length && Buffer.from(contents).subarray(0, MAGIC.length).equals(MAGIC);
}

export function decryptBackup(contents: Uint8Array, passphrase: string): Buffer {
  const input = Buffer.from(contents);
  if (!isEncryptedBackup(input) || input.length < HEADER_BYTES + TAG_BYTES) {
    throw new Error("This is not a supported encrypted SURVIVE OR DIE backup.");
  }
  const header = input.subarray(0, HEADER_BYTES);
  const iterations = header.readUInt32LE(MAGIC.length);
  if (iterations < MIN_KDF_ITERATIONS || iterations > MAX_KDF_ITERATIONS) {
    throw new Error("Backup encryption parameters are outside the supported safety limits.");
  }
  const saltStart = MAGIC.length + 4;
  const salt = header.subarray(saltStart, saltStart + SALT_BYTES);
  const nonce = header.subarray(saltStart + SALT_BYTES, HEADER_BYTES);
  const tag = input.subarray(HEADER_BYTES, HEADER_BYTES + TAG_BYTES);
  const ciphertext = input.subarray(HEADER_BYTES + TAG_BYTES);
  const password = validatePassphrase(passphrase);
  const key = pbkdf2Sync(password, salt, iterations, KEY_BYTES, "sha256");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(header);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error("Backup authentication failed. Check the passphrase or archive integrity.");
  } finally {
    password.fill(0);
    key.fill(0);
  }
}

async function readPassphrase(confirm: boolean): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const lines = Buffer.concat(chunks).toString("utf8").split(/\r?\n/);
  const passphrase = lines[0] ?? "";
  if (confirm && passphrase !== (lines[1] ?? "")) throw new Error("Passphrases did not match.");
  validatePassphrase(passphrase);
  return passphrase;
}

async function writeExclusive(path: string, bytes: Uint8Array): Promise<void> {
  await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
}

async function runCli(args: string[]): Promise<void> {
  const [operation, inputPath, outputPath] = args;
  if (!operation || !inputPath) throw new Error("Usage: backup-crypto <detect|encrypt|decrypt> <input> [output]");
  const input = await readFile(inputPath);
  if (operation === "detect") {
    process.stdout.write(isEncryptedBackup(input) ? "encrypted\n" : "legacy-plaintext\n");
    return;
  }
  if (!outputPath) throw new Error("An output path is required.");
  if (operation === "encrypt") {
    const passphrase = await readPassphrase(true);
    await writeExclusive(outputPath, encryptBackup(input, passphrase));
    process.stdout.write("Encrypted backup written.\n");
    return;
  }
  if (operation === "decrypt") {
    const passphrase = await readPassphrase(false);
    await writeExclusive(outputPath, decryptBackup(input, passphrase));
    process.stdout.write("Backup authenticated and decrypted for verification.\n");
    return;
  }
  throw new Error(`Unsupported backup operation: ${operation}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
