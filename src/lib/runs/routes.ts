import "server-only";
// M4 · Shared helpers for the run routes (all under /api/w/:id/…, D12). Every route goes through
// ownerRoute: owner only (404 otherwise, nothing leaked), JSON + same-origin on mutations, one error
// envelope. GET handlers only read (D11).
import { z } from "zod";
import { jsonError, jsonOk } from "@/lib/http";
import { ownerRoute } from "@/lib/discovery/routes";
import type { BusinessRecord } from "@/lib/discovery/store";
import { buildRunView, buildRunsView } from "./view";

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,100}$/;
export const EmptyBody = z.object({}).strict();

type Handler = (business: BusinessRecord, correlationId: string) => Promise<Response>;

export function runsRoute(request: Request, params: Promise<{ id: string }>, handler: Handler, opts: { mutation: boolean }) {
  return ownerRoute(request, params, handler, { mutation: opts.mutation, errorView: buildRunsView });
}

/** Respond with the run view (and the business-level runs view). */
export async function runResponse(business: BusinessRecord, runId: string, correlationId: string, extra: Record<string, unknown> = {}) {
  const run = await buildRunView(business, runId);
  if (!run) return jsonError(404, "NOT_FOUND", "That run doesn't exist.", correlationId);
  return jsonOk({ run, view: await buildRunsView(business), ...extra }, correlationId);
}
