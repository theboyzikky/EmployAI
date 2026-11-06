import { z } from "zod";
import { jsonOk, readBody } from "@/lib/http";
import { ownerRoute } from "@/lib/discovery/routes";
import { generateWorkflow } from "@/lib/workflows/service";
import { buildWorkspaceView } from "@/lib/workflows/view";

/** POST /api/w/[id]/workflows/generate — build (or rebuild) the draft from fixed templates. No AI, nothing runs. */
export function POST(request: Request, ctx: RouteContext<"/api/w/[id]/workflows/generate">) {
  return ownerRoute(request, ctx.params, async (business, cid) => {
    const body = await readBody(request, z.object({}).strict(), cid);
    if ("response" in body) return body.response;
    await generateWorkflow(business);
    return jsonOk({ view: await buildWorkspaceView(business) }, cid);
  }, { mutation: true, errorView: buildWorkspaceView });
}
