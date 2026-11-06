import { z } from "zod";
import { readBody } from "@/lib/http";
import { ownerRoute, viewOrAiError } from "@/lib/discovery/routes";
import { analyse } from "@/lib/discovery/service";

/** POST /api/w/[id]/discovery/analyse — stage 3: analyse operations from the owner's answers. */
export function POST(request: Request, ctx: RouteContext<"/api/w/[id]/discovery/analyse">) {
  return ownerRoute(request, ctx.params, async (business, cid) => {
    const body = await readBody(request, z.object({}).strict(), cid);
    if ("response" in body) return body.response;
    const { aiError } = await analyse(business);
    return viewOrAiError(business, cid, aiError);
  }, { mutation: true });
}
