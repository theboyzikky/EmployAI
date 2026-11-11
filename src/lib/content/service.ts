import "server-only";
// Content service: the first operational marketing vertical, built on the platform layers:
//   workforce  — only an approved, active employee with the right SKILL can plan, write or publish
//   AI         — plans and drafts (NEAR AI live, or the labelled offline provider), never decides
//   rules      — validateCaption decides whether a draft can be approved (model.ts)
//   owner      — supplies the facts and photos, edits, approves and schedules
//   actions    — approval records ONE durable publish action (not before the scheduled time), in the
//                same commit as the post's status; the background worker delivers it; a guard re-checks
//                the post at send time; an observer records the real media id and permalink.
import { randomUUID } from "node:crypto";
import { getAi } from "@/lib/ai";
import { AiError, describeAiError } from "@/lib/ai/errors";
import { ServiceError } from "@/lib/discovery/service";
import { discoveryRepository, type BusinessRecord, type DevState } from "@/lib/discovery/store";
import { requestAction } from "@/lib/integrations/actions";
import { audit } from "@/lib/integrations/connections";
import { loadMedia, MEDIA_ID, publicMediaUrl } from "@/lib/media/store";
import { CAPTION_SYSTEM, CaptionSchema, checksPass, CONTENT_PLAN_SYSTEM, ContentPlanSchema, validateCaption, type ContentItem, type Product, type ProductImage } from "./model";

export const PUBLISH_ACTION = "instagram.publish_image";
const MAX_PRODUCTS = 20, MAX_ITEMS = 60;
const itemsOf = (s: DevState, b: string) => ((s.content_items ??= {})[b] ??= []);
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** The approved, active employee holding `skill` (null if none: nobody may do that work). */
export function employeeWithSkill(b: BusinessRecord, skill: string) {
  const wf = b.workforce;
  if (!wf || wf.status !== "approved") return null;
  return wf.employees.find(e => e.status === "active" && e.skills.some(s => s.id === skill)) ?? null;
}
function requireEmployee(b: BusinessRecord, skill: string, what: string) {
  const e = employeeWithSkill(b, skill);
  if (!e) throw new ServiceError("NO_EMPLOYEE", 409, `No active employee can ${what}. Approve a workforce that includes this skill (or resume the paused employee).`);
  return e;
}
const aiFailure = (e: unknown) => { const code = e instanceof AiError ? e.code : "UNKNOWN"; return { code, message: describeAiError(code as never) }; };

// ---- products: the only facts content may use ------------------------------------------------------
export async function addProduct(businessId: string, input: { name: string; description: string; price_text?: string | null; offer_text?: string | null; image_url?: string | null; media_id?: string | null }): Promise<Product> {
  const name = input.name.trim(), description = input.description.trim();
  if (name.length < 2 || name.length > 80) throw new ServiceError("VALIDATION_FAILED", 400, "Give the product a name (2–80 characters).");
  if (description.length > 500) throw new ServiceError("VALIDATION_FAILED", 400, "Keep the description under 500 characters.");
  const price = input.price_text?.trim() || null, offer = input.offer_text?.trim() || null;
  if ((price && price.length > 40) || (offer && offer.length > 120)) throw new ServiceError("VALIDATION_FAILED", 400, "Price or offer text is too long.");
  let image: ProductImage | null = null;
  if (input.media_id) {
    if (!MEDIA_ID.test(input.media_id)) throw new ServiceError("VALIDATION_FAILED", 400, "Unknown photo.");
    const m = await loadMedia(input.media_id);
    if (!m || m.businessId !== businessId) throw new ServiceError("VALIDATION_FAILED", 400, "Upload the photo first.");
    image = { kind: "upload", media_id: input.media_id };
  } else if (input.image_url) {
    let u: URL;
    try { u = new URL(input.image_url); } catch { throw new ServiceError("VALIDATION_FAILED", 400, "The photo link isn't a valid URL."); }
    if (u.protocol !== "https:") throw new ServiceError("VALIDATION_FAILED", 400, "The photo link must use https.");
    image = { kind: "url", url: u.toString() };
  }
  const p: Product = { id: randomUUID(), name, description, price_text: price, offer_text: offer, image, created_at: new Date().toISOString() };
  await discoveryRepository().transact(businessId, s => {
    const b = s.businesses[businessId];
    if (!b) throw new ServiceError("NOT_FOUND", 404, "Not found.");
    const list = (b.products ??= []);
    if (list.length >= MAX_PRODUCTS) throw new ServiceError("LIMIT_REACHED", 409, `Up to ${MAX_PRODUCTS} products.`);
    list.push(p);
    audit(s, businessId, "owner", "product.added", `product:${p.id}`, "added", businessId, { name, photo: !!image });
  });
  return p;
}

