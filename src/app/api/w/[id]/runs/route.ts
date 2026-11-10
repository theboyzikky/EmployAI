import { z } from "zod";
import "@/lib/chain/live";   // M5: registers the NEAR testnet payment port (server-only)
import { jsonError, jsonOk, readBody } from "@/lib/http";
import { IDEMPOTENCY_KEY, UUID, runResponse, runsRoute } from "@/lib/runs/routes";
import { startRun } from "@/lib/runs/runner";
import "@/lib/automation/run-handlers";   // background continuation (advance_run)
import { wake } from "@/lib/automation/dispatch";

import { RUN_MODES, SCENARIOS } from "@/lib/runs/types";
import { buildRunsView } from "@/lib/runs/view";
import { callerKey, limitResponse, limits } from "@/lib/hosted/rate-limit";

type Ctx = { params: Promise<{ id: string }> };
const StartBody = z.object({
  workflow_id: z.string().regex(UUID, "Unknown workflow."), scenario: z.enum(SCENARIOS),
  // M5: "testnet" signs a real NEAR testnet transaction and needs this explicit confirmation.
  mode: z.enum(RUN_MODES).optional(), confirm_real_transactions: z.boolean().optional(),
}).strict();

/** GET /api/w/[id]/runs — run history and whether a test run can start. Read-only. */
export function GET(request: Request, ctx: Ctx) {
  return runsRoute(request, ctx.params, async (business, cid) => jsonOk({ view: await buildRunsView(business) }, cid), { mutation: false });
}

/**
 * POST /api/w/[id]/runs — start a test run of the current approved workflow. Creates and persists the
 * run; executes NO step (the page then calls …/advance). A repeated Idempotency-Key returns the same run.
 */
export function POST(request: Request, ctx: Ctx) {
  return runsRoute(request, ctx.params, async (business, cid) => {
    const key = request.headers.get("idempotency-key") ?? "";
    if (!IDEMPOTENCY_KEY.test(key)) return jsonError(400, "VALIDATION_FAILED", "An Idempotency-Key header is required.", cid);
    const body = await readBody(request, StartBody, cid);
    if ("response" in body) return body.response;
    if (body.data.mode === "testnet") {
      // Real testnet runs: a shared daily allowance per workspace and (looser) per network.
      const lim = limits();
      const limited = await limitResponse([{ limit: lim.testnetPerWorkspace, subject: business.id }, { limit: lim.testnetPerIp, subject: await callerKey() }], cid);
      if (limited) return limited;
    }
    const { runId, created } = await startRun(business.id, { workflowId: body.data.workflow_id, scenario: body.data.scenario, idempotencyKey: key, mode: body.data.mode, confirmRealTransactions: body.data.confirm_real_transactions });
    if (created) await wake(business.id);   // the run continues even if the owner closes the page
    return runResponse(business, runId, cid, { created, more: true });
  }, { mutation: true });
}
