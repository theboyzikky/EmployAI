import "server-only";
// Task handlers for the integration layer (registered with the worker on import).
//  - drive_action:  drive a durable outbound action (src/lib/integrations/actions.ts) and map its state
//                   to the task: finished → done; waiting for a provider's retry time → later; unknown →
//                   look again shortly (reconcile, safe re-send or escalation happen in driveAction).
//  - process_event: hand a routed inbound event to the automation registered for (employee, event type).
//                   P0 has no employee automations yet: the event is kept, marked for the owner, and the
//                   task completes — nothing is invented. P1 registers the first real one.
import { discoveryRepository } from "@/lib/discovery/store";
import type { AgentKey } from "@/lib/catalogue/catalogue";
import { driveAction } from "@/lib/integrations/actions";
import { audit, loadConnectionForUse, markReauthRequired, patchConnection, ReconnectRequired } from "@/lib/integrations/connections";
import { storeInboundEvents } from "@/lib/integrations/inbox";
import { connectorFor } from "@/lib/integrations/registry";
import { enqueueTaskIn } from "./tasks";
import type { InboundEventRecord } from "@/lib/integrations/records";
import type { TaskRecord } from "./records";
import { registerTaskHandler, type TaskResult } from "./worker";
import "@/lib/content/hooks";   // the content guard and observer (publishing)
import "@/lib/messaging/hooks";  // the reply guard and observer (customer messaging)
import { asInboundMessage, handlesMessages, ingestInbound, respondToInbound } from "@/lib/messaging/service";

const soon = (ms: number) => new Date(Date.now() + ms).toISOString();

registerTaskHandler("drive_action", async (task: TaskRecord): Promise<TaskResult> => {
  const status = await driveAction(task.business_id, task.ref);
  if (status === "missing") return { kind: "cancelled", reason: "The action no longer exists." };
  if (status === "done" || status === "rejected" || status === "aborted" || status === "escalated") return { kind: "done" };
  if (status === "busy" || status === "sending") return { kind: "later", atIso: soon(15_000) };
  if (status === "unknown") return { kind: "later", atIso: soon(30_000) };
  // prepared: a provider asked us to wait until retry_at
  const at = await discoveryRepository().readState(task.business_id, s => (s.action_attempts ?? {})[task.business_id]?.find(a => a.id === task.ref)?.retry_at ?? null);
  return { kind: "later", atIso: at ?? soon(30_000) };
});

/** An employee automation for one event type (registered by the workforce layer, P1 onwards). */
export type EventAutomation = (ev: InboundEventRecord) => Promise<TaskResult>;
const AUTOMATIONS = Symbol.for("employai.eventAutomations");
const ga = globalThis as unknown as { [AUTOMATIONS]?: Map<string, EventAutomation> };
const automations: Map<string, EventAutomation> = (ga[AUTOMATIONS] ??= new Map());
export function registerEventAutomation(agent: AgentKey, eventType: string, fn: EventAutomation) { automations.set(`${agent}:${eventType}`, fn); }

registerTaskHandler("process_event", async (task: TaskRecord): Promise<TaskResult> => {
  const ev = await discoveryRepository().readState(task.business_id, s => (s.inbound_events ?? {})[task.business_id]?.find(e => e.id === task.ref) ?? null);
  if (!ev) return { kind: "cancelled", reason: "The event is no longer kept." };
  // Customer messages: always filed in the owner's Inbox; answered only by an active employee the owner
  // allowed to read this connection's messages (the route) and that has the support skill.
  if (ev.type === "message.received" && asInboundMessage(ev)) {
    const agent = ev.status === "routed" ? ev.routed_to : null;
    const filed = await discoveryRepository().transact(task.business_id, s => {
      const r = ingestInbound(s, ev, agent);
      return r ? { ...r, answers: !!agent && handlesMessages(s, task.business_id, agent) } : null;
    });
    if (filed?.answers && agent) await respondToInbound(task.business_id, filed.convId, filed.msgId, agent);
    return { kind: "done" };
  }
  if (ev.status !== "routed" || !ev.routed_to) return { kind: "done" };   // unrouted: already flagged for the owner
  const fn = automations.get(`${ev.routed_to}:${ev.type}`);
  if (fn) return fn(ev);
  await discoveryRepository().transact(task.business_id, s => {
    const e = (s.inbound_events ?? {})[task.business_id]?.find(x => x.id === ev.id);
    if (!e || e.note) return;
    e.note = `Routed to the ${ev.routed_to} employee. No automation for "${ev.type}" events is active yet, so it is kept for the owner.`;
    audit(s, task.business_id, "system", "event.awaiting_automation", `event:${ev.id}`, "routed", ev.id, { agent: ev.routed_to, type: ev.type });
  });
  return { kind: "done" };
});

/**
 * poll_mailbox: one connection's scheduled check for new messages (Gmail, Outlook). New messages are
 * stored (once each) BEFORE the cursor advances, so a crash can only cause a deduplicated re-read.
 * Stops by itself when the connection is no longer active; credentials refused → reconnection required.
 */
export const MAIL_POLL_MS = () => Math.max(60, Number(process.env.EMPLOYAI_MAIL_POLL_SECONDS) || 300) * 1000;
registerTaskHandler("poll_mailbox", async (task: TaskRecord): Promise<TaskResult> => {
  const conn = await loadConnectionForUse(task.business_id, task.ref).catch(e => { if (e instanceof ReconnectRequired) return null; throw e; });
  if (!conn || conn.record.status !== "active") return { kind: "cancelled", reason: "The connection isn't active." };
  const k = connectorFor(conn.record.connector);
  if (!k?.poll) return { kind: "cancelled", reason: "This connector isn't polled." };
  const r = await k.poll({ config: conn.record.config, secrets: conn.secrets });
  if ("error" in r) {
    if (r.error === "auth") { await markReauthRequired(task.business_id, task.ref, r.detail); return { kind: "cancelled", reason: r.detail }; }
    return { kind: "later", atIso: soon(MAIL_POLL_MS()) };
  }
  if (r.events.length) await storeInboundEvents(task.business_id, conn.record.id, conn.record.connector, conn.record.routes, r.events, (s, ev) => { enqueueTaskIn(s, ev.business_id, { kind: "process_event", ref: ev.id, dedupeKey: `event:${ev.id}` }); });
  await patchConnection(task.business_id, task.ref, c => { c.config = { ...c.config, ...r.config }; });
  return { kind: "later", atIso: soon(MAIL_POLL_MS()) };
});

export const INTEGRATION_HANDLERS_REGISTERED = true;