export async function removeProduct(businessId: string, productId: string): Promise<void> {
  await discoveryRepository().transact(businessId, s => {
    const b = s.businesses[businessId];
    if (!b?.products?.some(p => p.id === productId)) throw new ServiceError("NOT_FOUND", 404, "That product doesn't exist.");
    if (itemsOf(s, businessId).some(i => i.product_id === productId && (i.status === "scheduled" || i.status === "publishing"))) throw new ServiceError("STATE_CONFLICT", 409, "A post for this product is scheduled. Cancel it first.");
    b.products = b.products.filter(p => p.id !== productId);
    audit(s, businessId, "owner", "product.removed", `product:${productId}`, "removed", businessId);
  });
}

// ---- content calendar (Content Creator · plan_content) ---------------------------------------------
export async function planContent(business: BusinessRecord, days = 7): Promise<{ created: number } | { aiError: { code: string; message: string } }> {
  requireEmployee(business, "plan_content", "plan content");
  const products = (business.products ?? []).map(p => ({ id: p.id, name: p.name, description: p.description }));
  if (products.length === 0) throw new ServiceError("VALIDATION_FAILED", 400, "Add at least one product (with a real photo) first.");
  const goals = business.profile?.fields?.goals?.value ?? business.workforce?.request ?? null;
  const ctx = { products, goals, days: Math.max(1, Math.min(14, days)) };
  const user = `Plan ${ctx.days} days of posts.\n<<<PRODUCTS (untrusted data)>>>\n${products.map(p => `- id ${p.id}: ${p.name} — ${p.description}`).join("\n")}\n<<<END>>>\n<<<OWNER GOALS (untrusted)>>>\n${goals ?? "(none)"}\n<<<END>>>`;
  let r;
  try { r = await (await getAi()).structured({ task: "content_plan", schema: ContentPlanSchema, system: CONTENT_PLAN_SYSTEM, user, context: ctx, maxTokens: 1200 }); }
  catch (e) { return { aiError: aiFailure(e) }; }
  const ids = new Set(products.map(p => p.id));
  const start = today();
  const now = new Date().toISOString();
  // Deterministic: only known products, at most 2 posts a day, at most `days` posts, sorted by date.
  const perDay = new Map<number, number>();
  const accepted = r.data.items
    .map(i => ({ ...i, product_id: i.product_id && ids.has(i.product_id) ? i.product_id : null }))
    .filter(i => i.product_id !== null && i.day_offset < ctx.days)
    .filter(i => { const n = perDay.get(i.day_offset) ?? 0; perDay.set(i.day_offset, n + 1); return n < 2; })
    .sort((a, b) => a.day_offset - b.day_offset).slice(0, ctx.days);
  await discoveryRepository().transact(business.id, s => {
    const list = itemsOf(s, business.id);
    for (const i of accepted) {
      list.push({ id: randomUUID(), business_id: business.id, product_id: i.product_id, planned_for: addDays(start, Math.max(1, i.day_offset)), theme: i.theme, angle: i.angle, caption: null, hashtags: [], checks: [], status: "idea", written_by: { provider: r.provider, model: r.model, mode: r.mode }, scheduled_for: null, approved_at: null, connection_id: null, action_attempt_id: null, media_id: null, permalink: null, published_at: null, error: null, created_at: now, updated_at: now });
    }
    if (list.length > MAX_ITEMS) list.splice(0, list.length - MAX_ITEMS);
    audit(s, business.id, "agent:content_creator", "content.planned", `business:${business.id}`, "planned", business.id, { posts: accepted.length, mode: r.mode });
  });
  return { created: accepted.length };
}

