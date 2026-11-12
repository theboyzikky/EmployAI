import { z } from "zod";
import { jsonError, jsonOk, readBody } from "@/lib/http";
import "@/lib/integrations/providers";   // registers the real connectors
import { CONNECTION_ID, setConnectionStatus } from "@/lib/integrations/connections";
import { integrationRoute } from "@/lib/integrations/routes";

type Ctx = { params: Promise<{ id: string; connectionId: string }> };
const Body = z.object({ status: z.enum(["active", "disabled"]) }).strict();

/** PATCH /api/w/[id]/connections/[connectionId] — enable or disable a connection (owner only). */
export function PATCH(request: Request, ctx: Ctx) {
  return integrationRoute(request, ctx.params, async (business, cid) => {
    const { connectionId } = await ctx.params;
    if (!CONNECTION_ID.test(connectionId)) return jsonError(404, "NOT_FOUND", "That connection doesn't exist.", cid);
    const body = await readBody(request, Body, cid);
    if ("response" in body) return body.response;
    return jsonOk({ connection: await setConnectionStatus(business.id, connectionId, body.data.status) }, cid);
  }, { mutation: true });
}
