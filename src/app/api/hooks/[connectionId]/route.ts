import { randomUUID } from "node:crypto";
import { jsonError, jsonOk } from "@/lib/http";
import { limitResponse, limits } from "@/lib/hosted/rate-limit";
import "@/lib/integrations/providers";   // registers the real connectors
import { MAX_INBOUND_BYTES, receiveInbound } from "@/lib/integrations/inbox";

type Ctx = { params: Promise<{ connectionId: string }> };

/**
 * POST /api/hooks/[connectionId] — inbound events from an external system (public: authenticated by the
 * connector's own signature or secret, not by a cookie). Answers fast: 200 once the events are stored
 * (each one exactly once), 401/400 for a bad request, 404 for an unknown or disabled connection, 429 when
 * a connection sends too much, 503 if the shared store is unreachable — providers retry on 429/503, and
 * a retried event is recognised and not stored twice.
 */
export async function POST(request: Request, ctx: Ctx) {
  const cid = randomUUID();
  const { connectionId } = await ctx.params;
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_INBOUND_BYTES) return jsonError(413, "PAYLOAD_TOO_LARGE", "The event is too large.", cid);
  const raw = await request.text();
  const limited = await limitResponse([{ limit: limits().hookPerConnection, subject: connectionId.slice(0, 24) }], cid);
  if (limited) return limited;
  let r;
  try { r = await receiveInbound(connectionId, raw, request.headers); }
  catch { return jsonError(503, "SERVICE_UNAVAILABLE", "Events can't be accepted right now; please retry.", cid); }
  if (r.status !== 200) return jsonError(r.status, r.code, r.status === 404 ? "Unknown connection." : "The event was refused.", cid);
  return jsonOk({ received: r.accepted.length, duplicates: r.duplicates }, cid);
}