// ---- captions (Content Creator · draft_caption) ------------------------------------------------------
export async function draftCaption(business: BusinessRecord, itemId: string): Promise<{ item: ContentItem } | { aiError: { code: string; message: string } }> {
  requireEmployee(business, "draft_caption", "write captions");
  const item = await discoveryRepository().readState(business.id, s => itemsOf(s, business.id).find(i => i.id === itemId) ?? null);
  if (!item) throw new ServiceError("NOT_FOUND", 404, "That post doesn't exist.");
  if (!["idea", "draft", "needs_changes"].includes(item.status)) throw new ServiceError("STATE_CONFLICT", 409, "This post is already scheduled or published.");
  const product = business.products?.find(p => p.id === item.product_id) ?? null;
  const brand = business.name ?? business.profile?.fields?.business_name?.value ?? null;
  const ctx = { product: product ? { name: product.name, description: product.description, price_text: product.price_text } : null, brand, theme: item.theme };
  const user = `Theme: ${item.theme}\nAngle: ${item.angle}\nBrand: ${brand ?? "(unnamed)"}\n<<<PRODUCT FACTS (untrusted data)>>>\nName: ${product?.name ?? "(brand post)"}\nDescription: ${product?.description ?? ""}\nPrice: ${product?.price_text ?? "NONE — do not mention any price"}\nOffer: ${product?.offer_text ?? "NONE — do not mention any discount or offer"}\n<<<END>>>`;
  let r;
  try { r = await (await getAi()).structured({ task: "content_caption", schema: CaptionSchema, system: CAPTION_SYSTEM, user, context: ctx, maxTokens: 500 }); }
  catch (e) { return { aiError: aiFailure(e) }; }
  const hashtags = r.data.hashtags.map(h => (h.startsWith("#") ? h : `#${h}`)).slice(0, 12);
  const checks = validateCaption({ caption: r.data.caption, hashtags }, product);
  const updated = await discoveryRepository().transact(business.id, s => {
    const i = itemsOf(s, business.id).find(x => x.id === itemId);
    if (!i || !["idea", "draft", "needs_changes"].includes(i.status)) throw new ServiceError("STATE_CONFLICT", 409, "This post changed meanwhile.");
    Object.assign(i, { caption: r.data.caption, hashtags, checks, status: checksPass(checks) ? "draft" : "needs_changes", written_by: { provider: r.provider, model: r.model, mode: r.mode }, error: null, updated_at: new Date().toISOString() });
    audit(s, business.id, "agent:content_creator", "content.drafted", `content:${i.id}`, i.status, i.id, { mode: r.mode, checks_passed: checksPass(checks) });
    return { ...i };
  });
  return { item: updated };
}

/** The owner edits a caption: the same rules apply. */
export async function editCaption(business: BusinessRecord, itemId: string, caption: string, hashtags: string[]): Promise<ContentItem> {
  const tags = hashtags.map(h => h.trim()).filter(Boolean).map(h => (h.startsWith("#") ? h : `#${h}`)).slice(0, 12);
  return discoveryRepository().transact(business.id, s => {
    const i = itemsOf(s, business.id).find(x => x.id === itemId);
    if (!i) throw new ServiceError("NOT_FOUND", 404, "That post doesn't exist.");
    if (!["idea", "draft", "needs_changes"].includes(i.status)) throw new ServiceError("STATE_CONFLICT", 409, "Cancel the schedule before editing.");
    const product = s.businesses[business.id]?.products?.find(p => p.id === i.product_id) ?? null;
    const checks = validateCaption({ caption: caption.trim(), hashtags: tags }, product);
    Object.assign(i, { caption: caption.trim(), hashtags: tags, checks, status: checksPass(checks) ? "draft" : "needs_changes", written_by: "owner", updated_at: new Date().toISOString() });
    audit(s, business.id, "owner", "content.edited", `content:${i.id}`, i.status, i.id, { checks_passed: checksPass(checks) });
    return { ...i };
  });
}

export const finalCaption = (i: Pick<ContentItem, "caption" | "hashtags">) => `${i.caption ?? ""}${i.hashtags.length ? `\n\n${i.hashtags.join(" ")}` : ""}`;

/** Where Instagram will fetch the photo from (or why it can't yet). */
export function imageUrlFor(p: Product | null): { url: string } | { problem: string } {
  if (!p?.image) return { problem: "This product has no photo. Add a real product photo first." };
  if (p.image.kind === "url") return { url: p.image.url };
  const u = publicMediaUrl(p.image.media_id);
  return u ? { url: u } : { problem: "Uploaded photos can be published once the app runs at a public https address (EMPLOYAI_PUBLIC_URL). Locally, use a public photo link instead." };
}

