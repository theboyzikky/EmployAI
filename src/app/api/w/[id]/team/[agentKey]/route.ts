import { jsonError, jsonOk, readBody } from "@/lib/http";
import { AGENT_TEMPLATES, type AgentKey } from "@/lib/catalogue/catalogue";
import { AgentPatchSchema } from "@/lib/catalogue/propose";
import { ownerRoute } from "@/lib/discovery/routes";
import { updateAgent } from "@/lib/discovery/service";
import { buildView } from "@/lib/discovery/view";

const isAgentKey = (k: string): k is AgentKey => Object.hasOwn(AGENT_TEMPLATES, k);

/** PATCH /api/w/[id]/team/[agentKey] — remove/restore an agent, toggle its tasks, add an owner note. */
export function PATCH(request: Request, ctx: RouteContext<"/api/w/[id]/team/[agentKey]">) {
  return ownerRoute(request, ctx.params, async (business, cid) => {
    const { agentKey } = await ctx.params;
    if (!isAgentKey(agentKey)) return jsonError(404, "NOT_FOUND", "That agent isn't part of this proposal.", cid);
    const body = await readBody(request, AgentPatchSchema.refine(p => Object.keys(p).length > 0, "Nothing to change."), cid);
    if ("response" in body) return body.response;
    await updateAgent(business, agentKey, body.data);
    return jsonOk({ view: await buildView(business) }, cid);
  }, { mutation: true });
}
