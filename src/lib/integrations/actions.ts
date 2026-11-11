import "server-only";
// Outbound actions (layer B + D): how an employee performs a real action through a connection, durably.
//
// EmployAI does NOT promise exactly-once delivery to external systems. It promises:
//  - one durable ACTION RECORD per logical action (unique idempotency key per business);
//  - every delivery attempt is recorded (status "sending", deliveries+1) BEFORE it is made, in the same
//    atomic commit that re-checks authorisation (kill switch, employee status, grant, connection);
//  - outcomes are classified: done (proof: provider ref), rejected (provably not done) or unknown;
//  - an UNKNOWN outcome is never blindly retried. It is reconciled with the provider when the connector
//    can; re-sent ONLY when the provider honours our idempotency key (same key, bounded times); otherwise
//    ESCALATED to the owner, who decides;
//  - a worker that dies mid-delivery leaves "sending": the next driver treats it as unknown (same rules);
//  - one driver at a time per action (a lease, compare-and-set), across server instances.
// Payments never go through here: money moves only through the NEAR treasury path (payment-executor.ts).
import { randomUUID } from "node:crypto";
import { discoveryRepository, type DevState } from "@/lib/discovery/store";
import { audit, IntegrationError, loadConnectionForUse } from "./connections";
import type { ActionAttemptRecord, ActionStatus } from "./records";
import { actionSpec } from "./registry";
import { enqueueTaskIn } from "@/lib/automation/tasks";
import type { ActionOutcome } from "./types";

export const ACTION_LEASE_MS = 60_000;
/** Deliveries of one action that a provider-idempotent connector may make (the same key each time). */
export const MAX_DELIVERIES = 3;
/** Back-off for a provider's explicit "try later" (rejected + retryable), by delivery count. */
const backoffMs = (n: number) => Math.min(15 * 60_000, 30_000 * 2 ** Math.max(0, n - 1));
export const ACTIONS_PER_EMPLOYEE_PER_DAY = () => Number(process.env.EMPLOYAI_LIMIT_ACTIONS_PER_EMPLOYEE_DAY) || 200;
const KEY = /^[A-Za-z0-9:._-]{8,128}$/;
const TERMINAL: readonly ActionStatus[] = ["done", "rejected", "aborted", "escalated"];
const INSTANCE = randomUUID();

const attemptsOf = (s: DevState, b: string) => ((s.action_attempts ??= {})[b] ??= []);

// ---- domain hooks (registered by the modules that own the work, e.g. content publishing) ----------
/** A guard re-checked in the SAME commit as every delivery (e.g. "the post is still approved"). */
export type ActionGuard = (s: DevState, a: Pick<ActionAttemptRecord, "business_id" | "action" | "agent" | "input">) => { ok: true } | { ok: false; code: string; message: string };
/** Called in the SAME commit whenever an action's status changes (keeps the owning record in step). */
export type ActionObserver = (s: DevState, a: ActionAttemptRecord) => void;
const HOOKS = Symbol.for("employai.actionHooks");
const gh = globalThis as unknown as { [HOOKS]?: { guards: Map<string, ActionGuard>; observers: Map<string, ActionObserver> } };
const hooks = (gh[HOOKS] ??= { guards: new Map(), observers: new Map() });
export function registerActionGuard(action: string, g: ActionGuard) { hooks.guards.set(action, g); }
export function registerActionObserver(action: string, o: ActionObserver) { hooks.observers.set(action, o); }
const observe = (s: DevState, a: ActionAttemptRecord) => hooks.observers.get(a.action)?.(s, a);

/** An employee is active if it's an approved catalogue agent or an active employee of the approved workforce. */
export function employeeActive(s: DevState, businessId: string, id: string): boolean {
  const legacy = (s.agents[businessId] ?? []).find(x => x.key === id);
  if (legacy) return legacy.status === "approved";
  const wf = s.businesses[businessId]?.workforce;
  return !!wf && wf.status === "approved" && wf.employees.some(e => e.id === id && e.status === "active");
}
const addMs = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString();

