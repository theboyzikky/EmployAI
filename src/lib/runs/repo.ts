import "server-only";
// M4 · Run repository. Every write happens inside ONE serialised store transaction on the LATEST
// stored state (FileDevStore.transact), never on a stale copy (plan §5.6):
//  - status and control changes are compare-and-set: they apply only if the stored state is what the
//    caller expects, and report whether they applied;
//  - field ownership: `kill_switch` is written only by setKillSwitch; a run's `control` only by
//    setRunControl / clearRunControl (the runner may clear it only by compare-and-set);
//  - security decisions, ledger entries and activity events are APPEND-ONLY: this class has no method
//    that updates or deletes them (asserted by a test).
// SINGLE-PROCESS ONLY, like the store it wraps.
import { randomUUID } from "node:crypto";
import type { AgentKey } from "@/lib/catalogue/catalogue";
import { discoveryRepository, type AgentRecord, type AgentStatus, type BusinessRecord, type DevState, type WorkflowRecord } from "@/lib/discovery/store";
import type { ActivityEvent, Actor, ApprovalRecord, ApprovalStatus, LedgerRecord, RunControl, RunRecord, RunStatus, RunStepRecord, SecurityDecisionRecord } from "./types";

const copy = <T>(x: T): T => structuredClone(x);

export class RunTx {
  constructor(private readonly s: DevState, readonly now: string = new Date().toISOString()) {}

  // ---- reads (copies, so callers can't change stored records by accident) -------------------------
  business(id: string): BusinessRecord | null { const b = this.s.businesses[id]; return b ? copy(b) : null; }
  agents(businessId: string): AgentRecord[] { return copy(this.s.agents[businessId] ?? []); }
  workflows(businessId: string): WorkflowRecord[] { return copy((this.s.workflows ?? {})[businessId] ?? []); }
  runs(businessId: string): RunRecord[] { return copy((this.s.runs ?? {})[businessId] ?? []); }
  run(businessId: string, runId: string): RunRecord | null { const r = ((this.s.runs ?? {})[businessId] ?? []).find(x => x.id === runId); return r ? copy(r) : null; }
  steps(runId: string): RunStepRecord[] { return copy((this.s.run_steps ?? {})[runId] ?? []); }
  decisions(businessId: string): SecurityDecisionRecord[] { return copy((this.s.security_decisions ?? {})[businessId] ?? []); }
  approvals(businessId: string): ApprovalRecord[] { return copy((this.s.approval_requests ?? {})[businessId] ?? []); }
  ledger(businessId: string): LedgerRecord[] { return copy((this.s.ledger_entries ?? {})[businessId] ?? []); }
  events(businessId: string): ActivityEvent[] { return copy((this.s.activity_events ?? {})[businessId] ?? []); }

  // ---- business and agents ----------------------------------------------------------------------
  /** The only writer of `kill_switch`. Returns false when it was already in that state (idempotent). */
  setKillSwitch(businessId: string, active: boolean): boolean {
    const b = this.s.businesses[businessId];
    if (!b) throw new Error("NOT_FOUND");
    if ((b.kill_switch ?? false) === active) return false;
    b.kill_switch = active;
    b.kill_switch_changed_at = this.now;
    return true;
  }

  /** Compare-and-set on an agent's status (pause / resume of an approved agent). */
  setAgentStatus(businessId: string, key: AgentKey, expect: AgentStatus, status: AgentStatus): boolean {
    const a = (this.s.agents[businessId] ?? []).find(x => x.key === key);
    if (!a || a.status !== expect) return false;
    a.status = status;
    return true;
  }

  // ---- runs --------------------------------------------------------------------------------------
  insertRun(run: Omit<RunRecord, "id" | "version" | "updated_at">): RunRecord {
    const rec: RunRecord = { ...run, id: randomUUID(), version: 1, updated_at: this.now };
    ((this.s.runs ??= {})[run.business_id] ??= []).push(rec);
    return copy(rec);
  }

  /**
   * Compare-and-set patch of a run. Applies only if the stored run matches every expectation given.
   * `control`, `kill` (the business kill switch) and `status` are checked on the latest stored state.
   */
  patchRun(businessId: string, runId: string, patch: Partial<Omit<RunRecord, "id" | "business_id" | "control" | "control_at" | "version">>, expect: { status?: readonly RunStatus[]; control?: RunControl; killSwitchOff?: boolean } = {}): boolean {
    const r = ((this.s.runs ?? {})[businessId] ?? []).find(x => x.id === runId);
    if (!r) return false;
    if (expect.status && !expect.status.includes(r.status)) return false;
    if (expect.control !== undefined && r.control !== expect.control) return false;
    if (expect.killSwitchOff && this.s.businesses[businessId]?.kill_switch) return false;
    Object.assign(r, patch, { version: r.version + 1, updated_at: this.now });
    return true;
  }

