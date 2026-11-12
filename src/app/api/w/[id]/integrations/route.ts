import { z } from "zod";
import { jsonOk, readBody } from "@/lib/http";
import "@/lib/integrations/providers";   // registers the real connectors (and the OAuth refresher)
import { PERMISSIONS, providerByKey, type Permission } from "@/lib/integrations/catalogue";
import { checkConnection, CONNECTION_ID, createConnection, disconnectConnection, IntegrationError, setEmployeePermissions } from "@/lib/integrations/connections";
import { buildHubView } from "@/lib/integrations/hub";
import { startOAuth } from "@/lib/integrations/oauth";
import { startTelegramLink } from "@/lib/integrations/telegram-link";
import { integrationRoute } from "@/lib/integrations/routes";

type Ctx = { params: Promise<{ id: string }> };
const ConnId = z.string().regex(CONNECTION_ID);
const Provider = z.string().regex(/^[a-z][a-z0-9_]{1,31}$/);
const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("connect_oauth"), provider: Provider, connection_id: ConnId.nullable().optional(), return_to: z.string().max(200).optional() }).strict(),
  z.object({ action: z.literal("connect_token"), provider: Provider, token: z.string().min(10).max(1024), connection_id: ConnId.nullable().optional() }).strict(),
  z.object({ action: z.literal("connect_whatsapp"), code: z.string().min(10).max(2048), waba_id: z.string().regex(/^d{5,25}$/), phone_number_id: z.string().regex(/^d{5,25}$/), connection_id: ConnId.nullable().optional() }).strict(),
  z.object({ action: z.literal("connect_webhook"), label: z.string().min(1).max(60) }).strict(),
  z.object({ action: z.literal("disconnect"), connection_id: ConnId }).strict(),
  z.object({ action: z.literal("check"), connection_id: ConnId }).strict(),
  z.object({ action: z.literal("grant"), connection_id: ConnId, employee_id: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/), permission: z.enum(Object.keys(PERMISSIONS) as [Permission, ...Permission[]]).optional(), permissions: z.array(z.enum(Object.keys(PERMISSIONS) as [Permission, ...Permission[]])).min(1).max(7).optional() }).strict(),
  z.object({ action: z.literal("permissions"), connection_id: ConnId, employee_id: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/), permissions: z.array(z.enum(Object.keys(PERMISSIONS) as [Permission, ...Permission[]])).max(7) }).strict(),
]);

/** GET /api/w/[id]/integrations — every provider with its real status, permissions and workforce readiness. */
export function GET(request: Request, ctx: Ctx) {
  return integrationRoute(request, ctx.params, async (business, cid) => jsonOk({ view: await buildHubView(business) }, cid), { mutation: false });
}

/**
 * POST /api/w/[id]/integrations — connect (OAuth start, or a token the owner generated with the provider),
 * reconnect, disconnect, check, and set one employee's permissions on one connection. Owner only.
 * A token is sent once, verified with the provider, stored encrypted, and never returned or logged.
 */
export function POST(request: Request, ctx: Ctx) {
  return integrationRoute(request, ctx.params, async (business, cid) => {
    const body = await readBody(request, Body, cid);
    if ("response" in body) return body.response;
    const d = body.data;
    let extra: Record<string, unknown> = {};
    switch (d.action) {
      case "connect_oauth": {
        const origin = new URL(request.url).origin;
        const returnTo = d.return_to ?? `/w/${business.id}/integrations`;
        // Telegram has no OAuth: its official business authorization starts with a Telegram deep link.
        const redirect = d.provider === "telegram" ? await startTelegramLink(business.id, returnTo) : await startOAuth(business.id, d.provider, { origin, returnTo, replaceId: d.connection_id ?? null });
        return jsonOk({ redirect }, cid);
      }
      case "connect_token": {
        const p = providerByKey(d.provider);
        if (!p || p.support !== "implemented" || !p.auth.includes("token") || !p.connector) throw new IntegrationError("NOT_SUPPORTED", 400, "This provider can't be connected with a token.");
        const setup = p.key === "telegram" ? { bot_token: d.token } : { access_token: d.token };
        await createConnection(business.id, { connector: p.connector, label: p.name, setup, replaceId: d.connection_id ?? null });
        break;
      }
      case "connect_whatsapp": {
        // From Meta's Embedded Signup window: verified server-side (token grants, number ownership) before storing.
        await createConnection(business.id, { connector: "whatsapp", label: "WhatsApp Business", setup: { signup: { code: d.code, waba_id: d.waba_id, phone_number_id: d.phone_number_id } }, replaceId: d.connection_id ?? null });
        break;
      }
      case "connect_webhook": {
        const r = await createConnection(business.id, { connector: "webhook", label: d.label, setup: {} });
        extra = { reveal_once: r.revealOnce, webhook_path: r.view.webhookPath };
        break;
      }
      case "disconnect": await disconnectConnection(business.id, d.connection_id); break;
      case "check": await checkConnection(business.id, d.connection_id); break;
      case "permissions": await setEmployeePermissions(business.id, d.connection_id, d.employee_id, d.permissions); break;
      case "grant": await setEmployeePermissions(business.id, d.connection_id, d.employee_id, { add: d.permissions ?? (d.permission ? [d.permission] : []) }); break;
    }
    return jsonOk({ view: await buildHubView(business), ...extra }, cid);
  }, { mutation: true });
}
