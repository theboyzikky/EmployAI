import { z } from "zod";
import { jsonError, jsonOk, readBody } from "@/lib/http";
import { callerKey, limitResponse, limits } from "@/lib/hosted/rate-limit";
import "@/lib/integrations/providers";   // registers the real connectors
import "@/lib/automation/handlers";      // background handlers + the content guard/observer
import { wake } from "@/lib/automation/dispatch";
import { addProduct, approveAndSchedule, cancelScheduled, draftCaption, editCaption, planContent, removeProduct } from "@/lib/content/service";
import { integrationRoute } from "@/lib/integrations/routes";
import { buildPlatformView } from "@/lib/platform/view";

type Ctx = { params: Promise<{ id: string }> };
const ID = z.string().regex(/^[0-9a-f-]{36}$/i);
const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("add_product"), name: z.string().max(80), description: z.string().max(500), price_text: z.string().max(40).nullable().optional(), offer_text: z.string().max(120).nullable().optional(), image_url: z.string().max(2048).nullable().optional(), media_id: z.string().max(40).nullable().optional() }).strict(),
  z.object({ action: z.literal("remove_product"), product_id: ID }).strict(),
  z.object({ action: z.literal("plan"), days: z.number().int().min(1).max(14).optional() }).strict(),
  z.object({ action: z.literal("draft"), item_id: ID }).strict(),
  z.object({ action: z.literal("edit"), item_id: ID, caption: z.string().max(2200), hashtags: z.array(z.string().max(40)).max(12) }).strict(),
  z.object({ action: z.literal("approve"), item_id: ID, scheduled_for: z.string().max(40), approval_key: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/) }).strict(),
  z.object({ action: z.literal("cancel"), item_id: ID }).strict(),
]);

/** POST /api/w/[id]/content — products, AI plan/drafts (rate-limited, spend-capped), owner edits, approve & schedule, cancel. */
export function POST(request: Request, ctx: Ctx) {
  return integrationRoute(request, ctx.params, async (business, cid) => {
    const body = await readBody(request, Body, cid);
    if ("response" in body) return body.response;
    const d = body.data;
    const aiLimited = async () => { const lim = limits(); return limitResponse([{ limit: lim.aiPerWorkspace, subject: business.id }, { limit: lim.aiPerIp, subject: await callerKey() }], cid); };
    switch (d.action) {
      case "add_product": await addProduct(business.id, d); break;
      case "remove_product": await removeProduct(business.id, d.product_id); break;
      case "plan": { const l = await aiLimited(); if (l) return l; const r = await planContent(business, d.days ?? 7); if ("aiError" in r) return jsonError(502, "AI_UNAVAILABLE", r.aiError.message, cid, { view: await buildPlatformView(business) }); break; }
      case "draft": { const l = await aiLimited(); if (l) return l; const r = await draftCaption(business, d.item_id); if ("aiError" in r) return jsonError(502, "AI_UNAVAILABLE", r.aiError.message, cid, { view: await buildPlatformView(business) }); break; }
      case "edit": await editCaption(business, d.item_id, d.caption, d.hashtags); break;
      case "approve": { const item = await approveAndSchedule(business, d.item_id, d.scheduled_for, d.approval_key); await wake(business.id, { atIso: item.scheduled_for }); break; }
      case "cancel": await cancelScheduled(business.id, d.item_id); break;
    }
    return jsonOk({ view: await buildPlatformView(business) }, cid);
  }, { mutation: true });
}
