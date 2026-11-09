import { z } from "zod";
import "@/lib/chain/live";   // M5: registers the NEAR testnet payment port (server-only)
import { jsonError, readBody } from "@/lib/http";
import { UUID, runResponse, runsRoute } from "@/lib/runs/routes";
import { decideApproval } from "@/lib/runs/runner";

type Ctx = { params: Promise<{ id: string; approvalId: string }> };
const Body = z.object({ decision: z.enum(["approve", "reject"]) }).strict();

/**
 * POST /api/w/[id]/approvals/[approvalId] — the owner approves or rejects a payment that waits for them.
 * Re-checked (kill switch, fingerprint, hard rules; testnet: batch and the full payment binding) before
 * it takes effect. Executes no step and signs nothing: a testnet payment is signed later, by advance,
 * after further checks.
 */
export function POST(request: Request, ctx: Ctx) {
  return runsRoute(request, ctx.params, async (business, cid) => {
    const { approvalId } = await ctx.params;
    if (!UUID.test(approvalId)) return jsonError(404, "NOT_FOUND", "That approval doesn't exist.", cid);
    const body = await readBody(request, Body, cid);
    if ("response" in body) return body.response;
    const { runId } = await decideApproval(business.id, approvalId, body.data.decision);
    return runResponse(business, runId, cid, { more: true });
  }, { mutation: true });
}
