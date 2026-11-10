import "server-only";
// Owner routes for integrations: the same wrapper as every /api/w/[id] route (owner only → 404 for anyone
// else, JSON + same-origin on mutations), plus a mapping of integration and credential errors.
import { jsonError } from "@/lib/http";
import { ownerRoute } from "@/lib/discovery/routes";
import type { BusinessRecord } from "@/lib/discovery/store";
import { CredentialError } from "./credentials";
import { IntegrationError } from "./connections";

type Handler = (business: BusinessRecord, correlationId: string) => Promise<Response>;

export function integrationRoute(request: Request, params: Promise<{ id: string }>, handler: Handler, opts: { mutation: boolean }) {
  return ownerRoute(request, params, async (business, cid) => {
    try {
      return await handler(business, cid);
    } catch (e) {
      if (e instanceof IntegrationError) return jsonError(e.status, e.code, e.message, cid);
      if (e instanceof CredentialError) return jsonError(503, e.code, "Integrations aren't available on this server right now (credential encryption isn't configured).", cid);
      throw e;
    }
  }, opts);
}
