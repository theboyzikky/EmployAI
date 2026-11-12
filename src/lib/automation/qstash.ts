import "server-only";
// QStash (Upstash) over its REST API, with no SDK: publish a wake-up, and verify a delivery's signature.
// QStash is a WAKE-UP channel only. Tasks live in the shared store; if QStash is down, out of quota or
// misconfigured, publish() reports it and the caller carries on (after() and the recovery sweep still
// process the work). publish() never throws.
//
// Signature (per Upstash's reference receiver): header "Upstash-Signature" = a JWT signed HS256 with the
// current OR next signing key (raw UTF-8 bytes); claims iss "Upstash", sub = the exact destination URL,
// exp/nbf, body = unpadded base64url(SHA-256(raw body)).
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

type Env = Record<string, string | undefined>;

export function qstashConfig(env: Env = process.env) {
  const token = env.QSTASH_TOKEN;
  const base = (env.QSTASH_URL || "https://qstash.upstash.io").replace(/\/$/, "");
  const keys = [env.QSTASH_CURRENT_SIGNING_KEY, env.QSTASH_NEXT_SIGNING_KEY].filter((k): k is string => !!k && k.length >= 16);
  return { canPublish: !!token && base.startsWith("https://"), canVerify: keys.length > 0, token, base, keys };
}

export type PublishResult = { ok: true; messageId: string | null } | { ok: false; reason: string };

/** Ask QStash to POST `body` to `url` (after `delaySeconds`). Never throws. */
export async function qstashPublish(url: string, body: Record<string, unknown>, o: { delaySeconds?: number; dedupeId?: string; retries?: number } = {}, env: Env = process.env, fetchImpl: typeof fetch = fetch): Promise<PublishResult> {
  const c = qstashConfig(env);
  if (!c.canPublish) return { ok: false, reason: "QSTASH_NOT_CONFIGURED" };
  if (!/^https:\/\//.test(url)) return { ok: false, reason: "DESTINATION_NOT_HTTPS" };
  const headers: Record<string, string> = { Authorization: `Bearer ${c.token}`, "Content-Type": "application/json", "Upstash-Retries": String(o.retries ?? 3) };
  if (o.delaySeconds && o.delaySeconds > 0) headers["Upstash-Delay"] = `${Math.min(604_800, Math.ceil(o.delaySeconds))}s`;
  if (o.dedupeId) headers["Upstash-Deduplication-Id"] = o.dedupeId.replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, 100);
  try {
    const res = await fetchImpl(`${c.base}/v2/publish/${url}`, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return { ok: false, reason: res.status === 429 ? "QSTASH_RATE_OR_QUOTA_LIMIT" : `QSTASH_HTTP_${res.status}` };
    const j = await res.json().catch(() => ({})) as { messageId?: string };
    return { ok: true, messageId: j.messageId ?? null };
  } catch {
    return { ok: false, reason: "QSTASH_UNREACHABLE" };
  }
}

const b64uDecode = (s: string) => Buffer.from(s, "base64url");
const sha256b64u = (s: string) => createHash("sha256").update(s, "utf8").digest("base64url");

/** Verify a QStash delivery. `url` must be the exact destination URL that was published to. */
export function qstashVerify(o: { signature: string | null; rawBody: string; url: string; nowS?: number }, env: Env = process.env): boolean {
  const c = qstashConfig(env);
  if (!c.canVerify || !o.signature) return false;
  const parts = o.signature.split(".");
  if (parts.length !== 3) return false;
  let header: { alg?: string; typ?: string }, payload: { iss?: string; sub?: string; exp?: number; nbf?: number; body?: string };
  try { header = JSON.parse(b64uDecode(parts[0]).toString("utf8")); payload = JSON.parse(b64uDecode(parts[1]).toString("utf8")); } catch { return false; }
  if (header.alg !== "HS256") return false;                         // never "none", never another algorithm
  const signed = `${parts[0]}.${parts[1]}`;
  const given = b64uDecode(parts[2]);
  const ok = c.keys.some(k => { const want = createHmac("sha256", Buffer.from(k, "utf8")).update(signed).digest(); return want.length === given.length && timingSafeEqual(want, given); });
  if (!ok) return false;
  const now = o.nowS ?? Math.floor(Date.now() / 1000);
  if (payload.iss !== "Upstash" || payload.sub !== o.url) return false;
  if (typeof payload.exp !== "number" || payload.exp < now) return false;
  if (typeof payload.nbf === "number" && payload.nbf > now) return false;
  return (payload.body ?? "").replace(/=+$/, "") === sha256b64u(o.rawBody);
}