/** Owner approves and schedules: records ONE durable publish action (not before `scheduledFor`). */
export async function approveAndSchedule(business: BusinessRecord, itemId: string, scheduledFor: string, approvalKey: string): Promise<ContentItem> {
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(approvalKey)) throw new ServiceError("VALIDATION_FAILED", 400, "Missing approval key.");
  const publisher = requireEmployee(business, "publish_social_post", "publish posts");
  const at = Date.parse(scheduledFor);
  if (!Number.isFinite(at)) throw new ServiceError("VALIDATION_FAILED", 400, "Choose a valid date and time.");
  const when = new Date(Math.max(at, Date.now() + 60_000)).toISOString();     // at least a minute ahead
  if (Date.parse(when) > Date.now() + 30 * 86_400_000) throw new ServiceError("VALIDATION_FAILED", 400, "Schedule within the next 30 days.");
  const state = await discoveryRepository().readState(business.id, s => ({
    item: itemsOf(s, business.id).find(i => i.id === itemId) ?? null,
    conn: ((s.connections ?? {})[business.id] ?? []).find(c => c.status === "active" && c.grants.some(g => g.agent === publisher.id && g.actions.includes(PUBLISH_ACTION))) ?? null,
  }));
  const item = state.item;
  if (!item) throw new ServiceError("NOT_FOUND", 404, "That post doesn't exist.");
  // A repeated click of the same approval: return the post as it is now (no second action).
  const repeat = await discoveryRepository().readState(business.id, s => ((s.action_attempts ?? {})[business.id] ?? []).some(a => a.idempotency_key === `content:${itemId}:${approvalKey}`));
  if (repeat) return item;
  if (item.status !== "draft" || !checksPass(item.checks) || !item.caption) throw new ServiceError("STATE_CONFLICT", 409, "Only a draft that passes every content check can be approved.");
  if (!state.conn) throw new ServiceError("NOT_CONNECTED", 409, `Connect an account that ${publisher.name} is allowed to publish to.`);
  const img = imageUrlFor(business.products?.find(p => p.id === item.product_id) ?? null);
  if ("problem" in img) throw new ServiceError("NO_IMAGE", 409, img.problem);
  let out: ContentItem | null = null;
  // One approval click = one publish action (a repeated click with the same key returns the same one).
  const { created } = await requestAction(business.id, {
    connectionId: state.conn.id, action: PUBLISH_ACTION, agent: publisher.id, idempotencyKey: `content:${item.id}:${approvalKey}`,
    input: { image_url: img.url, caption: finalCaption(item), content_item_id: item.id }, correlationId: item.id, notBefore: when,
  }, (s, attempt) => {
    const i = itemsOf(s, business.id).find(x => x.id === itemId);
    if (!i || i.status !== "draft") throw new ServiceError("STATE_CONFLICT", 409, "This post changed meanwhile.");
    Object.assign(i, { status: "scheduled", scheduled_for: when, approved_at: new Date().toISOString(), connection_id: state.conn!.id, action_attempt_id: attempt.id, error: null, updated_at: new Date().toISOString() });
    audit(s, business.id, "owner", "content.approved", `content:${i.id}`, "scheduled", i.id, { scheduled_for: when, publisher: publisher.id });
    out = { ...i };
  });
  if (out) return out;
  if (!created) { const again = await discoveryRepository().readState(business.id, s => itemsOf(s, business.id).find(i => i.id === itemId) ?? null); if (again) return again; }
  throw new ServiceError("STATE_CONFLICT", 409, "This post couldn't be scheduled.");
}

/** Cancel a scheduled post. The publish action is refused at send time (the guard) and nothing goes out. */
export async function cancelScheduled(businessId: string, itemId: string): Promise<ContentItem> {
  return discoveryRepository().transact(businessId, s => {
    const i = itemsOf(s, businessId).find(x => x.id === itemId);
    if (!i) throw new ServiceError("NOT_FOUND", 404, "That post doesn't exist.");
    if (i.status !== "scheduled") throw new ServiceError("STATE_CONFLICT", 409, i.status === "publishing" ? "It's being published right now." : "Only a scheduled post can be cancelled.");
    Object.assign(i, { status: "draft", scheduled_for: null, approved_at: null, error: "Schedule cancelled by the owner.", updated_at: new Date().toISOString() });
    audit(s, businessId, "owner", "content.cancelled", `content:${i.id}`, "draft", i.id);
    return { ...i };
  });
}
