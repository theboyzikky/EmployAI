import { jsonError } from "@/lib/http";
import { UUID, runResponse, runsRoute } from "@/lib/runs/routes";

type Ctx = { params: Promise<{ id: string; runId: string }> };

/** GET /api/w/[id]/runs/[runId] — the run view. Strictly read-only: never executes or persists anything. */
export function GET(request: Request, ctx: Ctx) {
  return runsRoute(request, ctx.params, async (business, cid) => {
    const { runId } = await ctx.params;
    if (!UUID.test(runId)) return jsonError(404, "NOT_FOUND", "That run doesn't exist.", cid);
    return runResponse(business, runId, cid);
  }, { mutation: false });
}
