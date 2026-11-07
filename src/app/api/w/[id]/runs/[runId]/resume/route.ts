import { jsonError, readBody } from "@/lib/http";
import { EmptyBody, UUID, runResponse, runsRoute } from "@/lib/runs/routes";
import { resumeRun } from "@/lib/runs/runner";

type Ctx = { params: Promise<{ id: string; runId: string }> };

/** POST /api/w/[id]/runs/[runId]/resume — a paused or interrupted run becomes running again. Executes no step. */
export function POST(request: Request, ctx: Ctx) {
  return runsRoute(request, ctx.params, async (business, cid) => {
    const { runId } = await ctx.params;
    if (!UUID.test(runId)) return jsonError(404, "NOT_FOUND", "That run doesn't exist.", cid);
    const body = await readBody(request, EmptyBody, cid);
    if ("response" in body) return body.response;
    await resumeRun(business.id, runId);
    return runResponse(business, runId, cid, { more: true });
  }, { mutation: true });
}
