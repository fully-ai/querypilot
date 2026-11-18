import crypto from "node:crypto";
import jwt from "jsonwebtoken";

export interface JwtUser {
  id: string;
  username: string;
  role: "admin" | "editor" | "viewer";
}

export function deriveMasterKey(rawSecret: string): Buffer {
  return crypto.createHash("sha256").update(rawSecret, "utf8").digest();
}

export function encryptSecret(plaintext: string, masterKey: Buffer): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", masterKey, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64url")}.${tag.toString("base64url")}.${enc.toString("base64url")}`;
}

export function decryptSecret(token: string, masterKey: Buffer): string {
  const [ivB64, tagB64, ctB64] = token.split(".");
  if (!ivB64 || !tagB64 || !ctB64) {
    throw new Error("Malformed encrypted connection string");
  }
  const decipher = crypto.createDecipheriv("aes-256-gcm", masterKey, Buffer.from(ivB64, "base64url"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
  const dec = Buffer.concat([decipher.update(Buffer.from(ctB64, "base64url")), decipher.final()]);
  return dec.toString("utf8");
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, expected] = stored.split(":");
  if (!salt || !expected) return false;
  const derived = crypto.scryptSync(password, salt, 64);
  const expBuf = Buffer.from(expected, "hex");
  return derived.length === expBuf.length && crypto.timingSafeEqual(derived, expBuf);
}

export function signToken(user: JwtUser, jwtSecret: string): string {
  return jwt.sign(user, jwtSecret, { expiresIn: "24h" });
}

export function verifyToken(token: string, jwtSecret: string): JwtUser {
  return jwt.verify(token, jwtSecret) as JwtUser;
}

const MUTATING_KEYWORDS = new Set([
  "INSERT",
  "UPDATE",
  "DELETE",
  "DROP",
  "ALTER",
  "CREATE",
  "TRUNCATE",
  "REPLACE",
  "MERGE",
  "UPSERT",
  "GRANT",
  "REVOKE",
  "ATTACH",
  "DETACH",
  "VACUUM",
  "REINDEX",
  "COPY",
  "CALL",
  "DO",
]);

/**
 * Strips SQL comments and string literals, then verifies no mutating keyword
 * appears as a top-level statement keyword in read-only mode.
 */
export function isReadOnlySqlSafe(sql: string): { safe: boolean; reason?: string } {
  const cleaned = sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:''|[^'])*'/g, "''")
    .replace(/"(?:""|[^"])*"/g, '""')
    .trim();

  if (!cleaned) return { safe: false, reason: "Empty SQL query" };

  const tokens = cleaned.toUpperCase().match(/[A-Z_][A-Z0-9_]*/g) ?? [];
  for (const tok of tokens) {
    if (MUTATING_KEYWORDS.has(tok)) {
      return { safe: false, reason: `Keyword '${tok}' is blocked in read-only connection mode` };
    }
    if (tok === "PRAGMA" && /=/.test(cleaned)) {
      return { safe: false, reason: "PRAGMA assignments are blocked in read-only mode" };
    }
  }
  return { safe: true };
}

export function assertValidIdentifier(name: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_$]{0,127}$/.test(name)) {
    throw new Error(`Invalid SQL identifier: ${name}`);
  }
  return name;
}
