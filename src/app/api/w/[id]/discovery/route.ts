import { z } from "zod";
import { readBody, jsonOk } from "@/lib/http";
import { ownerRoute } from "@/lib/discovery/routes";
import { FieldEditsSchema } from "@/lib/discovery/schemas";
import { editProfile } from "@/lib/discovery/service";
import { buildView } from "@/lib/discovery/view";

/** GET /api/w/[id]/discovery — the owner's discovery state. */
export function GET(request: Request, ctx: RouteContext<"/api/w/[id]/discovery">) {
  return ownerRoute(request, ctx.params, async (business, cid) => jsonOk({ view: await buildView(business) }, cid), { mutation: false });
}

/** PATCH /api/w/[id]/discovery — owner corrections to the business summary. */
export function PATCH(request: Request, ctx: RouteContext<"/api/w/[id]/discovery">) {
  return ownerRoute(request, ctx.params, async (business, cid) => {
    const body = await readBody(request, z.object({ fields: FieldEditsSchema }).strict(), cid);
    if ("response" in body) return body.response;
    await editProfile(business, body.data.fields);
    return jsonOk({ view: await buildView(business) }, cid);
  }, { mutation: true });
}
