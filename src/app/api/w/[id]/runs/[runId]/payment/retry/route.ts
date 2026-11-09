import "@/lib/chain/live";   // M5: registers the NEAR testnet payment port (server-only)
import { jsonError, readBody } from "@/lib/http";
import { EmptyBody, UUID, runResponse, runsRoute } from "@/lib/runs/routes";
import { requestPaymentRetry } from "@/lib/runs/runner";

type Ctx = { params: Promise<{ id: string; runId: string }> };

/**
 * POST /api/w/[id]/runs/[runId]/payment/retry — the owner's manual retry of a payment PROVEN failed
 * (contract record Failed, funds refunded) or proven expired unexecuted. Reopens the run at its security
 * check: fresh chain checks, a fresh gate decision and a NEW owner approval are required. Signs nothing.
 */
export function POST(request: Request, ctx: Ctx) {
  return runsRoute(request, ctx.params, async (business, cid) => {
    const { runId } = await ctx.params;
    if (!UUID.test(runId)) return jsonError(404, "NOT_FOUND", "That run doesn't exist.", cid);
    const body = await readBody(request, EmptyBody, cid);
    if ("response" in body) return body.response;
    await requestPaymentRetry(business.id, runId);
    return runResponse(business, runId, cid, { more: true });
  }, { mutation: true });
}
