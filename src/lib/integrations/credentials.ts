import "server-only";
// Per-business credential encryption for integration connections.
//
//  - AES-256-GCM (authenticated). A fresh 96-bit IV per encryption.
//  - The key is derived PER BUSINESS from APP_ENCRYPTION_KEY with HKDF-SHA256, so one business's key
//    can't decrypt another's secrets.
//  - The business id and connection id are bound in as additional authenticated data: a ciphertext
//    copied to another connection or business fails to decrypt (no swapping).
//  - No key, or a key shorter than 32 characters → CredentialError: nothing can be stored or used
//    (fail closed). Secrets are never logged and never leave the server.
// The ciphertext lives in the shared store; Upstash only ever sees ciphertext.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import type { EncryptedBlob } from "./records";

export class CredentialError extends Error {
  readonly code = "CREDENTIALS_UNAVAILABLE";
  constructor(message: string) { super(message); this.name = "CredentialError"; }
}

const SALT = "employai/credentials/v1";
const b64u = (b: Buffer) => b.toString("base64url");

function businessKey(businessId: string, env: Record<string, string | undefined>): Buffer {
  const master = env.APP_ENCRYPTION_KEY ?? "";
  if (master.length < 32) throw new CredentialError("Integration credentials can't be stored or used: APP_ENCRYPTION_KEY isn't set to a strong value on this server.");
  return Buffer.from(hkdfSync("sha256", Buffer.from(master, "utf8"), Buffer.from(SALT, "utf8"), Buffer.from(`business:${businessId}`, "utf8"), 32));
}
const aad = (businessId: string, connectionId: string) => Buffer.from(`employai:credentials:v1:${businessId}:${connectionId}`, "utf8");

export function encryptSecrets(businessId: string, connectionId: string, secrets: Record<string, string>, env: Record<string, string | undefined> = process.env): EncryptedBlob {
  const key = businessKey(businessId, env);
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(aad(businessId, connectionId));
  const ct = Buffer.concat([c.update(JSON.stringify(secrets), "utf8"), c.final()]);
  return { v: 1, alg: "A256GCM", iv: b64u(iv), tag: b64u(c.getAuthTag()), ct: b64u(ct) };
}

export function decryptSecrets(businessId: string, connectionId: string, blob: EncryptedBlob, env: Record<string, string | undefined> = process.env): Record<string, string> {
  if (blob?.v !== 1 || blob.alg !== "A256GCM") throw new CredentialError("Unsupported credential format.");
  const key = businessKey(businessId, env);
  try {
    const d = createDecipheriv("aes-256-gcm", key, Buffer.from(blob.iv, "base64url"));
    d.setAAD(aad(businessId, connectionId));
    d.setAuthTag(Buffer.from(blob.tag, "base64url"));
    const out = JSON.parse(Buffer.concat([d.update(Buffer.from(blob.ct, "base64url")), d.final()]).toString("utf8")) as unknown;
    if (!out || typeof out !== "object" || Array.isArray(out) || Object.values(out).some(v => typeof v !== "string")) throw new Error("shape");
    return out as Record<string, string>;
  } catch {
    // Never echo why: a wrong key, a tampered blob and a swapped blob look the same from outside.
    throw new CredentialError("A connection's credentials couldn't be decrypted.");
  }
}

/** A random secret (URL-safe), e.g. for signing webhooks. */
export const newSecret = (bytes = 32) => b64u(randomBytes(bytes));
