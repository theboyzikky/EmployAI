import { z } from "zod";
import { jsonOk, readBody } from "@/lib/http";
import { runsRoute } from "@/lib/runs/routes";
import { armTestnetBatch, disarmTestnetBatch } from "@/lib/runs/runner";
import { buildRunsView } from "@/lib/runs/view";

type Ctx = { params: Promise<{ id: string }> };
const Body = z.union([
  z.object({
    batch_ref: z.string().regex(/^[A-Za-z0-9_-]{1,24}$/, "Use the batch sheet's ID, e.g. B3."),
    max_payments: z.number().int().min(1).max(10),
    max_total_near: z.string().regex(/^(0|[1-9]\d*)(\.\d{1,24})?$/, "Give the NEAR amount as a decimal, e.g. 0.1."),
    expires_in_minutes: z.number().int().min(5).max(24 * 60),
  }).strict(),
  z.object({ disarm: z.literal(true) }).strict(),
]);

/**
 * POST /api/w/[id]/testnet/arm — arm (or disarm) the owner's approved testnet batch (plan §8.4). A batch
 * is an EXTRA limit on how many payments and how much NEAR testnet runs may move before it expires: it
 * never approves a payment (each still needs its own approval) and makes no chain call.
 */
export function POST(request: Request, ctx: Ctx) {
  return runsRoute(request, ctx.params, async (business, cid) => {
    const body = await readBody(request, Body, cid);
    if ("response" in body) return body.response;
    if ("disarm" in body.data) await disarmTestnetBatch(business.id);
    else await armTestnetBatch(business.id, { batchRef: body.data.batch_ref, maxPayments: body.data.max_payments, maxTotalNear: body.data.max_total_near, expiresInMinutes: body.data.expires_in_minutes });
    return jsonOk({ view: await buildRunsView(business) }, cid);
  }, { mutation: true });
}
