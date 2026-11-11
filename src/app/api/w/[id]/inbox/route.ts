import { z } from "zod";
import { jsonError, jsonOk, readBody } from "@/lib/http";
import "@/lib/integrations/providers";
import "@/lib/automation/handlers";
import { wake } from "@/lib/automation/dispatch";
import { ServiceError } from "@/lib/discovery/service";
import { integrationRoute } from "@/lib/integrations/routes";
import { MAX_KNOWLEDGE } from "@/lib/messaging/model";
import { approveReply, discardReply, ownerReply, setConversationStatus, setMessagingSettings } from "@/lib/messaging/service";
import { buildInboxView } from "@/lib/messaging/view";

type Ctx = { params: Promise<{ id: string }> };
const Id = z.string().regex(/^[0-9a-f-]{36}$/i);
const Key = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("approve"), conversation_id: Id, message_id: Id, text: z.string().max(2000).nullable().optional(), approval_key: Key }).strict(),
  z.object({ action: z.literal("discard"), conversation_id: Id, message_id: Id }).strict(),
  z.object({ action: z.literal("reply"), conversation_id: Id, text: z.string().min(1).max(2000), approval_key: Key }).strict(),
  z.object({ action: z.literal("status"), conversation_id: Id, status: z.enum(["open", "resolved"]) }).strict(),
  z.object({ action: z.literal("settings"), mode: z.enum(["approve", "auto"]).optional(), knowledge: z.string().max(MAX_KNOWLEDGE).optional() }).strict(),
]);

/** GET /api/w/[id]/inbox — conversations across channels, channel status, support settings. */
export function GET(request: Request, ctx: Ctx) {
  return integrationRoute(request, ctx.params, async (business, cid) => jsonOk({ view: await buildInboxView(business) }, cid), { mutation: false });
}

/** POST /api/w/[id]/inbox — the owner approves, edits, discards or writes replies; resolves; sets autonomy and knowledge. */
export function POST(request: Request, ctx: Ctx) {
  return integrationRoute(request, ctx.params, async (business, cid) => {
    const body = await readBody(request, Body, cid);
    if ("response" in body) return body.response;
    const d = body.data;
    try {
      switch (d.action) {
        case "approve": await approveReply(business.id, d.conversation_id, d.message_id, d.text ?? null, d.approval_key); await wake(business.id); break;
        case "discard": await discardReply(business.id, d.conversation_id, d.message_id); break;
        case "reply": await ownerReply(business.id, d.conversation_id, d.text, d.approval_key); await wake(business.id); break;
        case "status": await setConversationStatus(business.id, d.conversation_id, d.status); break;
        case "settings": await setMessagingSettings(business.id, { mode: d.mode, knowledge: d.knowledge }); break;
      }
    } catch (e) {
      if (e instanceof ServiceError) return jsonError(e.status, e.code, e.message, cid, { view: await buildInboxView(business) });
      throw e;
    }
    return jsonOk({ view: await buildInboxView(business) }, cid);
  }, { mutation: true });
}
