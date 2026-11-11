import "server-only";
// Customer messaging service: one inbound message → its conversation → the support employee's decision
// (reply automatically, draft for the owner, or escalate) → a durable reply action on the SAME connection
// the message came from. Every step is recorded; nothing is sent without passing the checks and the
// owner's chosen autonomy; nothing is re-sent when an outcome is unknown (the action layer's rules).
import { randomUUID } from "node:crypto";
import { getAi } from "@/lib/ai";
import { AiError } from "@/lib/ai/errors";
import { ServiceError } from "@/lib/discovery/service";
import { discoveryRepository, type DevState } from "@/lib/discovery/store";
import { requestAction } from "@/lib/integrations/actions";
import { audit, IntegrationError } from "@/lib/integrations/connections";
import type { InboundEventRecord } from "@/lib/integrations/records";
import { connectorFor } from "@/lib/integrations/registry";
import { SKILLS } from "@/lib/workforce/registry";
import {
  checkReply, checksPass, DEFAULT_SETTINGS, MAX_CONVERSATIONS, MAX_KNOWLEDGE, MAX_MESSAGES, REPLY_SYSTEM, replyPrompt, ReplySchema, WINDOW_24H,
  type Channel, type Conversation, type ConvMessage, type MessagingSettings, type ReplyProposal,
} from "./model";

/** Every connector's reply action is named "<connector>.reply" with the same input shape. */
export const REPLY_ACTIONS: readonly string[] = ["telegram.reply", "telegram_business.reply", "instagram_dm.reply", "messenger.reply", "whatsapp.reply", "gmail.reply", "outlook.reply"];
export const replyActionFor = (connector: string) => { const name = `${connector}.reply`; return connectorFor(connector)?.actions[name] ? name : null; };
export const AI_REPLIES_PER_HOUR = () => Number(process.env.EMPLOYAI_LIMIT_AI_REPLIES_PER_HOUR) || 60;

const convsOf = (s: DevState, b: string) => ((s.conversations ??= {})[b] ??= []);
const now = () => new Date().toISOString();

/** The normalised payload every messaging connector puts on a "message.received" event. */
export type InboundMessage = { channel: Channel; thread: string; from: string | null; text: string; message_id: string; sent_at: string | null; context: Record<string, string> };
export function asInboundMessage(ev: InboundEventRecord): InboundMessage | null {
  const p = ev.payload as Partial<InboundMessage>;
  if (typeof p.thread !== "string" || typeof p.text !== "string" || typeof p.message_id !== "string" || typeof p.channel !== "string") return null;
  const context = Object.fromEntries(Object.entries((p.context ?? {}) as Record<string, unknown>).filter(([, v]) => typeof v === "string")) as Record<string, string>;
  return { channel: p.channel as Channel, thread: p.thread, from: typeof p.from === "string" ? p.from : null, text: p.text.slice(0, 4000), message_id: p.message_id, sent_at: typeof p.sent_at === "string" ? p.sent_at : null, context };
}

/** Inside a commit: file the message in its conversation (once per provider message id). */
export function ingestInbound(s: DevState, ev: InboundEventRecord, employeeId: string | null): { convId: string; msgId: string; isNew: boolean } | null {
  const m = asInboundMessage(ev);
  if (!m) return null;
  const list = convsOf(s, ev.business_id);
  let c = list.find(x => x.connection_id === ev.connection_id && x.thread === m.thread);
  const t = now();
  if (!c) {
    c = { id: randomUUID(), business_id: ev.business_id, connection_id: ev.connection_id, channel: m.channel, thread: m.thread, contact: m.from, context: {}, assigned_to: employeeId, status: "open", intent: null, lead: null, escalation: null, messages: [], last_inbound_at: null, created_at: t, updated_at: t };
    list.push(c);
    if (list.length > MAX_CONVERSATIONS) list.splice(0, list.length - MAX_CONVERSATIONS);
  }
  const dup = c.messages.find(x => x.direction === "in" && x.provider_id === m.message_id);
  if (dup) return { convId: c.id, msgId: dup.id, isNew: false };
  const msg: ConvMessage = { id: randomUUID(), direction: "in", text: m.text, at: m.sent_at ?? t, status: "received", by: "customer", provider_id: m.message_id, event_id: ev.id };
  c.messages.push(msg);
  if (c.messages.length > MAX_MESSAGES) c.messages.splice(0, c.messages.length - MAX_MESSAGES);
  Object.assign(c, { contact: m.from ?? c.contact, context: { ...c.context, ...m.context }, last_inbound_at: msg.at, updated_at: t, assigned_to: c.assigned_to ?? employeeId });
  if (c.status === "resolved") c.status = "open";
  audit(s, ev.business_id, "system", "message.received", `conversation:${c.id}`, "received", c.id, { channel: c.channel, employee: employeeId });
  if (!employeeId && !c.escalation) escalate(s, c, "No employee is allowed to read messages from this account yet, so this waits for you.");
  return { convId: c.id, msgId: msg.id, isNew: true };
}

