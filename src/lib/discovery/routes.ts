import "server-only";
import { checkMutation, jsonError, jsonOk, newCorrelationId } from "@/lib/http";
import { getOwnedBusiness } from "./access";
import { ServiceError, type AiFailure } from "./service";
import type { BusinessRecord } from "./store";
import { buildView } from "./view";

type Handler = (business: BusinessRecord, correlationId: string) => Promise<Response>;

/**
 * Shared wrapper for /api/w/[id]/* routes: correlation ID, owner check (404 for anyone else),
 * JSON + same-origin checks on mutations, and one error envelope. Logs codes only, never content.
 */
export async function ownerRoute(request: Request, params: Promise<{ id: string }>, handler: Handler, opts: { mutation: boolean; errorView?: (b: BusinessRecord) => Promise<unknown> }) {
  const correlationId = newCorrelationId();
  if (opts.mutation) {
    const bad = await checkMutation(request, correlationId);
    if (bad) return bad;
  }
  const { id } = await params;
  const business = await getOwnedBusiness(id);
  if (!business) return jsonError(404, "NOT_FOUND", "This conversation doesn't exist, or it belongs to another browser.", correlationId);
  try {
    return await handler(business, correlationId);
  } catch (e) {
    if (e instanceof ServiceError) return jsonError(e.status, e.code, e.message, correlationId, { view: await (opts.errorView ?? buildView)(business) });
    console.error(`[discovery] ${correlationId} unexpected error`);
    return jsonError(500, "INTERNAL", "Something went wrong on our side. Your conversation is saved.", correlationId);
  }
}

/** Respond with the fresh view, or 502 AI_UNAVAILABLE (state preserved, retry possible). */
export async function viewOrAiError(business: BusinessRecord, correlationId: string, aiError: AiFailure | null) {
  const view = await buildView(business);
  if (aiError) return jsonError(502, "AI_UNAVAILABLE", aiError.message, correlationId, { view, ai: aiError });
  return jsonOk({ view }, correlationId);
}
