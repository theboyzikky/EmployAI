import { randomUUID } from "node:crypto";
import { jsonError, jsonOk } from "@/lib/http";
import "@/lib/integrations/providers";
import "@/lib/automation/handlers";
import { sweepAfterResponse, wake } from "@/lib/automation/dispatch";
import { enqueueTaskIn } from "@/lib/automation/tasks";
import { deliverToRouteKey } from "@/lib/integrations/inbox";
import { metaSignatureOk, parseMetaNotification, verifyMetaHandshake } from "@/lib/integrations/meta-webhook";

const MAX_BYTES = 256 * 1024;

/** GET /api/hooks/meta — Meta's verification handshake (the verify token set in the App Dashboard). */
export function GET(request: Request) {
  const challenge = verifyMetaHandshake(new URL(request.url).searchParams);
  return challenge ? new Response(challenge, { status: 200, headers: { "Content-Type": "text/plain" } }) : new Response("Forbidden", { status: 403 });
}

/**
 * POST /api/hooks/meta — Instagram, Messenger and WhatsApp notifications for every connected account.
 * Signed by Meta (X-Hub-Signature-256); each message is stored once for the business that owns the
 * account and processed by the background worker. Meta retries non-200 answers for up to 36 hours.
 */
export async function POST(request: Request) {
  const cid = randomUUID();
  if (Number(request.headers.get("content-length") ?? "0") > MAX_BYTES) return jsonError(413, "PAYLOAD_TOO_LARGE", "Too large.", cid);
  const raw = await request.text();
  if (!metaSignatureOk(raw, request.headers.get("x-hub-signature-256"))) return jsonError(401, "BAD_SIGNATURE", "Unauthorised.", cid);
  let body: unknown;
  try { body = JSON.parse(raw); } catch { return jsonError(400, "INVALID_JSON", "Invalid notification.", cid); }
  const woke = new Set<string>();
  try {
    for (const [key, events] of parseMetaNotification(body)) {
      const r = await deliverToRouteKey(key, events, (s, ev) => { enqueueTaskIn(s, ev.business_id, { kind: "process_event", ref: ev.id, dedupeKey: `event:${ev.id}` }); });
      if (r?.accepted.length) woke.add(r.businessId);
    }
  } catch { return jsonError(503, "SERVICE_UNAVAILABLE", "Please retry.", cid); }
  for (const b of woke) await wake(b);
  sweepAfterResponse();
  return jsonOk({ ok: true }, cid);
}