const windowOpen = (c: Conversation) => !WINDOW_24H.includes(c.channel) || (!!c.last_inbound_at && Date.now() - Date.parse(c.last_inbound_at) < 24 * 3_600_000);
const settingsOf = (s: DevState, b: string): MessagingSettings => s.businesses[b]?.messaging ?? DEFAULT_SETTINGS;

function escalate(s: DevState, c: Conversation, reason: string) {
  c.status = "needs_owner"; c.escalation = { reason: reason.slice(0, 240), at: now() }; c.updated_at = now();
  audit(s, c.business_id, `agent:${c.assigned_to ?? "system"}`, "conversation.escalated", `conversation:${c.id}`, "needs_owner", c.id, { reason: c.escalation.reason });
}

/**
 * The support employee handles one inbound message. Idempotent: a message that already has a reply
 * (or a decision) is skipped, so a retried task never answers twice.
 */
export async function respondToInbound(businessId: string, convId: string, msgId: string, employeeId: string): Promise<"replied" | "drafted" | "escalated" | "skipped"> {
  const snap = await discoveryRepository().readState(businessId, s => {
    const c = convsOf(s, businessId).find(x => x.id === convId);
    const b = s.businesses[businessId];
    const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
    const recent = convsOf(s, businessId).flatMap(x => x.messages).filter(m => m.direction === "out" && m.by === employeeId && m.at > hourAgo).length;
    return c && b ? { c: structuredClone(c), name: b.name ?? "this business", products: b.products ?? [], settings: settingsOf(s, businessId), recent } : null;
  });
  if (!snap) return "skipped";
  const { c } = snap;
  const inbound = c.messages.find(m => m.id === msgId);
  if (!inbound || c.messages.some(m => m.in_reply_to === msgId) || c.escalation?.at && c.escalation.at > inbound.at) return "skipped";
  if (snap.recent >= AI_REPLIES_PER_HOUR()) {
    await discoveryRepository().transact(businessId, s => { const x = convsOf(s, businessId).find(y => y.id === convId); if (x) escalate(s, x, "The hourly reply limit was reached, so this conversation waits for you."); });
    return "escalated";
  }
  const ctx = { business: snap.name, knowledge: snap.settings.knowledge, products: snap.products, history: c.messages.filter(m => m.status !== "discarded").map(m => ({ by: m.direction === "in" ? "customer" : "business", text: m.text })) };
  let p: ReplyProposal; let writtenBy: string;
  try {
    const r = await (await getAi()).structured({ task: "customer_reply", schema: ReplySchema, system: REPLY_SYSTEM, user: replyPrompt(ctx), context: ctx, maxTokens: 500 });
    p = r.data; writtenBy = r.mode === "live" ? `${r.provider}:${r.model}` : "offline rules (not AI)";
  } catch (e) {
    await discoveryRepository().transact(businessId, s => { const x = convsOf(s, businessId).find(y => y.id === convId); if (x) escalate(s, x, `The AI couldn't answer (${e instanceof AiError ? e.code : "error"}), so this waits for you.`); });
    return "escalated";
  }
  const text = (p.reply ?? "").trim();
  const checks = text ? checkReply(text, { products: snap.products, knowledge: snap.settings.knowledge }) : [];
  const sensitive = p.needs_owner || ["complaint", "refund", "sensitive"].includes(p.intent);
  const draft = (status: ConvMessage["status"], note: string | null): ConvMessage => ({ id: randomUUID(), direction: "out", text, at: now(), status, by: employeeId, provider_id: null, in_reply_to: msgId, checks, note: note ? `${note} Written by ${writtenBy}.` : `Written by ${writtenBy}.` });
  const decide = (s: DevState, x: Conversation) => {
    x.intent = p.intent; x.updated_at = now();
    if (p.lead && !x.lead) {
      // Coordinate: a sales employee (if the workforce has one) is told about the lead.
      const sales = s.businesses[businessId]?.workforce?.employees.find(e => e.status === "active" && e.skills.some(k => k.id === "capture_lead"));
      x.lead = { note: (p.lead_note ?? "Buying interest").slice(0, 240), at: now() };
      audit(s, businessId, `agent:${employeeId}`, "lead.identified", `conversation:${x.id}`, "lead", x.id, { note: x.lead.note, handed_to: sales?.id ?? null });
    }
  };
  // Escalate: sensitive, no usable reply, or the channel's reply window has closed.
  if (sensitive || !text || p.intent === "spam" || !windowOpen(c)) {
    await discoveryRepository().transact(businessId, s => {
      const x = convsOf(s, businessId).find(y => y.id === convId); if (!x) return;
      decide(s, x);
      if (p.intent === "spam") { x.status = "resolved"; audit(s, businessId, `agent:${employeeId}`, "conversation.spam", `conversation:${x.id}`, "resolved", x.id); return; }
      if (text && windowOpen(c)) x.messages.push(draft("pending_approval", "Suggested reply, waiting for you."));
      escalate(s, x, !windowOpen(c) ? "The customer's 24-hour reply window has closed: the platform only allows approved templates now." : p.reason || "Needs the owner.");
    });
    return "escalated";
  }
  const auto = snap.settings.mode === "auto" && checksPass(checks);
  if (!auto) {
    await discoveryRepository().transact(businessId, s => {
      const x = convsOf(s, businessId).find(y => y.id === convId); if (!x) return;
      decide(s, x);
      x.messages.push(draft("pending_approval", checksPass(checks) ? "Waiting for your approval." : "A check didn't pass, so this waits for you."));
      audit(s, businessId, `agent:${employeeId}`, "reply.drafted", `conversation:${x.id}`, "pending_approval", x.id, {});
    });
    return "drafted";
  }
  const out = draft("approved", "Sent automatically: routine reply that passed every check.");
  await discoveryRepository().transact(businessId, s => { const x = convsOf(s, businessId).find(y => y.id === convId); if (x) { decide(s, x); x.messages.push(out); } });
  return (await deliver(businessId, convId, out.id, employeeId, `reply:${msgId}`)) ? "replied" : "drafted";
}

