import { z } from "zod";
import { jsonOk, readBody } from "@/lib/http";
import { ownerRoute } from "@/lib/discovery/routes";
import { proposeTeamFor } from "@/lib/discovery/service";
import { buildView } from "@/lib/discovery/view";

/** POST /api/w/[id]/team/propose — deterministic proposal from the CONFIRMED summary (409 before). */
export function POST(request: Request, ctx: RouteContext<"/api/w/[id]/team/propose">) {
  return ownerRoute(request, ctx.params, async (business, cid) => {
    const body = await readBody(request, z.object({}).strict(), cid);
    if ("response" in body) return body.response;
    await proposeTeamFor(business);
    return jsonOk({ view: await buildView(business) }, cid);
  }, { mutation: true });
}
