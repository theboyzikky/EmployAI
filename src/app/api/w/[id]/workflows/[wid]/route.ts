import { z } from "zod";
import { jsonError, jsonOk, readBody } from "@/lib/http";
import { ownerRoute } from "@/lib/discovery/routes";
import { updateWorkflowSettings } from "@/lib/workflows/service";
import { buildWorkspaceView } from "@/lib/workflows/view";

const isId = (s: string) => /^[0-9a-f-]{36}$/i.test(s);

/** Only these settings can be edited; steps, agents, tools and payment routing can't. */
const SettingsPatch = z.object({
  approval_threshold_ngn: z.number().int().optional(),
  max_payment_ngn: z.number().int().optional(),
  notify_customer: z.boolean().optional(),
  notify_owner: z.boolean().optional(),
}).strict().refine(p => Object.keys(p).length > 0, "Nothing to change.");

/**
 * PATCH /api/w/[id]/workflows/[wid] — edit settings. A draft is rebuilt and re-checked; an approved
 * version is locked, so the change becomes a new draft version.
 */
export function PATCH(request: Request, ctx: RouteContext<"/api/w/[id]/workflows/[wid]">) {
  return ownerRoute(request, ctx.params, async (business, cid) => {
    const { wid } = await ctx.params;
    if (!isId(wid)) return jsonError(404, "NOT_FOUND", "That workflow doesn't exist.", cid);
    const body = await readBody(request, z.object({ settings: SettingsPatch }).strict(), cid);
    if ("response" in body) return body.response;
    await updateWorkflowSettings(business, wid, body.data.settings);
    return jsonOk({ view: await buildWorkspaceView(business) }, cid);
  }, { mutation: true, errorView: buildWorkspaceView });
}