  /** The only writer of a run's pause / stop request (endpoints). */
  setRunControl(businessId: string, runId: string, control: Exclude<RunControl, null>): boolean {
    const r = ((this.s.runs ?? {})[businessId] ?? []).find(x => x.id === runId);
    if (!r) return false;
    if (r.control === control) return false;
    r.control = control; r.control_at = this.now; r.version += 1; r.updated_at = this.now;
    return true;
  }

  /** Clear a control request: only if it is still the one the caller acted on (compare-and-set). */
  clearRunControl(businessId: string, runId: string, expected: Exclude<RunControl, null>): boolean {
    const r = ((this.s.runs ?? {})[businessId] ?? []).find(x => x.id === runId);
    if (!r || r.control !== expected) return false;
    r.control = null; r.control_at = this.now; r.version += 1; r.updated_at = this.now;
    return true;
  }

  // ---- steps -------------------------------------------------------------------------------------
  insertStep(step: Omit<RunStepRecord, "id" | "seq">): RunStepRecord {
    const list = ((this.s.run_steps ??= {})[step.run_id] ??= []);
    const rec: RunStepRecord = { ...step, id: randomUUID(), seq: list.length + 1 };
    list.push(rec);
    return copy(rec);
  }

  /** Compare-and-set patch of a step record (e.g. only a step still `running` can be completed). */
  patchStep(runId: string, stepRecordId: string, expectStatus: RunStepRecord["status"], patch: Partial<Omit<RunStepRecord, "id" | "run_id" | "business_id" | "seq" | "step_id">>): boolean {
    const st = ((this.s.run_steps ?? {})[runId] ?? []).find(x => x.id === stepRecordId);
    if (!st || st.status !== expectStatus) return false;
    Object.assign(st, patch);
    return true;
  }

  // ---- approvals (authorisations) ----------------------------------------------------------------
  insertApproval(a: Omit<ApprovalRecord, "id" | "created_at">): ApprovalRecord {
    const rec: ApprovalRecord = { ...a, id: randomUUID(), created_at: this.now };
    ((this.s.approval_requests ??= {})[a.business_id] ??= []).push(rec);
    return copy(rec);
  }

  /** Compare-and-set on an approval's status (decide, expire, invalidate). */
  patchApproval(businessId: string, approvalId: string, expect: readonly ApprovalStatus[], patch: Partial<Pick<ApprovalRecord, "status" | "decided_at" | "decided_by" | "invalidated_reason">>): boolean {
    const a = ((this.s.approval_requests ?? {})[businessId] ?? []).find(x => x.id === approvalId);
    if (!a || !expect.includes(a.status)) return false;
    Object.assign(a, patch);
    return true;
  }

  /**
   * Use an authorisation ONCE: only if it is `approved`, unexpired, not yet consumed, and its action hash
   * matches. Returns false otherwise (nothing is changed).
   */
  consumeApproval(businessId: string, approvalId: string, actionHash: string): boolean {
    const a = ((this.s.approval_requests ?? {})[businessId] ?? []).find(x => x.id === approvalId);
    if (!a || a.status !== "approved" || a.consumed_at || a.action_hash !== actionHash || a.expires_at <= this.now) return false;
    a.consumed_at = this.now;
    return true;
  }

  // ---- append-only collections ---------------------------------------------------------------------
  appendDecision(d: Omit<SecurityDecisionRecord, "id" | "created_at">): SecurityDecisionRecord {
    const rec: SecurityDecisionRecord = { ...d, id: randomUUID(), created_at: this.now };
    ((this.s.security_decisions ??= {})[d.business_id] ??= []).push(rec);
    return copy(rec);
  }

  appendLedger(l: Omit<LedgerRecord, "id" | "occurred_at">): LedgerRecord {
    const rec: LedgerRecord = { ...l, id: randomUUID(), occurred_at: this.now };
    ((this.s.ledger_entries ??= {})[l.business_id] ??= []).push(rec);
    return copy(rec);
  }

  appendEvent(businessId: string, actor: Actor, type: string, subject: string, status: string, correlationId: string, payload: Record<string, unknown> = {}): ActivityEvent {
    const rec: ActivityEvent = { id: randomUUID(), business_id: businessId, actor, type, subject, status, correlation_id: correlationId, payload, created_at: this.now };
    ((this.s.activity_events ??= {})[businessId] ??= []).push(rec);
    return copy(rec);
  }
}

/** One serialised, atomic read-modify-write on the latest stored state. `fn` must be synchronous. */
export function runTransact<T>(fn: (tx: RunTx) => T): Promise<T> {
  return discoveryRepository().transact(s => fn(new RunTx(s)));
}

/**
 * Read-only access for views and GET requests. It works on a private copy, so nothing done here is ever
 * written: GET can't execute steps or persist transitions (D11).
 */
export function runRead<T>(fn: (tx: RunTx) => T): Promise<T> {
  return discoveryRepository().readState(s => fn(new RunTx(s)));
}
