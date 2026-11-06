import { z } from "zod";
import { jsonOk, readBody } from "@/lib/http";
import { ownerRoute } from "@/lib/discovery/routes";
import { confirmSummary } from "@/lib/discovery/service";
import { buildView } from "@/lib/discovery/view";
import { FieldEditsSchema } from "@/lib/discovery/schemas";

/** POST /api/w/[id]/discovery/confirm — the owner confirms (optionally with final edits) the summary. */
export function POST(request: Request, ctx: RouteContext<"/api/w/[id]/discovery/confirm">) {
  return ownerRoute(request, ctx.params, async (business, cid) => {
    const body = await readBody(request, z.object({ fields: FieldEditsSchema.optional() }).strict(), cid);
    if ("response" in body) return body.response;
    await confirmSummary(business, body.data.fields);
    return jsonOk({ view: await buildView(business) }, cid);
  }, { mutation: true });
}
