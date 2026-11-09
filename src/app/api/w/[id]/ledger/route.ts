import { jsonOk } from "@/lib/http";
import { buildLedgerView } from "@/lib/runs/ledger-view";
import { runsRoute } from "@/lib/runs/routes";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/w/[id]/ledger — the private owner ledger (M5 plan §16). Owner only; read-only; no RPC. */
export function GET(request: Request, ctx: Ctx) {
  return runsRoute(request, ctx.params, async (business, cid) => jsonOk({ ledger: await buildLedgerView(business.id) }, cid), { mutation: false });
}