/** Record ONE durable reply action for an approved message (the action layer sends it in the background). */
async function deliver(businessId: string, convId: string, msgId: string, agent: string, key: string): Promise<boolean> {
  const st = await discoveryRepository().readState(businessId, s => {
    const c = convsOf(s, businessId).find(x => x.id === convId);
    const conn = ((s.connections ?? {})[businessId] ?? []).find(x => x.id === c?.connection_id);
    return c && conn ? { c: structuredClone(c), conn: { id: conn.id, connector: conn.connector, name: conn.label } } : null;
  });
  if (!st) return false;
  const m = st.c.messages.find(x => x.id === msgId)!;
  const action = replyActionFor(st.conn.connector);
  const hold = async (note: string) => discoveryRepository().transact(businessId, s => {
    const x = convsOf(s, businessId).find(y => y.id === convId)?.messages.find(y => y.id === msgId);
    if (x && x.status === "approved") { x.status = "pending_approval"; x.note = note; }
  });
  if (!action) { await hold(`${st.conn.name} can't send replies from EmployAI yet.`); return false; }
  try {
    await requestAction(businessId, {
      connectionId: st.conn.id, action, agent, idempotencyKey: key, correlationId: convId,
      input: { conversation_id: convId, message_id: msgId, thread: st.c.thread, text: m.text, context: st.c.context },
    }, (s, attempt) => {
      const x = convsOf(s, businessId).find(y => y.id === convId)?.messages.find(y => y.id === msgId);
      if (x) { x.status = "approved"; x.attempt_id = attempt.id; }
    });
    return true;
  } catch (e) {
    const why = e instanceof IntegrationError && e.code === "NOT_AUTHORISED" ? `The employee isn't allowed to send messages on ${st.conn.name} yet. Allow “Send messages” in Integrations, then approve again.`
      : e instanceof IntegrationError ? e.message : "The reply couldn't be queued.";
    await hold(why);
    return false;
  }
}

