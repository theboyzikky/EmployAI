import { z } from "zod";
import { jsonOk, readBody } from "@/lib/http";
import { callerKey, limitResponse, limits } from "@/lib/hosted/rate-limit";
import "@/lib/integrations/providers";   // connectors (for integration status)
import { integrationRoute } from "@/lib/integrations/routes";
import { buildPlatformView } from "@/lib/platform/view";
import { approveWorkforce, MAX_REQUEST, planWorkforce, setEmployeeStatus } from "@/lib/workforce/service";
import { jsonError } from "@/lib/http";

type Ctx = { params: Promise<{ id: string }> };
const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("plan"), request: z.string().max(MAX_REQUEST) }).strict(),
  z.object({ action: z.literal("approve") }).strict(),
  z.object({ action: z.literal("employee"), employee_id: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/), status: z.enum(["active", "paused"]) }).strict(),
]);

/** GET /api/w/[id]/workforce — the workforce, integrations (real status), products and content. */
export function GET(request: Request, ctx: Ctx) {
  return integrationRoute(request, ctx.params, async (business, cid) => jsonOk({ view: await buildPlatformView(business) }, cid), { mutation: false });
}

/** POST /api/w/[id]/workforce — plan (AI; rate-limited and spend-capped), approve, or pause/resume an employee. */
export function POST(request: Request, ctx: Ctx) {
  return integrationRoute(request, ctx.params, async (business, cid) => {
    const body = await readBody(request, Body, cid);
    if ("response" in body) return body.response;
    const d = body.data;
    if (d.action === "plan") {
      const lim = limits();
      const limited = await limitResponse([{ limit: lim.aiPerWorkspace, subject: business.id }, { limit: lim.aiPerIp, subject: await callerKey() }], cid);
      if (limited) return limited;
      const r = await planWorkforce(business, d.request);
      if ("aiError" in r) return jsonError(502, "AI_UNAVAILABLE", r.aiError.message, cid, { view: await buildPlatformView(business) });
    } else if (d.action === "approve") await approveWorkforce(business.id);
    else await setEmployeeStatus(business.id, d.employee_id, d.status);
    return jsonOk({ view: await buildPlatformView(business) }, cid);
  }, { mutation: true });
}