/** Deterministic authorisation, evaluated on the LATEST stored state inside a commit. */
export function authorise(s: DevState, a: Pick<ActionAttemptRecord, "business_id" | "connection_id" | "action" | "agent"> & { input?: Record<string, unknown> }, o: { guards?: boolean } = {}): { ok: true } | { ok: false; code: string; message: string } {
  const b = s.businesses[a.business_id];
  if (!b) return { ok: false, code: "NOT_FOUND", message: "The business no longer exists." };
  if (b.kill_switch) return { ok: false, code: "KILL_SWITCH_ACTIVE", message: "The kill switch is on: nothing is sent." };
  if (!employeeActive(s, a.business_id, a.agent)) return { ok: false, code: "EMPLOYEE_NOT_ACTIVE", message: `The ${a.agent} employee isn't approved and active.` };
  const conn = ((s.connections ?? {})[a.business_id] ?? []).find(c => c.id === a.connection_id);
  if (!conn || conn.status !== "active") return { ok: false, code: "CONNECTION_NOT_ACTIVE", message: "The connection isn't active." };
  if (!conn.grants.some(g => g.agent === a.agent && g.actions.includes(a.action))) return { ok: false, code: "NOT_AUTHORISED", message: `The ${a.agent} employee isn't allowed to use ${a.action} on this connection.` };
  // Domain guards are SEND-time checks (e.g. "still approved"); recording a request skips them.
  const guard = o.guards === false ? undefined : hooks.guards.get(a.action);
  if (guard) { const r = guard(s, { business_id: a.business_id, action: a.action, agent: a.agent, input: a.input ?? {} }); if (!r.ok) return r; }
  return { ok: true };
}

/**
 * Record an action an employee wants to perform (nothing is sent here). The same idempotency key always
 * returns the same record. Input is validated by the connector's deterministic schema first; the
 * employee's permission is checked on the stored state; a daily per-employee cap applies.
 */
export async function requestAction(businessId: string, r: { connectionId: string; action: string; agent: string; idempotencyKey: string; input: unknown; correlationId: string; notBefore?: string | null }, inCommit?: (s: DevState, attempt: ActionAttemptRecord) => void): Promise<{ attemptId: string; created: boolean }> {
  if (!KEY.test(r.idempotencyKey)) throw new IntegrationError("VALIDATION_FAILED", 400, "Invalid idempotency key.");
  const found = actionSpec(r.action);
  if (!found) throw new IntegrationError("VALIDATION_FAILED", 400, "Unknown action.");
  let input: Record<string, unknown>;
  try { input = found.spec.parse(r.input); } catch { throw new IntegrationError("VALIDATION_FAILED", 400, `The input for ${r.action} is invalid.`); }
  return discoveryRepository().transact(businessId, s => {
    const list = attemptsOf(s, businessId);
    const existing = list.find(x => x.idempotency_key === r.idempotencyKey);
    if (existing) return { attemptId: existing.id, created: false };
    const conn = ((s.connections ?? {})[businessId] ?? []).find(c => c.id === r.connectionId);
    if (conn && conn.connector !== found.connector.key) throw new IntegrationError("VALIDATION_FAILED", 400, "That action doesn't belong to this connection.");
    const auth = authorise(s, { business_id: businessId, connection_id: r.connectionId, action: r.action, agent: r.agent, input }, { guards: false });
    if (!auth.ok) { audit(s, businessId, `agent:${r.agent}`, "action.refused", `action:${r.action}`, auth.code, r.correlationId); throw new IntegrationError(auth.code, 403, auth.message); }
    const today = new Date().toISOString().slice(0, 10);
    if (list.filter(x => x.agent === r.agent && x.created_at.startsWith(today)).length >= ACTIONS_PER_EMPLOYEE_PER_DAY()) throw new IntegrationError("ACTION_LIMIT_REACHED", 429, `The ${r.agent} employee has reached today's action limit.`);
    const now = new Date().toISOString();
    const rec: ActionAttemptRecord = {
      id: randomUUID(), business_id: businessId, connection_id: r.connectionId, action: r.action, agent: r.agent, idempotency_key: r.idempotencyKey,
      input, status: "prepared", deliveries: 0, provider_ref: null, result: null, error: null, retry_at: r.notBefore ?? null, lease_owner: null, lease_expires_at: null,
      correlation_id: r.correlationId, created_at: now, updated_at: now,
    };
    list.push(rec);
    audit(s, businessId, `agent:${r.agent}`, "action.prepared", `action:${rec.id}`, "prepared", r.correlationId, { action: r.action, connection: r.connectionId });
    // Its delivery is a durable task, enqueued in this same commit: recorded work can't lose its task.
    // A scheduled action (notBefore) is due at its time; nothing is sent before it.
    const delayMs = r.notBefore ? Math.max(0, Date.parse(r.notBefore) - Date.now()) : 0;
    enqueueTaskIn(s, businessId, { kind: "drive_action", ref: rec.id, dedupeKey: `action:${rec.id}`, delayMs });
    inCommit?.(s, rec);
    return { attemptId: rec.id, created: true };
  });
}