// ---- owner controls ------------------------------------------------------------------------------
async function ownerEdit(businessId: string, convId: string, fn: (s: DevState, c: Conversation) => void) {
  return discoveryRepository().transact(businessId, s => {
    const c = convsOf(s, businessId).find(x => x.id === convId);
    if (!c) throw new ServiceError("NOT_FOUND", 404, "That conversation doesn't exist.");
    fn(s, c); c.updated_at = now();
  });
}

/** Owner approves a drafted reply (optionally edited). One approval key = one send. */
export async function approveReply(businessId: string, convId: string, msgId: string, text: string | null, approvalKey: string): Promise<void> {
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(approvalKey)) throw new ServiceError("VALIDATION_FAILED", 400, "Missing approval key.");
  let agent = "";
  await ownerEdit(businessId, convId, (s, c) => {
    const m = c.messages.find(x => x.id === msgId);
    if (!m || m.direction !== "out") throw new ServiceError("NOT_FOUND", 404, "That reply doesn't exist.");
    if (m.status !== "pending_approval") return;                                  // already approved (repeat click) or sent
    if (text !== null) { const t = text.trim(); if (!t || t.length > 2000) throw new ServiceError("VALIDATION_FAILED", 400, "Write a reply first."); if (t !== m.text) { m.text = t; m.by = "owner"; } }
    if (WINDOW_24H.includes(c.channel) && !windowOpen(c)) throw new ServiceError("WINDOW_CLOSED", 409, "This customer's 24-hour reply window has closed; the platform only allows approved message templates.");
    m.status = "approved"; m.note = "Approved by you.";
    agent = c.assigned_to ?? "";
    audit(s, businessId, "owner", "reply.approved", `conversation:${c.id}`, "approved", c.id, {});
  });
  if (agent) await deliver(businessId, convId, msgId, agent, `reply:${msgId}:${approvalKey}`);
}

/** Owner writes a reply themself (sent through the conversation's employee, under the same rules). */
export async function ownerReply(businessId: string, convId: string, text: string, approvalKey: string): Promise<void> {
  const t = text.trim();
  if (!t || t.length > 2000) throw new ServiceError("VALIDATION_FAILED", 400, "Write a reply first.");
  let msgId = "";
  await ownerEdit(businessId, convId, (s, c) => {
    const m: ConvMessage = { id: randomUUID(), direction: "out", text: t, at: now(), status: "pending_approval", by: "owner", provider_id: null, in_reply_to: null, note: "Written by you." };
    c.messages.push(m); msgId = m.id;
  });
  await approveReply(businessId, convId, msgId, null, approvalKey);
}

export async function discardReply(businessId: string, convId: string, msgId: string): Promise<void> {
  await ownerEdit(businessId, convId, (s, c) => {
    const m = c.messages.find(x => x.id === msgId);
    if (m && m.status === "pending_approval") { m.status = "discarded"; audit(s, businessId, "owner", "reply.discarded", `conversation:${c.id}`, "discarded", c.id); }
  });
}

export async function setConversationStatus(businessId: string, convId: string, status: "open" | "resolved"): Promise<void> {
  await ownerEdit(businessId, convId, (s, c) => { c.status = status; if (status === "resolved") c.escalation = null; audit(s, businessId, "owner", `conversation.${status}`, `conversation:${c.id}`, status, c.id); });
}

export async function setMessagingSettings(businessId: string, input: { mode?: "approve" | "auto"; knowledge?: string }): Promise<MessagingSettings> {
  return discoveryRepository().transact(businessId, s => {
    const b = s.businesses[businessId];
    if (!b) throw new ServiceError("NOT_FOUND", 404, "Not found.");
    const cur = b.messaging ?? DEFAULT_SETTINGS;
    const next: MessagingSettings = { mode: input.mode ?? cur.mode, knowledge: (input.knowledge ?? cur.knowledge).slice(0, MAX_KNOWLEDGE), updated_at: now() };
    b.messaging = next;
    audit(s, businessId, "owner", "messaging.settings_changed", `business:${businessId}`, next.mode, businessId, { mode: next.mode, knowledge_chars: next.knowledge.length });
    return next;
  });
}

/** Does this employee handle customer messages? (an active workforce employee with the answer_enquiry skill) */
export function handlesMessages(s: DevState, businessId: string, employeeId: string): boolean {
  const e = s.businesses[businessId]?.workforce?.employees.find(x => x.id === employeeId);
  return !!e && e.status === "active" && e.skills.some(k => k.id === "answer_enquiry" && SKILLS.answer_enquiry.status === "operational");
}
