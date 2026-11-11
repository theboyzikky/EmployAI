import "server-only";
// Meta's app-level webhook (Instagram, Messenger, WhatsApp): verification handshake, signature check,
// and translation of notifications into message.received events for the business that owns the account.
// Pure apart from deliverToRouteKey; unknown accounts are ignored (never another business's data).
import { createHmac, timingSafeEqual } from "node:crypto";
import type { InboundMessagePayload } from "./messaging-contract";
import type { InboundEvent } from "./types";

const env = (k: string) => (process.env[k] ?? "").trim();
const same = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

/** GET handshake: Meta sends hub.mode=subscribe, hub.verify_token, hub.challenge. */
export function verifyMetaHandshake(q: URLSearchParams): string | null {
  const token = env("META_WEBHOOK_VERIFY_TOKEN");
  if (!token || q.get("hub.mode") !== "subscribe" || !same(q.get("hub.verify_token") ?? "", token)) return null;
  const challenge = q.get("hub.challenge") ?? "";
  return /^[A-Za-z0-9_-]{1,128}$/.test(challenge) ? challenge : null;
}

/** POST signature: X-Hub-Signature-256 = "sha256=" + HMAC-SHA256(raw body, app secret). Either Meta app secret may sign. */
export function metaSignatureOk(rawBody: string, header: string | null): boolean {
  const m = /^sha256=([a-f0-9]{64})$/.exec(header ?? "");
  if (!m) return false;
  return ["FACEBOOK_APP_SECRET", "INSTAGRAM_APP_SECRET"].map(env).filter(Boolean).some(secret => same(createHmac("sha256", secret).update(rawBody).digest("hex"), m[1]));
}

const ev = (externalId: string, p: InboundMessagePayload): InboundEvent => ({ externalId, type: "message.received", occurredAt: p.sent_at, subject: p.thread, payload: p });
const iso = (ms: unknown) => (typeof ms === "number" && ms > 0 ? new Date(ms > 1e12 ? ms : ms * 1000).toISOString() : null);

type Messaging = { sender?: { id?: string }; recipient?: { id?: string }; timestamp?: number; message?: { mid?: string; text?: string; is_echo?: boolean; attachments?: unknown[] } };
type WaValue = { metadata?: { phone_number_id?: string }; contacts?: Array<{ wa_id?: string; profile?: { name?: string } }>; messages?: Array<{ id?: string; from?: string; timestamp?: string; type?: string; text?: { body?: string } }> };

/** Group a verified notification's customer messages by the account (route key) they belong to. */
export function parseMetaNotification(body: unknown): Map<string, InboundEvent[]> {
  const out = new Map<string, InboundEvent[]>();
  const add = (key: string, e: InboundEvent) => out.set(key, [...(out.get(key) ?? []), e]);
  const b = body as { object?: string; entry?: Array<{ id?: string; messaging?: Messaging[]; changes?: Array<{ field?: string; value?: WaValue }> }> };
  for (const entry of b?.entry ?? []) {
    if (b.object === "instagram" || b.object === "page") {
      const channel = b.object === "instagram" ? "instagram" : "messenger";
      const key = `meta:${b.object === "instagram" ? "ig" : "page"}:${entry.id}`;
      for (const m of entry.messaging ?? []) {
        const msg = m.message;
        if (!msg?.mid || msg.is_echo || !m.sender?.id || m.sender.id === entry.id) continue;   // our own sends echo back
        const text = (msg.text ?? (msg.attachments?.length ? "[an attachment]" : "")).slice(0, 4000);
        if (!text) continue;
        add(key, ev(msg.mid, { channel, thread: m.sender.id, from: null, text, message_id: msg.mid, sent_at: iso(m.timestamp), context: {} }));
      }
    } else if (b.object === "whatsapp_business_account") {
      for (const ch of entry.changes ?? []) {
        if (ch.field !== "messages" || !ch.value?.metadata?.phone_number_id) continue;
        const key = `meta:wa:${ch.value.metadata.phone_number_id}`;
        const names = new Map((ch.value.contacts ?? []).map(c => [c.wa_id ?? "", c.profile?.name ?? null]));
        for (const m of ch.value.messages ?? []) {                                               // "statuses" (delivery receipts) are not messages
          if (!m.id || !m.from) continue;
          const text = (m.type === "text" ? m.text?.body ?? "" : `[a ${m.type ?? "message"}]`).slice(0, 4000);
          add(key, ev(m.id, { channel: "whatsapp", thread: m.from, from: names.get(m.from) ?? null, text, message_id: m.id, sent_at: iso(Number(m.timestamp)), context: {} }));
        }
      }
    }
  }
  return out;
}