type Next = "continue" | "stop";

/** Drive one action as far as it can safely go now. One driver at a time (lease), across instances. */
export async function driveAction(businessId: string, attemptId: string): Promise<ActionStatus | "busy" | "missing"> {
  const repo = discoveryRepository();
  const owner = `${INSTANCE}:${randomUUID()}`;
  const claimed = await repo.transact(businessId, s => {
    const a = attemptsOf(s, businessId).find(x => x.id === attemptId);
    if (!a) return "missing" as const;
    if (TERMINAL.includes(a.status)) return a.status;
    const now = new Date().toISOString();
    if (a.lease_owner && a.lease_expires_at && a.lease_expires_at > now) return "busy" as const;
    // A driver that died mid-delivery left "sending": we can't know if it arrived → unknown.
    if (a.status === "sending") { a.status = "unknown"; a.error = { code: "OUTCOME_UNKNOWN", message: "The previous delivery was interrupted; its outcome is unknown." }; audit(s, businessId, "system", "action.unknown", `action:${a.id}`, "unknown", a.correlation_id, { reason: "interrupted" }); observe(s, a); }
    a.lease_owner = owner; a.lease_expires_at = addMs(now, ACTION_LEASE_MS); a.updated_at = now;
    return "claimed" as const;
  });
  if (claimed !== "claimed") return claimed;
  try {
    for (let i = 0; i < 4; i++) {
      const a = await repo.readState(businessId, s => attemptsOf(s, businessId).find(x => x.id === attemptId) ?? null);
      if (!a) return "missing";
      if (TERMINAL.includes(a.status)) return a.status;
      const next = a.status === "prepared" ? await deliver(businessId, a, owner, ["prepared"])
        : a.status === "unknown" ? await fromUnknown(businessId, a, owner)
        : "stop";
      if (next === "stop") break;
    }
    return (await repo.readState(businessId, s => attemptsOf(s, businessId).find(x => x.id === attemptId)?.status)) ?? "missing";
  } finally {
    await repo.transact(businessId, s => {
      const a = attemptsOf(s, businessId).find(x => x.id === attemptId);
      if (a && a.lease_owner === owner) { a.lease_owner = null; a.lease_expires_at = null; }
    }).catch(() => undefined);   // if this fails, the lease simply expires
  }
}

/** Compare-and-set on status + lease, with a fresh authorisation check, in ONE commit. */
function cas(businessId: string, attemptId: string, owner: string, from: readonly ActionStatus[], fn: (a: ActionAttemptRecord, s: DevState) => boolean): Promise<boolean> {
  return discoveryRepository().transact(businessId, s => {
    const a = attemptsOf(s, businessId).find(x => x.id === attemptId);
    if (!a || !from.includes(a.status) || a.lease_owner !== owner) return false;
    const before = a.status;
    const ok = fn(a, s);
    if (ok) { a.updated_at = new Date().toISOString(); if (a.status !== before) observe(s, a); }
    return ok;
  });
}

/** One delivery: authorise + record it (write-ahead), make it, record the outcome. */
async function deliver(businessId: string, a: ActionAttemptRecord, owner: string, from: readonly ActionStatus[]): Promise<Next> {
  if (a.retry_at && a.retry_at > new Date().toISOString()) return "stop";               // a provider asked us to wait
  const found = actionSpec(a.action);
  if (!found) { await cas(businessId, a.id, owner, from, x => { x.status = "aborted"; x.error = { code: "CONNECTOR_UNAVAILABLE", message: "This integration isn't available on this server; nothing was sent." }; return true; }); return "stop"; }
  const go = await cas(businessId, a.id, owner, from, (x, s) => {
    const auth = authorise(s, x);
    if (!auth.ok) {
      x.status = "aborted"; x.error = { code: auth.code, message: `${auth.message} Nothing was sent.` };
      audit(s, businessId, "system", "action.aborted", `action:${x.id}`, "aborted", x.correlation_id, { code: auth.code });
      return true;
    }
    x.status = "sending"; x.deliveries += 1; x.retry_at = null;
    audit(s, businessId, `agent:${x.agent}`, "action.sending", `action:${x.id}`, "sending", x.correlation_id, { delivery: x.deliveries });
    return true;
  }).catch(() => false);                                                                    // store down → nothing sent
  const now = await discoveryRepository().readState(businessId, s => attemptsOf(s, businessId).find(x => x.id === a.id) ?? null).catch(() => null);
  if (!go || !now || now.status !== "sending" || now.lease_owner !== owner) return "stop";
  let outcome: ActionOutcome;
  try {
    const conn = await loadConnectionForUse(businessId, a.connection_id);
    if (!conn) throw new Error("connection gone");
    outcome = await found.spec.execute({ businessId, connectionId: a.connection_id, idempotencyKey: a.idempotency_key, config: conn.record.config, secrets: conn.secrets }, a.input);
  } catch {
    // Failing to even start (credentials, connection) means nothing was sent; anything after send is unknown.
    outcome = { kind: "unknown", detail: "The delivery failed in an unexpected way; its outcome is unknown." };
  }
  await settle(businessId, a.id, owner, now.deliveries, outcome);
  return "stop";
}

