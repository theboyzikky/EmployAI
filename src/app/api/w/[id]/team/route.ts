import { jsonOk } from "@/lib/http";
import { ownerRoute } from "@/lib/discovery/routes";
import { buildView } from "@/lib/discovery/view";

/** GET /api/w/[id]/team — the proposed (or approved) team, as part of the discovery view. */
export function GET(request: Request, ctx: RouteContext<"/api/w/[id]/team">) {
  return ownerRoute(request, ctx.params, async (business, cid) => {
    const view = await buildView(business);
    return jsonOk({ team: view.team, view }, cid);
  }, { mutation: false });
}
