/**
 * Secrets at rest. AES-256-GCM (authenticated): a tampered or truncated ciphertext fails to
 * decrypt instead of yielding garbage. Format: `v1.<iv b64url>.<tag b64url>.<ciphertext b64url>`.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "crypto";
import { config } from "../config.js";

const key = () => Buffer.from(config.ENCRYPTION_KEY, "hex");

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), data.toString("base64url")].join(".");
}

export function decrypt(stored: string): string {
  const parts = String(stored || "").split(".");
  if (parts.length !== 4 || parts[0] !== "v1") throw new Error("unreadable secret (unknown format)");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(parts[1], "base64url"));
  decipher.setAuthTag(Buffer.from(parts[2], "base64url"));
  try {
    return Buffer.concat([decipher.update(Buffer.from(parts[3], "base64url")), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("unreadable secret (wrong ENCRYPTION_KEY or corrupted value)");
  }
}

/** One-way fingerprint of a secret that only ever needs to be compared (API keys, tool secrets). */
export function hashSecret(secret: string): string {
  return createHash("sha256").update(String(secret)).digest("hex");
}

/** Constant-time comparison of a presented secret against a stored fingerprint. */
export function secretMatchesHash(presented: string, storedHash: string): boolean {
  if (!presented || !storedHash) return false;
  const a = Buffer.from(hashSecret(presented), "hex");
  const b = Buffer.from(storedHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** A new random secret, URL-safe. */
export function newSecret(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}
