import { randomUUID } from "node:crypto";
import { jsonError, jsonOk } from "@/lib/http";
import "@/lib/integrations/providers";
import "@/lib/automation/handlers";
import { sweepAfterResponse, wake } from "@/lib/automation/dispatch";
import { enqueueTaskIn } from "@/lib/automation/tasks";
import { MAX_INBOUND_BYTES } from "@/lib/integrations/inbox";
import { handleTelegramUpdate, telegramSecretOk } from "@/lib/integrations/telegram-link";

/**
 * POST /api/hooks/telegram — the single webhook of EmployAI's Telegram bot (registered by the operator
 * with setWebhook and a secret token). Carries owners' link confirmations and business connection
 * changes, and customers' business messages. Answers 200 once handled; a retried update is deduplicated.
 */
export async function POST(request: Request) {
  const cid = randomUUID();
  if (!telegramSecretOk(request.headers.get("x-telegram-bot-api-secret-token"))) return jsonError(401, "BAD_SECRET", "Unauthorised.", cid);
  if (Number(request.headers.get("content-length") ?? "0") > MAX_INBOUND_BYTES) return jsonError(413, "PAYLOAD_TOO_LARGE", "Too large.", cid);
  let update: unknown;
  try { update = JSON.parse(await request.text()); } catch { return jsonError(400, "INVALID_JSON", "Invalid update.", cid); }
  if (!update || typeof (update as { update_id?: unknown }).update_id !== "number") return jsonError(400, "INVALID_UPDATE", "Invalid update.", cid);
  let businessId: string | null;
  try { businessId = await handleTelegramUpdate(update as Parameters<typeof handleTelegramUpdate>[0], (s, ev) => { enqueueTaskIn(s, ev.business_id, { kind: "process_event", ref: ev.id, dedupeKey: `event:${ev.id}` }); }); }
  catch { return jsonError(503, "SERVICE_UNAVAILABLE", "Please retry.", cid); }   // Telegram retries non-2xx
  if (businessId) await wake(businessId);
  sweepAfterResponse();
  return jsonOk({ ok: true }, cid);
}
