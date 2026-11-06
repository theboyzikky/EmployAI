import { z } from "zod";
import { jsonOk, readBody } from "@/lib/http";
import { ownerRoute } from "@/lib/discovery/routes";
import { approveTeam } from "@/lib/discovery/service";
import { buildView } from "@/lib/discovery/view";

/** POST /api/w/[id]/team/approve — records the owner's approval. Deploys and executes nothing. */
export function POST(request: Request, ctx: RouteContext<"/api/w/[id]/team/approve">) {
  return ownerRoute(request, ctx.params, async (business, cid) => {
    const body = await readBody(request, z.object({}).strict(), cid);
    if ("response" in body) return body.response;
    await approveTeam(business);
    return jsonOk({ view: await buildView(business) }, cid);
  }, { mutation: true });
}
