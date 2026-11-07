import { jsonError, readBody } from "@/lib/http";
import { EmptyBody, UUID, runResponse, runsRoute } from "@/lib/runs/routes";
import { requestControl } from "@/lib/runs/runner";

type Ctx = { params: Promise<{ id: string; runId: string }> };

/**
 * POST /api/w/[id]/runs/[runId]/stop — the request is persisted at once (even during a batch); a step in
 * progress can't commit, the run is cancelled and its pending approval invalidated. Executes no step.
 */
export function POST(request: Request, ctx: Ctx) {
  return runsRoute(request, ctx.params, async (business, cid) => {
    const { runId } = await ctx.params;
    if (!UUID.test(runId)) return jsonError(404, "NOT_FOUND", "That run doesn't exist.", cid);
    const body = await readBody(request, EmptyBody, cid);
    if ("response" in body) return body.response;
    const r = await requestControl(business.id, runId, "stop");
    return runResponse(business, runId, cid, { finalised: r.finalised });
  }, { mutation: true });
}
