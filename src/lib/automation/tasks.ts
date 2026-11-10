// Durable automation tasks (layer C), stored in the business partition — the source of truth for
// background work. Pure functions over a DevState, used INSIDE store commits, so a task is enqueued in
// the same atomic step as the change that needs it (an event stored, an action recorded, a run started).
// Whatever wakes a worker (after(), QStash, the recovery sweep) only says "look now"; losing a wake-up
// delays work, it never loses or duplicates it.
import { randomUUID } from "node:crypto";
import type { DevState } from "@/lib/discovery/store";
import type { TaskKind, TaskRecord } from "./records";

export const TASK_LEASE_MS = 90_000;
export const DEFAULT_MAX_ATTEMPTS = 8;
const KEEP_FINISHED = 200;
const backoffMs = (attempt: number) => Math.min(30 * 60_000, 15_000 * 2 ** Math.max(0, attempt - 1));
const isLive = (t: TaskRecord) => t.status === "queued" || t.status === "running";
const addMs = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString();
const tasksOf = (s: DevState, b: string) => ((s.tasks ??= {})[b] ??= []);

/** Enqueue (or return the live task with the same dedupe key). */
export function enqueueTaskIn(s: DevState, businessId: string, t: { kind: TaskKind; ref: string; dedupeKey: string; delayMs?: number; maxAttempts?: number }, nowIso = new Date().toISOString()): TaskRecord {
  const list = tasksOf(s, businessId);
  const live = list.find(x => x.dedupe_key === t.dedupeKey && isLive(x));
  if (live) return live;
  const rec: TaskRecord = {
    id: randomUUID(), business_id: businessId, kind: t.kind, ref: t.ref, dedupe_key: t.dedupeKey, status: "queued",
    attempts: 0, max_attempts: t.maxAttempts ?? DEFAULT_MAX_ATTEMPTS, next_at: addMs(nowIso, t.delayMs ?? 0),
    lease_owner: null, lease_expires_at: null, last_error: null, created_at: nowIso, updated_at: nowIso,
  };
  list.push(rec);
  prune(list);
  return rec;
}

/**
 * Claim the next due task: queued and due, or running with an EXPIRED lease (its worker died). The claim
 * counts as an attempt and takes a lease, in the caller's commit (one worker per task, across instances).
 */
export function claimDueTaskIn(s: DevState, businessId: string, owner: string, nowIso = new Date().toISOString()): TaskRecord | null {
  const list = tasksOf(s, businessId);
  const due = list
    .filter(t => (t.status === "queued" && t.next_at <= nowIso) || (t.status === "running" && !!t.lease_expires_at && t.lease_expires_at <= nowIso))
    .sort((a, b) => a.next_at.localeCompare(b.next_at))[0];
  if (!due) return null;
  due.status = "running"; due.attempts += 1; due.lease_owner = owner; due.lease_expires_at = addMs(nowIso, TASK_LEASE_MS); due.updated_at = nowIso;
  return { ...due };
}

/** Settle a claimed task, only if this worker still holds it (compare-and-set on the lease). */
export function settleTaskIn(s: DevState, businessId: string, taskId: string, owner: string, r: { kind: "done" } | { kind: "later"; atIso: string } | { kind: "failed"; error: string } | { kind: "cancelled"; reason: string }, nowIso = new Date().toISOString()): TaskRecord | null {
  const t = tasksOf(s, businessId).find(x => x.id === taskId);
  if (!t || t.status !== "running" || t.lease_owner !== owner) return null;
  t.lease_owner = null; t.lease_expires_at = null; t.updated_at = nowIso;
  if (r.kind === "done") t.status = "done";
  else if (r.kind === "cancelled") { t.status = "cancelled"; t.last_error = r.reason; }
  else if (r.kind === "later") { t.status = "queued"; t.next_at = r.atIso; t.attempts = Math.max(0, t.attempts - 1); }   // waiting is not a failure
  else if (t.attempts >= t.max_attempts) { t.status = "dead"; t.last_error = r.error; }
  else { t.status = "queued"; t.last_error = r.error; t.next_at = addMs(nowIso, backoffMs(t.attempts)); }
  return { ...t };
}

/** Earliest time any queued task is due (null if none). */
export function nextDueIn(s: DevState, businessId: string): string | null {
  const q = tasksOf(s, businessId).filter(t => t.status === "queued").map(t => t.next_at).sort();
  return q[0] ?? null;
}

/** Keep every live task; keep only the most recent finished ones (bounded growth). */
function prune(list: TaskRecord[]) {
  const finished = list.filter(t => !isLive(t));
  if (finished.length <= KEEP_FINISHED) return;
  const drop = new Set(finished.sort((a, b) => a.updated_at.localeCompare(b.updated_at)).slice(0, finished.length - KEEP_FINISHED).map(t => t.id));
  for (let i = list.length - 1; i >= 0; i--) if (drop.has(list[i].id)) list.splice(i, 1);
}
