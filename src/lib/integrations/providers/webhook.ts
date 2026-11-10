import "server-only";
// REAL connector: generic signed webhooks (developer integrations). Any external system — a POS, an
// inventory or order system, a supplier platform, a custom script — can send business events in, and
// employees granted "webhook.deliver" can send events out. No vendor account is needed.
//
// Inbound:  POST /api/hooks/<connectionId>
//   X-EmployAI-Timestamp: <unix seconds>            (must be within 5 minutes)
//   X-EmployAI-Signature: v1=<hex HMAC-SHA256(inbound secret, "<timestamp>.<raw body>")>
//   body: { "id": "<unique event id>", "type": "<one of EVENT_TYPES>", "occurred_at"?: ISO, "subject"?: string, "data": {…} }
// Outbound (webhook.deliver): POST <target_url> with the same signature scheme (outbound secret) and an
//   Idempotency-Key header that stays the same on every re-send of one action. Receivers must use it to
//   ignore repeats — that is what makes a bounded re-send after an unknown outcome safe.
import { createHmac, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { z } from "zod";
import { newSecret } from "../credentials";
import type { ActionOutcome, Connector, InboundVerdict } from "../types";

export const WEBHOOK_EVENT_TYPES = ["order.created", "order.updated", "stock.changed", "message.received", "customer.updated", "invoice.created", "custom.event"] as const;
const TOLERANCE_S = 300;
const TIMEOUT_MS = 10_000;

const InboundBody = z.object({
  id: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/),
  type: z.enum(WEBHOOK_EVENT_TYPES),
  occurred_at: z.iso.datetime({ offset: true }).optional(),
  subject: z.string().max(128).optional(),
  data: z.record(z.string(), z.unknown()),
}).strict();
const DeliverInput = z.object({ type: z.enum(WEBHOOK_EVENT_TYPES), data: z.record(z.string(), z.unknown()) }).strict();

export const sign = (secret: string, ts: string, body: string) => `v1=${createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex")}`;

function signatureMatches(expected: string, given: string | null): boolean {
  if (!given) return false;
  const a = Buffer.from(expected), b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Private, loopback, link-local, CGNAT, multicast and unique-local addresses are never delivery targets (SSRF). */
export function isPublicAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224);
  }
  const v = ip.toLowerCase();
  if (v.startsWith("::ffff:")) return isPublicAddress(v.slice(7));
  return !(v === "::" || v === "::1" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe8") || v.startsWith("fe9") || v.startsWith("fea") || v.startsWith("feb") || v.startsWith("ff"));
}

function targetUrl(raw: unknown): string {
  if (typeof raw !== "string" || raw.length > 2048) throw new Error("The delivery URL is invalid.");
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error("The delivery URL is invalid."); }
  if (u.protocol !== "https:") throw new Error("The delivery URL must use https.");
  if (u.username || u.password) throw new Error("The delivery URL can't contain credentials.");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || (isIP(host) && !isPublicAddress(host))) throw new Error("The delivery URL must be a public address.");
  return u.toString();
}

/** Injectable for tests (the real resolver otherwise). */
export const webhookNet = {
  resolve: async (host: string): Promise<string[]> => (await lookup(host, { all: true })).map(r => r.address),
  fetch: (url: string, init: RequestInit) => fetch(url, init),
};

export const webhookConnector: Connector = {
  key: "webhook",
  name: "Webhook (signed)",
  kind: "developer",
  reality: "real",
  eventTypes: WEBHOOK_EVENT_TYPES,
  setup(input) {
    const i = (input ?? {}) as { target_url?: unknown };
    const config: Record<string, unknown> = {};
    if (i.target_url !== undefined && i.target_url !== "") config.target_url = targetUrl(i.target_url);
    const inbound = newSecret(), outbound = newSecret();
    return { config, secrets: { inbound_secret: inbound, outbound_secret: outbound }, revealOnce: { inbound_secret: inbound, outbound_secret: outbound } };
  },
  inbound({ rawBody, headers, secrets, now }): InboundVerdict {
    const ts = headers.get("x-employai-timestamp") ?? "";
    if (!/^\d{9,11}$/.test(ts) || Math.abs(now / 1000 - Number(ts)) > TOLERANCE_S) return { ok: false, status: 401, code: "STALE_OR_MISSING_TIMESTAMP" };
    if (!secrets.inbound_secret || !signatureMatches(sign(secrets.inbound_secret, ts, rawBody), headers.get("x-employai-signature"))) return { ok: false, status: 401, code: "BAD_SIGNATURE" };
    let json: unknown;
    try { json = JSON.parse(rawBody); } catch { return { ok: false, status: 400, code: "INVALID_JSON" }; }
    const p = InboundBody.safeParse(json);
    if (!p.success) return { ok: false, status: 400, code: "INVALID_EVENT" };
    return { ok: true, events: [{ externalId: p.data.id, type: p.data.type, occurredAt: p.data.occurred_at ?? null, subject: p.data.subject ?? null, payload: p.data.data }] };
  },
  actions: {
    "webhook.deliver": {
      sideEffect: "write",
      idempotency: "provider_key",
      parse: input => DeliverInput.parse(input),
      async execute(ctx, input): Promise<ActionOutcome> {
        let url: string;
        try { url = targetUrl(ctx.config.target_url); } catch { return { kind: "rejected", retryable: false, code: "NO_TARGET", detail: "This connection has no valid delivery URL." }; }
        // Resolve and check every address BEFORE sending (nothing has been sent if this refuses).
        try {
          const addrs = await webhookNet.resolve(new URL(url).hostname.replace(/^\[|\]$/g, ""));
          if (addrs.length === 0 || addrs.some(a => !isPublicAddress(a))) return { kind: "rejected", retryable: false, code: "TARGET_NOT_ALLOWED", detail: "The delivery URL doesn't resolve to a public address." };
        } catch { return { kind: "rejected", retryable: true, code: "DNS_FAILED", detail: "The delivery URL couldn't be resolved; nothing was sent." }; }
        const body = JSON.stringify({ id: ctx.idempotencyKey, type: input.type, data: input.data, sent_at: new Date().toISOString() });
        const ts = String(Math.floor(Date.now() / 1000));
        let res: Response;
        try {
          res = await webhookNet.fetch(url, {
            method: "POST", redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS),
            headers: { "content-type": "application/json", "idempotency-key": ctx.idempotencyKey, "x-employai-timestamp": ts, "x-employai-signature": sign(ctx.secrets.outbound_secret ?? "", ts, body) },
            body,
          });
        } catch {
          // A timeout or a reset after the request may have arrived: we can't know.
          return { kind: "unknown", detail: "No answer from the delivery URL (timeout or connection error)." };
        }
        if (res.status >= 200 && res.status < 300) return { kind: "done", ref: res.headers.get("x-request-id"), detail: `HTTP ${res.status}` };
        if (res.status === 429) return { kind: "rejected", retryable: true, code: "RATE_LIMITED", detail: "The receiver asked us to slow down (HTTP 429)." };
        if (res.status === 408 || res.status >= 500) return { kind: "unknown", detail: `The receiver answered HTTP ${res.status}.` };
        return { kind: "rejected", retryable: false, code: `HTTP_${res.status}`, detail: `The receiver refused the delivery (HTTP ${res.status}).` };
      },
    },
  },
};
