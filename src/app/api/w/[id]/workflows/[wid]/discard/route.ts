import { z } from "zod";
import { jsonError, jsonOk, readBody } from "@/lib/http";
import { ownerRoute } from "@/lib/discovery/routes";
import { discardDraft } from "@/lib/workflows/service";
import { buildWorkspaceView } from "@/lib/workflows/view";

/** POST /api/w/[id]/workflows/[wid]/discard — discard a draft. Approved versions stay on record. */
export function POST(request: Request, ctx: RouteContext<"/api/w/[id]/workflows/[wid]/discard">) {
  return ownerRoute(request, ctx.params, async (business, cid) => {
    const { wid } = await ctx.params;
    if (!/^[0-9a-f-]{36}$/i.test(wid)) return jsonError(404, "NOT_FOUND", "That workflow doesn't exist.", cid);
    const body = await readBody(request, z.object({}).strict(), cid);
    if ("response" in body) return body.response;
    await discardDraft(business, wid);
    return jsonOk({ view: await buildWorkspaceView(business) }, cid);
  }, { mutation: true, errorView: buildWorkspaceView });
}
