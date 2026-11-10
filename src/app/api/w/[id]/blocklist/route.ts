import { z } from "zod";
import { jsonOk, readBody } from "@/lib/http";
import { listBlocklist, reportAccount } from "@/lib/runs/blocklist-service";
import { runsRoute } from "@/lib/runs/routes";

type Ctx = { params: Promise<{ id: string }> };
const Report = z.object({
  account_id: z.string().min(2).max(64),
  reason: z.string().min(3).max(200),
  evidence: z.object({ type: z.enum(["tx", "url", "text"]), ref: z.string().min(1).max(1000) }).strict(),
}).strict();

/** GET /api/w/[id]/blocklist — the SHARED blocklist (every workspace sees the same list). Read-only. */
export function GET(request: Request, ctx: Ctx) {
  return runsRoute(request, ctx.params, async (business, cid) => jsonOk({ entries: await listBlocklist(business.id) }, cid), { mutation: false });
}

/**
 * POST /api/w/[id]/blocklist — report an account with evidence (M6, X2d). The server computes the
 * evidence SHA-256 and records the reporting workspace. A report only WARNs until it is confirmed.
 */
export function POST(request: Request, ctx: Ctx) {
  return runsRoute(request, ctx.params, async (business, cid) => {
    const body = await readBody(request, Report, cid);
    if ("response" in body) return body.response;
    const { entry, created } = await reportAccount(business.id, { accountId: body.data.account_id, reason: body.data.reason, evidence: body.data.evidence });
    return jsonOk({ entry, created, entries: await listBlocklist(business.id) }, cid, created ? 201 : 200);
  }, { mutation: true });
}
