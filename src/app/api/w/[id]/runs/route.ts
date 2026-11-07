import { z } from "zod";
import { jsonError, jsonOk, readBody } from "@/lib/http";
import { IDEMPOTENCY_KEY, UUID, runResponse, runsRoute } from "@/lib/runs/routes";
import { startRun } from "@/lib/runs/runner";
import { SCENARIOS } from "@/lib/runs/types";
import { buildRunsView } from "@/lib/runs/view";

type Ctx = { params: Promise<{ id: string }> };
const StartBody = z.object({ workflow_id: z.string().regex(UUID, "Unknown workflow."), scenario: z.enum(SCENARIOS) }).strict();

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
    const { runId, created } = await startRun(business.id, { workflowId: body.data.workflow_id, scenario: body.data.scenario, idempotencyKey: key });
    return runResponse(business, runId, cid, { created, more: true });
  }, { mutation: true });
}
