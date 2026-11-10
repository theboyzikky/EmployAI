import { z } from "zod";
import { jsonOk, readBody } from "@/lib/http";
import { buildLedgerView } from "@/lib/runs/ledger-view";
import { setLedgerPublic } from "@/lib/runs/public-ledger";
import { runsRoute } from "@/lib/runs/routes";

type Ctx = { params: Promise<{ id: string }> };
const Body = z.object({ public: z.boolean() }).strict();

/**
 * POST /api/w/[id]/ledger/publish — the owner publishes or unpublishes the public ledger (private by
 * default). Publishing shows only verified on-chain payouts at an unguessable link.
 */
export function POST(request: Request, ctx: Ctx) {
  return runsRoute(request, ctx.params, async (business, cid) => {
    const body = await readBody(request, Body, cid);
    if ("response" in body) return body.response;
    await setLedgerPublic(business.id, body.data.public);
    return jsonOk({ ledger: await buildLedgerView(business.id) }, cid);
  }, { mutation: true });
}
