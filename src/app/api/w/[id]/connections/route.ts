import { z } from "zod";
import { jsonOk, readBody } from "@/lib/http";
import "@/lib/integrations/providers";   // registers the real connectors
import { createConnection, listConnections } from "@/lib/integrations/connections";
import { integrationRoute } from "@/lib/integrations/routes";

type Ctx = { params: Promise<{ id: string }> };
const Body = z.object({
  connector: z.string().max(32),
  label: z.string().max(60),
  setup: z.record(z.string(), z.unknown()).optional(),
  grants: z.array(z.object({ agent: z.string().max(20), actions: z.array(z.string().max(96)).max(16) }).strict()).max(7).optional(),
  routes: z.array(z.object({ event_type: z.string().max(64), agent: z.string().max(20) }).strict()).max(20).optional(),
}).strict();

/** GET /api/w/[id]/connections — this business's integration connections (never their secrets). */
export function GET(request: Request, ctx: Ctx) {
  return integrationRoute(request, ctx.params, async (business, cid) => jsonOk({ connections: await listConnections(business.id) }, cid), { mutation: false });
}

/**
 * POST /api/w/[id]/connections — connect an integration. Generated secrets (e.g. a webhook signing secret)
 * are returned ONCE in `reveal_once`; afterwards only their encrypted form exists.
 */
export function POST(request: Request, ctx: Ctx) {
  return integrationRoute(request, ctx.params, async (business, cid) => {
    const body = await readBody(request, Body, cid);
    if ("response" in body) return body.response;
    const { view, revealOnce } = await createConnection(business.id, { connector: body.data.connector, label: body.data.label, setup: body.data.setup ?? {}, grants: body.data.grants ?? [], routes: body.data.routes ?? [] });
    return jsonOk({ connection: view, reveal_once: revealOnce }, cid, 201);
  }, { mutation: true });
}
