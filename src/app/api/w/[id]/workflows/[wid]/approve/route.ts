import { z } from "zod";
import { jsonError, jsonOk, readBody } from "@/lib/http";
import { ownerRoute } from "@/lib/discovery/routes";
import { approveWorkflow } from "@/lib/workflows/service";
import { buildWorkspaceView } from "@/lib/workflows/view";

/**
 * POST /api/w/[id]/workflows/[wid]/approve — the owner approves a draft. It is re-validated against the
 * current team first; a workflow with any failed check is refused (409). Approval does not run it.
 */
export function POST(request: Request, ctx: RouteContext<"/api/w/[id]/workflows/[wid]/approve">) {
  return ownerRoute(request, ctx.params, async (business, cid) => {
    const { wid } = await ctx.params;
    if (!/^[0-9a-f-]{36}$/i.test(wid)) return jsonError(404, "NOT_FOUND", "That workflow doesn't exist.", cid);
    const body = await readBody(request, z.object({}).strict(), cid);
    if ("response" in body) return body.response;
    await approveWorkflow(business, wid);
    return jsonOk({ view: await buildWorkspaceView(business) }, cid);
  }, { mutation: true, errorView: buildWorkspaceView });
}
