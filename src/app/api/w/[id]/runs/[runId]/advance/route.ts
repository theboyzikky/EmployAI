import "@/lib/chain/live";   // M5: registers the NEAR testnet payment port (server-only)
import { jsonError, readBody } from "@/lib/http";
import { EmptyBody, UUID, runResponse, runsRoute } from "@/lib/runs/routes";
import { advanceRun } from "@/lib/runs/runner";

type Ctx = { params: Promise<{ id: string; runId: string }> };

/**
 * POST /api/w/[id]/runs/[runId]/advance — the ONLY operation that executes steps: one bounded batch under
 * the shared business lock. A run that isn't running is a safe no-op (advanced: 0, more: false).
 */
export function POST(request: Request, ctx: Ctx) {
  return runsRoute(request, ctx.params, async (business, cid) => {
    const { runId } = await ctx.params;
    if (!UUID.test(runId)) return jsonError(404, "NOT_FOUND", "That run doesn't exist.", cid);
    const body = await readBody(request, EmptyBody, cid);
    if ("response" in body) return body.response;
    const r = await advanceRun(business.id, runId);
    return runResponse(business, runId, cid, { advanced: r.advanced, more: r.more, settling: r.settling });
  }, { mutation: true });
}
