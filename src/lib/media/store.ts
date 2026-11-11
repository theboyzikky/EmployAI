import "server-only";
// Owner-uploaded product photos. Instagram fetches images from a PUBLIC https URL, so a photo the owner
// uploads is checked (real JPEG bytes, ≤ 4 MB), stored in the shared store under an unguessable id and
// served at /api/media/<id>. Photos are the owner's real product images; nothing here generates images.
// Stored blobs are immutable (written once), so a plain write is used rather than a document commit.
import { randomBytes } from "node:crypto";
import { publicBaseUrl } from "@/lib/automation/dispatch";
import { getKv } from "@/lib/kv";

export const MAX_MEDIA_BYTES = 4 * 1024 * 1024;
export const MEDIA_ID = /^[A-Za-z0-9_-]{24}$/;
const TTL_MS = 60 * 24 * 60 * 60 * 1000;
const key = (id: string) => `media:${id}`;

export const isJpeg = (b: Uint8Array) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

export async function saveJpeg(businessId: string, bytes: Uint8Array): Promise<string> {
  if (bytes.length === 0 || bytes.length > MAX_MEDIA_BYTES) throw new Error("The photo must be a JPEG of at most 4 MB.");
  if (!isJpeg(bytes)) throw new Error("Only JPEG photos are accepted (Instagram publishes JPEG only).");
  const id = randomBytes(18).toString("base64url");
  await getKv().set(key(id), JSON.stringify({ b: businessId, d: Buffer.from(bytes).toString("base64") }), TTL_MS);
  return id;
}

export async function loadMedia(id: string): Promise<{ businessId: string; bytes: Buffer } | null> {
  if (!MEDIA_ID.test(id)) return null;
  const raw = await getKv().get(key(id));
  if (!raw) return null;
  try { const o = JSON.parse(raw) as { b: string; d: string }; return { businessId: o.b, bytes: Buffer.from(o.d, "base64") }; } catch { return null; }
}

/** The public URL Instagram can fetch (null when this server has no public https address, e.g. locally). */
export const publicMediaUrl = (id: string) => { const base = publicBaseUrl(); return base ? `${base}/api/media/${id}` : null; };