async function settle(businessId: string, attemptId: string, owner: string, deliveries: number, o: ActionOutcome): Promise<void> {
  await cas(businessId, attemptId, owner, ["sending"], (x, s) => {
    if (o.kind === "done") {
      x.status = "done"; x.provider_ref = o.ref; x.result = o.data ?? null; x.error = null;
      audit(s, businessId, `agent:${x.agent}`, "action.done", `action:${x.id}`, "done", x.correlation_id, { provider_ref: o.ref, delivery: deliveries });
    } else if (o.kind === "rejected" && o.retryable && deliveries < MAX_DELIVERIES) {
      // Provably not done, and the provider asked us to try later: back to prepared, after a wait.
      x.status = "prepared"; x.retry_at = addMs(new Date().toISOString(), backoffMs(deliveries)); x.error = { code: o.code, message: o.detail };
      audit(s, businessId, "system", "action.retry_scheduled", `action:${x.id}`, "prepared", x.correlation_id, { code: o.code, retry_at: x.retry_at });
    } else if (o.kind === "rejected") {
      x.status = "rejected"; x.error = { code: o.code, message: o.detail };
      audit(s, businessId, "system", "action.rejected", `action:${x.id}`, "rejected", x.correlation_id, { code: o.code });
    } else {
      x.status = "unknown"; x.error = { code: "OUTCOME_UNKNOWN", message: o.detail };
      audit(s, businessId, "system", "action.unknown", `action:${x.id}`, "unknown", x.correlation_id, {});
    }
    return true;
  }).catch(() => undefined);   // store down: the record stays "sending" → treated as unknown next time (never "done" without proof)
}

/** Unknown outcome: reconcile if possible; re-send only with provider idempotency; else escalate. */
async function fromUnknown(businessId: string, a: ActionAttemptRecord, owner: string): Promise<Next> {
  const found = actionSpec(a.action);
  if (found?.spec.reconcile) {
    let r: ActionOutcome | null = null;
    try {
      const conn = await loadConnectionForUse(businessId, a.connection_id);
      if (conn) r = await found.spec.reconcile({ businessId, connectionId: a.connection_id, idempotencyKey: a.idempotency_key, config: conn.record.config, secrets: conn.secrets }, a.input);
    } catch { r = null; }
    if (r && r.kind !== "unknown") {
      await cas(businessId, a.id, owner, ["unknown"], (x, s) => {
        x.status = r!.kind === "done" ? "done" : "rejected";
        x.provider_ref = r!.kind === "done" ? r!.ref : x.provider_ref;
        if (r!.kind === "done") x.result = r!.data ?? null;
        x.error = r!.kind === "done" ? null : { code: r!.code, message: r!.detail };
        audit(s, businessId, "system", "action.reconciled", `action:${x.id}`, x.status, x.correlation_id, {});
        return true;
      });
      return "stop";
    }
  }
  if (found?.spec.idempotency === "provider_key" && a.deliveries < MAX_DELIVERIES) {
    // Safe ONLY because the provider ignores a repeat of the same idempotency key.
    return deliver(businessId, a, owner, ["unknown"]);
  }
  await cas(businessId, a.id, owner, ["unknown"], (x, s) => {
    x.status = "escalated";
    x.error = { code: "NEEDS_OWNER", message: "We can't tell whether this was delivered and re-sending could duplicate it. Check with the recipient; nothing will be re-sent automatically." };
    audit(s, businessId, "system", "action.escalated", `action:${x.id}`, "escalated", x.correlation_id, { deliveries: x.deliveries });
    return true;
  });
  return "stop";
}
