import { randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { jsonError, jsonOk } from "@/lib/http";
import "@/lib/integrations/providers";   // registers the real connectors
import "@/lib/chain/live";                 // registers the NEAR testnet payment port (to finish testnet runs)
import "@/lib/automation/handlers";      // registers the task handlers
import "@/lib/automation/run-handlers";  // advance_run
import { sweep, wake, workerUrl } from "@/lib/automation/dispatch";
import { qstashVerify } from "@/lib/automation/qstash";
import { runDueTasks } from "@/lib/automation/worker";

// Long enough for a batch of tasks; well inside Vercel Hobby's 300 s.
export const maxDuration = 180;

const Body = z.object({ business_id: z.uuid().optional() }).strict();

const bearerMatches = (header: string | null, secret: string) => {
  const a = Buffer.from(header ?? ""), b = Buffer.from(`Bearer ${secret}`);
  return a.length === b.length && timingSafeEqual(a, b);
};

/** Callers: QStash (signed) or an operator/cron with EMPLOYAI_WORKER_SECRET (≥ 32 characters). */
function authorised(request: Request, rawBody: string): boolean {
  const url = workerUrl();
  if (url && qstashVerify({ signature: request.headers.get("upstash-signature"), rawBody, url })) return true;
  const secret = process.env.EMPLOYAI_WORKER_SECRET ?? "";
  return secret.length >= 32 && bearerMatches(request.headers.get("authorization"), secret);
}

/**
 * POST /api/worker — run due automation tasks: for one business ({ business_id }) or a recovery sweep ({}).
 * Idempotent and safe to call repeatedly or concurrently (leases). 401 unless signed by QStash or carrying
 * the worker secret; 503 when the shared store is unreachable (QStash retries; nothing is lost).
 */
export async function POST(request: Request) {
  const cid = randomUUID();
  const raw = await request.text();
  if (raw.length > 2_000) return jsonError(413, "PAYLOAD_TOO_LARGE", "Too large.", cid);
  if (!authorised(request, raw)) return jsonError(401, "UNAUTHORISED", "Not allowed.", cid);
  let parsed;
  try { parsed = Body.safeParse(raw ? JSON.parse(raw) : {}); } catch { return jsonError(400, "VALIDATION_FAILED", "Invalid body.", cid); }
  if (!parsed.success) return jsonError(400, "VALIDATION_FAILED", "Invalid body.", cid);
  try {
    if (parsed.data.business_id) {
      const r = await runDueTasks(parsed.data.business_id, { deadlineMs: 45_000 });
      if (r.nextDueAt) await wake(parsed.data.business_id, { atIso: r.nextDueAt });   // schedule what's left
      return jsonOk({ processed: r.processed, next_due_at: r.nextDueAt }, cid);
    }
    return jsonOk(await sweep({ deadlineMs: 45_000 }), cid);
  } catch {
    return jsonError(503, "SERVICE_UNAVAILABLE", "The shared store can't be reached; retry later.", cid);
  }
}

/** GET /api/worker — the daily Vercel cron (Authorization: Bearer CRON_SECRET): a recovery sweep. */
export async function GET(request: Request) {
  const cid = randomUUID();
  const secret = process.env.CRON_SECRET ?? "";
  if (secret.length < 16 || !bearerMatches(request.headers.get("authorization"), secret)) return jsonError(401, "UNAUTHORISED", "Not allowed.", cid);
  try { return jsonOk(await sweep({ deadlineMs: 45_000 }), cid); }
  catch { return jsonError(503, "SERVICE_UNAVAILABLE", "The shared store can't be reached; retry later.", cid); }
}
