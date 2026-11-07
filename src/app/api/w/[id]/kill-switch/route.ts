import { z } from "zod";
import { jsonOk, readBody } from "@/lib/http";
import { runsRoute } from "@/lib/runs/routes";
import { setKillSwitch } from "@/lib/runs/runner";
import { buildRunsView } from "@/lib/runs/view";

type Ctx = { params: Promise<{ id: string }> };
const Body = z.object({ active: z.boolean() }).strict();

/**
 * POST /api/w/[id]/kill-switch — the in-app kill switch (the on-chain pause joins it in M5). The flag is
 * persisted at once, even while a batch runs; active runs are cancelled and pending approvals invalidated.
 */
export function POST(request: Request, ctx: Ctx) {
  return runsRoute(request, ctx.params, async (business, cid) => {
    const body = await readBody(request, Body, cid);
    if ("response" in body) return body.response;
    const r = await setKillSwitch(business.id, body.data.active);
    return jsonOk({ view: await buildRunsView(business), finalised: r.finalised }, cid);
  }, { mutation: true });
}
