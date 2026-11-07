import { z } from "zod";
import { jsonError, jsonOk, readBody } from "@/lib/http";
import { AGENT_TEMPLATES, type AgentKey } from "@/lib/catalogue/catalogue";
import { AgentPatchSchema } from "@/lib/catalogue/propose";
import { ownerRoute } from "@/lib/discovery/routes";
import { updateAgent } from "@/lib/discovery/service";
import { buildView } from "@/lib/discovery/view";
import { setAgentPaused } from "@/lib/runs/runner";
import { buildRunsView } from "@/lib/runs/view";

const isAgentKey = (k: string): k is AgentKey => Object.hasOwn(AGENT_TEMPLATES, k);

/** M4 · D4: pause or resume an APPROVED agent (its steps don't start while paused). */
const PauseSchema = z.object({ status: z.enum(["paused", "approved"]) }).strict();

/**
 * PATCH /api/w/[id]/team/[agentKey] — before approval: remove/restore an agent, toggle its tasks, add an
 * owner note. After approval (M4): `{ status: "paused" | "approved" }` pauses or resumes the agent.
 */
export function PATCH(request: Request, ctx: RouteContext<"/api/w/[id]/team/[agentKey]">) {
  return ownerRoute(request, ctx.params, async (business, cid) => {
    const { agentKey } = await ctx.params;
    if (!isAgentKey(agentKey)) return jsonError(404, "NOT_FOUND", "That agent isn't part of this proposal.", cid);
    const raw = await request.clone().json().catch(() => null) as unknown;
    if (PauseSchema.safeParse(raw).success) {
      const body = await readBody(request, PauseSchema, cid);
      if ("response" in body) return body.response;
      await setAgentPaused(business.id, agentKey, body.data.status === "paused");
      return jsonOk({ runs: await buildRunsView(business) }, cid);
    }
    const body = await readBody(request, AgentPatchSchema.refine(p => Object.keys(p).length > 0, "Nothing to change."), cid);
    if ("response" in body) return body.response;
    await updateAgent(business, agentKey, body.data);
    return jsonOk({ view: await buildView(business) }, cid);
  }, { mutation: true });
}
