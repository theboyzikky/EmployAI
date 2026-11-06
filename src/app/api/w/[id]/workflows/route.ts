import { jsonOk } from "@/lib/http";
import { ownerRoute } from "@/lib/discovery/routes";
import { buildWorkspaceView } from "@/lib/workflows/view";

/** GET /api/w/[id]/workflows — workflows (newest first), the team, and the labelled demo data. */
export function GET(request: Request, ctx: RouteContext<"/api/w/[id]/workflows">) {
  return ownerRoute(request, ctx.params, async (business, cid) => jsonOk({ view: await buildWorkspaceView(business) }, cid),
    { mutation: false, errorView: buildWorkspaceView });
}
