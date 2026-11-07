import "server-only";
// M4 · The test-run runner (plan §5). SINGLE-PROCESS ONLY, like the store and the lock it relies on.
//
// - startRun only checks eligibility and persists the run; it executes NO step.
// - advanceRun is the ONLY operation that executes steps: one bounded batch under the shared business
//   lock. Before each step it reads the latest stored state; each step is saved as `running` before it
//   executes, and its result, effects and the run's transition are committed in ONE atomic write that
//   re-checks the kill switch, the run's control request and its status (compare-and-set).
// - Approval decisions and controls never execute steps. Control requests (pause, stop, kill switch) are
//   persisted at once through the store write queue, without the business lock; only their
//   finalisation takes the lock (plan §5.6). The runner finalises them too when it notices first.
// - Nothing leaves the run: agents are pure handlers, tools are local or labelled simulations, and a
//   payment ends as a SIMULATED outcome only (C1–C4). No network, signer, contract or NEAR code.
import type { AgentKey } from "@/lib/catalogue/catalogue";
import { ServiceError } from "@/lib/discovery/service";
import type { AgentRecord } from "@/lib/discovery/store";
import { DEFAULT_LOCK_WAIT_MS, LockBusyError, withBusinessLock } from "@/lib/locks";
import { actionHash, expiresAt, isExpired } from "@/lib/security/authorisation";
import { evaluate, type GateContext, type GatePolicy } from "@/lib/security/gate";
import type { DemoScenario } from "@/lib/workflows/demo-data";
import type { Params, Step, WorkflowDoc } from "@/lib/workflows/schema";
import * as Agents from "./agents";
import { checkRunEligibility } from "./eligibility";
import { workflowFingerprint } from "./fingerprint";
import { runRead, runTransact, type RunTx } from "./repo";
import { SCENARIO_DEFS, chooseSupplier, reorderFor, scenarioSnapshot, stockAfterOrder } from "./scenarios";
import { BrokerRefusal, makeBroker, scopeAccess, type Work } from "./tools";
import { ACTIVE_RUN_STATUSES, type Actor, type RunRecord, type RunStatus, type RunStepRecord, type ScenarioKey } from "./types";

export const MAX_BATCH_STEPS = 5;
export const BATCH_BUDGET_MS = 1_500;
export const LEASE_MS = 15_000;
export const STEP_TIMEOUT_MS = 5_000;
export const RUN_MAX_STEPS = 25;
export const RUN_MAX_EXEC_MS = 60_000;

/** A transient failure (e.g. a step over its time limit): retried once, then the run fails. */
class TransientError extends Error {}

export type RunHooks = {
  /** Test seam: called after a step has executed and before its commit (used to inject races). */
  beforeCommit?: (stepId: string) => Promise<void> | void;
};

/** One clock for everything (leases, expiry, timestamps). */
const nowIso = (_h?: RunHooks) => new Date().toISOString();
const addMs = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString();

async function lockWait<T>(businessId: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await withBusinessLock(businessId, fn, { mode: "wait", timeoutMs: DEFAULT_LOCK_WAIT_MS });
  } catch (e) {
    if (e instanceof LockBusyError) throw new ServiceError("BUSY", 409, "Another action on this business is still in progress. Try again in a moment.");
    throw e;
  }
}

// ---------------------------------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------------------------------

const docOf = (tx: RunTx, run: RunRecord): WorkflowDoc | null => tx.workflows(run.business_id).find(w => w.id === run.workflow_id)?.steps ?? null;

function policyOf(doc: WorkflowDoc, snap: DemoScenario): GatePolicy {
  return { version: snap.policy?.version ?? "demo-policy", maxPaymentNgn: doc.params.max_payment_ngn, approvalThresholdNgn: doc.params.approval_threshold_ngn, dailyLimitNgn: snap.policy?.daily_limit_ngn ?? 0 };
}

const today = (iso: string) => iso.slice(0, 10);

function gateBase(tx: RunTx, businessId: string, doc: WorkflowDoc, snap: DemoScenario, nowIsoStr: string, excludeRequestId?: string): Omit<GateContext, "agent" | "stepTools"> {
  return {
    killSwitch: !!tx.business(businessId)?.kill_switch,
    policy: policyOf(doc, snap),
    // D7: only the fictional registry history counts as "paid before"; test-run outcomes never do.
    registry: snap.suppliers.map(s => ({ name: s.name, approved: s.approved, priorPayments: s.prior_payments ?? 0 })),
    blocklist: [],
    spentTodayNgn: tx.ledger(businessId).filter(l => today(l.occurred_at) === today(nowIsoStr)).reduce((t, l) => t + l.amount, 0),
    seenRequestIds: tx.decisions(businessId).map(d => (d.action as { request_id?: string }).request_id ?? "").filter(id => id && id !== excludeRequestId),
  };
}

const agentFor = (agents: AgentRecord[], key: string | null) => (key ? agents.find(a => a.key === key) ?? null : null);
const brokerAgent = (a: AgentRecord | null) => a ? { key: a.key, status: a.status, allowedTools: a.definition.allowed_tools, readScopes: a.definition.read_scopes, writeScopes: a.definition.write_scopes } : null;

/** The agents a step involves (for pause checks): its own agent, plus the Orchestrator when it delegates. */
function involvedAgents(step: Step, doc: WorkflowDoc): string[] {
  const own = step.type === "agent_task" || step.type === "payment" ? step.agent : step.type === "notify" ? step.agent : null;
  const out: string[] = [];
  if (own) out.push(own);
  if (doc.coordinator === "orchestrator" && step.type === "agent_task" && own !== "orchestrator") out.push("orchestrator");
  return out;
}

/** Expected result for FR-10 "expected vs actual": a pure prediction from the scenario and settings. */
export function expectedFor(doc: WorkflowDoc, scenario: ScenarioKey, spentTodayNgn: number): RunRecord["expected"] {
  const snap = scenarioSnapshot(scenario);
  const has = (id: string) => doc.steps.some(s => s.id === id);
  const stock = has("order_check") ? stockAfterOrder(snap, SCENARIO_DEFS[scenario].order) : snap.inventory;
  const flags = doc.steps.some(s => s.id === "stock_update" && s.type === "agent_task" && s.task === "detect_low");
  const reorder = flags ? reorderFor(stock) : null;
  if (!has("reorder_needed")) return { decision: null, end: "completed" };
  if (!reorder) return { decision: null, end: "no_reorder" };
  if (!has("supplier_choice")) return { decision: null, end: "completed" };
  if (!has("payment")) return { decision: null, end: "manual_order" };
  const { chosen } = chooseSupplier(snap, reorder.item);
  if (!chosen) return { decision: null, end: "failed" };
  const r = evaluate({ kind: "payment_request", agentKey: "finance", tool: "request_payment", stepId: "payment", requestId: "expected", beneficiary: chosen.name, amountNgn: chosen.price_per_unit_ngn * reorder.quantity, channel: { kind: "treasury_contract", method: "request_payment" }, provenance: "system" },
    { killSwitch: false, agent: { status: "approved", allowedTools: ["request_payment"] }, stepTools: ["request_payment"], policy: policyOf(doc, snap), registry: snap.suppliers.map(s => ({ name: s.name, approved: s.approved, priorPayments: s.prior_payments ?? 0 })), blocklist: [], spentTodayNgn, seenRequestIds: [] });
  return { decision: r.decision, end: r.decision === "ALLOW" ? "completed" : r.decision === "WARN" ? "approval" : "blocked" };
}

// ---------------------------------------------------------------------------------------------------
// Start (creates and persists; executes nothing)
// ---------------------------------------------------------------------------------------------------

export async function startRun(businessId: string, input: { workflowId: string; scenario: ScenarioKey; idempotencyKey: string }, hooks?: RunHooks): Promise<{ runId: string; created: boolean }> {
  return lockWait(businessId, async () => {
    const out = await runTransact(tx => {
      const existing = tx.runs(businessId).find(r => r.idempotency_key === input.idempotencyKey);
      if (existing) return { runId: existing.id, created: false };     // AT-07: a repeated start returns the same run
      const business = tx.business(businessId);
      if (!business) return { refusal: { code: "NOT_FOUND", status: 404, message: "Not found." } };
      const elig = checkRunEligibility({ business, agents: tx.agents(businessId), workflows: tx.workflows(businessId), runs: tx.runs(businessId), workflowId: input.workflowId });
      if (!("ok" in elig)) return { refusal: elig };
      const now = nowIso(hooks);
      const doc = elig.workflow.steps;
      const snap = scenarioSnapshot(input.scenario);
      const spent = tx.ledger(businessId).filter(l => today(l.occurred_at) === today(now)).reduce((t, l) => t + l.amount, 0);
      const trigger = doc.steps.find(s => s.type === "trigger");
      const run = tx.insertRun({
        business_id: businessId, workflow_id: elig.workflow.id, workflow_version: elig.workflow.version, approval_fingerprint: elig.fingerprint,
        mode: "test_run", scenario: input.scenario, status: "running",
        trigger: { source: trigger?.type === "trigger" ? trigger.source : "demo_order", requested_by: "owner" }, idempotency_key: input.idempotencyKey,
        demo_snapshot: snap, records: { orders: [], handoffs: [] }, cursor: doc.start, steps_done: 0, exec_ms: 0, lease_expires_at: null,
        control: null, control_at: null, pause_reason: null, started_at: now, ended_at: null, elapsed_ms: null, summary: null,
        expected: expectedFor(doc, input.scenario, spent), end_reason: null, error: null,
      });
      tx.appendEvent(businessId, "owner", "run.started", `run:${run.id}`, "running", run.id, { workflow_version: elig.workflow.version, scenario: input.scenario, mode: "test_run" });
      return { runId: run.id, created: true };
    });
    if ("refusal" in out && out.refusal) throw new ServiceError(out.refusal.code, out.refusal.status, out.refusal.message);
    return out as { runId: string; created: boolean };
  });
}

// ---------------------------------------------------------------------------------------------------
// Transitions applied by the runner (all compare-and-set, all with audit events)
// ---------------------------------------------------------------------------------------------------

function invalidateRunApprovals(tx: RunTx, businessId: string, runId: string, reason: string, actor: Actor) {
  for (const a of tx.approvals(businessId).filter(x => x.run_id === runId && (x.status === "pending" || (x.status === "approved" && !x.consumed_at)))) {
    if (tx.patchApproval(businessId, a.id, ["pending", "approved"], { status: "invalidated", invalidated_reason: reason, decided_at: tx.now, decided_by: "system" })) {
      tx.appendEvent(businessId, actor, "approval.invalidated", `approval:${a.id}`, "invalidated", runId, { reason });
    }
  }
}

function endRun(tx: RunTx, run: RunRecord, status: RunStatus, endReason: string, actor: Actor, extra: Partial<RunRecord> = {}, expectStatus: readonly RunStatus[] = ACTIVE_RUN_STATUSES): boolean {
  const ok = tx.patchRun(run.business_id, run.id, { status, end_reason: endReason, ended_at: tx.now, elapsed_ms: Date.parse(tx.now) - Date.parse(run.started_at), lease_expires_at: null, cursor: null, ...extra }, { status: expectStatus });
  if (ok) {
    if (status === "cancelled" || status === "failed" || status === "blocked") invalidateRunApprovals(tx, run.business_id, run.id, endReason, actor);
    tx.appendEvent(run.business_id, actor, `run.${status}`, `run:${run.id}`, status, run.id, { reason: endReason });
  }
  return ok;
}

/** Finish a cancellation requested by the kill switch or a stop (idempotent). */
function finaliseCancel(tx: RunTx, run: RunRecord, reason: "KILL_SWITCH_ACTIVE" | "STOPPED_BY_OWNER", actor: Actor) {
  for (const st of tx.steps(run.id).filter(s => s.status === "running" || s.status === "waiting")) {
    tx.patchStep(run.id, st.id, st.status, { status: "cancelled", ended_at: tx.now, error: { code: reason, message: "Cancelled." } });
  }
  if (endRun(tx, run, "cancelled", reason, actor)) {
    if (run.control === "stop") tx.clearRunControl(run.business_id, run.id, "stop");
  }
}

function markInterrupted(tx: RunTx, run: RunRecord) {
  for (const st of tx.steps(run.id).filter(s => s.status === "running")) {
    tx.patchStep(run.id, st.id, "running", { status: "interrupted", ended_at: tx.now, error: { code: "INTERRUPTED", message: "The step was cut off before it finished." } });
  }
  if (tx.patchRun(run.business_id, run.id, { status: "interrupted", lease_expires_at: null }, { status: ["running"] })) {
    tx.appendEvent(run.business_id, "system", "run.interrupted", `run:${run.id}`, "interrupted", run.id, {});
  }
}

const leaseExpired = (run: RunRecord, now: string) => !run.lease_expires_at || run.lease_expires_at <= now;

// ---------------------------------------------------------------------------------------------------
// Advance: one bounded batch (the only operation that executes steps)
// ---------------------------------------------------------------------------------------------------

export type AdvanceResult = { advanced: number; more: boolean; settling: boolean };

export async function advanceRun(businessId: string, runId: string, hooks?: RunHooks): Promise<AdvanceResult> {
  return lockWait(businessId, async () => {
    const started = Date.now();
    let advanced = 0;
    const first = await runRead(tx => ({ run: tx.run(businessId, runId), steps: tx.steps(runId) }));
    if (!first.run) throw new ServiceError("NOT_FOUND", 404, "That run doesn't exist.");
    if (first.run.status === "waiting_approval") {
      // Persist an approval that expired while waiting (GET only shows it): the run then takes the
      // workflow's "rejected" route on this same advance.
      const expired = await runTransact(tx => {
        const a = tx.approvals(businessId).find(x => x.run_id === runId && x.status === "pending");
        if (!a || !isExpired(a.expires_at, tx.now)) return false;
        tx.patchApproval(businessId, a.id, ["pending"], { status: "expired", decided_at: tx.now, decided_by: "system" });
        tx.appendEvent(businessId, "system", "approval.expired", `approval:${a.id}`, "expired", runId, {});
        return tx.patchRun(businessId, runId, { status: "running" }, { status: ["waiting_approval"], control: null });
      });
      if (!expired) return { advanced: 0, more: false, settling: false };
      first.run.status = "running";
    }
    if (first.run.status !== "running") return { advanced: 0, more: false, settling: false };
    if (first.steps.some(s => s.status === "running")) {
      // A step was saved as running by a batch that never finished (the server stopped mid-step).
      if (!leaseExpired(first.run, nowIso(hooks))) return { advanced: 0, more: false, settling: true };
      await runTransact(tx => { const r = tx.run(businessId, runId); if (r) markInterrupted(tx, r); });
      return { advanced: 0, more: false, settling: false };
    }
    if (!(await runTransact(tx => tx.patchRun(businessId, runId, { lease_expires_at: addMs(nowIso(hooks), LEASE_MS) }, { status: ["running"] })))) {
      return { advanced: 0, more: false, settling: false };
    }
    try {
      while (advanced < MAX_BATCH_STEPS && Date.now() - started < BATCH_BUDGET_MS) {
        const r = await runOneStep(businessId, runId, hooks);
        if (r === "executed") { advanced++; continue; }
        if (r === "retry") continue;
        break;   // "stopped": waiting, paused, ended, or a control request was honoured
      }
    } finally {
      // Release the lease whatever happened (a real crash never reaches here: that is what the lease detects).
      await runTransact(tx => tx.patchRun(businessId, runId, { lease_expires_at: null }));
    }
    const after = await runRead(tx => tx.run(businessId, runId));
    return { advanced, more: !!after && after.status === "running" && after.cursor !== null, settling: false };
  });
}

type StepOutcome = "executed" | "retry" | "stopped";

async function runOneStep(businessId: string, runId: string, hooks?: RunHooks): Promise<StepOutcome> {
  // 1 · Fresh read: every write queued before this read is visible (kill switch, pause, stop).
  const pre = await runTransact(tx => {
    const run = tx.run(businessId, runId);
    if (!run || run.status !== "running") return { stop: true as const };
    const business = tx.business(businessId)!;
    if (business.kill_switch) { finaliseCancel(tx, run, "KILL_SWITCH_ACTIVE", "system"); return { stop: true as const }; }
    if (run.control === "stop") { finaliseCancel(tx, run, "STOPPED_BY_OWNER", "system"); return { stop: true as const }; }
    if (run.control === "pause") {
      if (tx.patchRun(businessId, runId, { status: "paused", pause_reason: "owner" }, { status: ["running"], control: "pause" })) {
        tx.clearRunControl(businessId, runId, "pause");
        tx.appendEvent(businessId, "system", "run.paused", `run:${runId}`, "paused", runId, { reason: "owner" });
      }
      return { stop: true as const };
    }
    const wf = tx.workflows(businessId).find(w => w.id === run.workflow_id);
    if (!wf || wf.status !== "approved" || workflowFingerprint(wf) !== run.approval_fingerprint) {
      endRun(tx, run, "failed", "WORKFLOW_CHANGED", "system", { error: { code: "WORKFLOW_CHANGED", message: "The approved workflow changed after this run started." } });
      return { stop: true as const };
    }
    if (run.steps_done >= RUN_MAX_STEPS || run.exec_ms >= RUN_MAX_EXEC_MS) {
      endRun(tx, run, "failed", "RUN_LIMIT", "system", { error: { code: "RUN_LIMIT", message: "The run reached its step or time limit." } });
      return { stop: true as const };
    }
    const doc = wf.steps;
    const step = doc.steps.find(s => s.id === run.cursor);
    if (!step) { endRun(tx, run, "failed", "BAD_CURSOR", "system", { error: { code: "BAD_CURSOR", message: "The run lost its place in the workflow." } }); return { stop: true as const }; }
    const agents = tx.agents(businessId);
    const paused = involvedAgents(step, doc).find(k => agentFor(agents, k)?.status === "paused");
    if (paused) {
      if (tx.patchRun(businessId, runId, { status: "paused", pause_reason: `agent_paused:${paused}` }, { status: ["running"], control: null })) {
        tx.appendEvent(businessId, "system", "run.paused", `run:${runId}`, "paused", runId, { reason: `agent_paused:${paused}` });
      }
      return { stop: true as const };
    }
    // 2 · Save the step as running BEFORE executing it (or reuse a waiting approval step's record).
    const prior = tx.steps(runId).filter(s => s.step_id === step.id);
    const waiting = prior.find(s => s.status === "waiting");
    const attempt = prior.filter(s => s.status === "failed" || s.status === "interrupted").length + 1;
    const requester = doc.coordinator === "orchestrator" && agentFor(agents, "orchestrator") ? "orchestrator" : "runner";
    const ownAgent = step.type === "agent_task" || step.type === "payment" ? step.agent : step.type === "notify" ? step.agent : null;
    const rec: RunStepRecord = waiting ?? tx.insertStep({
      run_id: runId, business_id: businessId, step_id: step.id, step_type: step.type, agent_key: ownAgent ?? "system", requester,
      task_id: step.type === "agent_task" ? step.task : step.type === "notify" ? step.task : null, status: "running", attempt,
      input: null, output: null, reasoning: null, tools_used: [], reads: [], writes: [], simulated: [], started_at: tx.now, ended_at: null, duration_ms: null, error: null,
    });
    if (!waiting) tx.appendEvent(businessId, ownAgent ? `agent:${ownAgent}` : "system", "run.step.started", `step:${step.id}`, "running", runId, { attempt });
    return { stop: false as const, run, doc, step, rec, agents };
  });
  if (pre.stop) return "stopped";
  const { run, doc, step, rec, agents } = pre;

  // 3 · Execute agent work on a COPY of the run data (pure; nothing is saved until the commit).
  const work: Work = { snapshot: structuredClone(run.demo_snapshot as Record<string, unknown>), records: structuredClone(run.records) };
  const t0 = Date.now();
  let exec: { output: unknown; reasoning: string | null; toolsUsed: string[]; reads: string[]; writes: string[]; simulated: string[]; error: { code: string; message: string } | null; transient: boolean } =
    { output: null, reasoning: null, toolsUsed: [], reads: [], writes: [], simulated: [], error: null, transient: false };
  if (needsAgentHandler(step)) {
    const snapNow = await runRead(tx => gateBase(tx, businessId, doc, run.demo_snapshot as DemoScenario, nowIso(hooks)));
    try {
      exec = executeAgentStep(step, doc, run, agents, work, snapNow);
      if (Date.now() - t0 > STEP_TIMEOUT_MS) throw new TransientError("STEP_TIMEOUT");
    } catch (e) {
      const code = e instanceof BrokerRefusal ? e.reason : e instanceof TransientError ? "STEP_TIMEOUT" : e instanceof Error ? e.message : "STEP_FAILED";
      exec = { ...exec, output: null, reasoning: null, error: { code, message: e instanceof BrokerRefusal ? `Refused: ${e.what}.` : "The step couldn't complete." }, transient: e instanceof TransientError };
    }
  }
  const durationMs = Date.now() - t0;
  await hooks?.beforeCommit?.(step.id);

  // 4 · Commit in ONE atomic write, re-checking the kill switch, the control request and the status.
  return runTransact(tx => commitStep(tx, { businessId, runId, step, doc, rec, exec, work, durationMs, nowIsoStr: nowIso(hooks) }));
}

const needsAgentHandler = (s: Step) => s.type === "agent_task" || (s.type === "notify") || s.type === "payment";

function executeAgentStep(step: Step, doc: WorkflowDoc, run: RunRecord, agents: AgentRecord[], work: Work, gate: Omit<GateContext, "agent" | "stepTools">) {
  const toolsUsed: string[] = [], reads: string[] = [], writes: string[] = [], simulated: string[] = [];
  const budget = { max_payment_ngn: doc.params.max_payment_ngn, approval_threshold_ngn: doc.params.approval_threshold_ngn, daily_limit_ngn: (run.demo_snapshot as DemoScenario).policy?.daily_limit_ngn ?? 0 };
  const scopes = scopeAccess(work, { budget });
  const collect = (b: ReturnType<typeof makeBroker>) => { for (const [to, from] of [[toolsUsed, b.toolsUsed], [reads, b.reads], [writes, b.writes], [simulated, b.simulated]] as const) for (const x of from) if (!to.includes(x)) to.push(x); };
  const brokerFor = (key: string | null, tools: readonly string[], r: readonly string[], w: readonly string[]) => makeBroker({ agent: brokerAgent(agentFor(agents, key)), step: { id: step.id, tools, reads: r, writes: w }, gate, scopes });
  const input = { runId: run.id, params: doc.params };

  // The Orchestrator delegates each specialist task (its delegate_task call is gated like any other).
  if (step.type === "agent_task" && doc.coordinator === "orchestrator" && step.agent !== "orchestrator" && agentFor(agents, "orchestrator")) {
    const ob = brokerFor("orchestrator", ["delegate_task"], [], []);
    ob.use("delegate_task");
    collect(ob);
  }

  let res: Agents.HandlerResult;
  if (step.type === "agent_task") {
    const b = brokerFor(step.agent, step.tools, step.reads, step.writes);
    switch (step.id) {
      case "order_check": res = Agents.orderCheck({ ...input, broker: b }); break;
      case "stock_update": res = Agents.stockUpdate({ ...input, broker: b }, step.task === "detect_low"); break;
      case "supplier_choice": res = Agents.supplierChoice({ ...input, broker: b }); break;
      case "payment_prepare": res = Agents.paymentPrepare({ ...input, broker: b }); break;
      default: throw new Error("UNSUPPORTED_STEP");
    }
    collect(b);
  } else if (step.type === "notify" && step.audience === "customer") {
    // Notify steps declare no tools or scopes in the schema; their fixed contract is stated here.
    const b = brokerFor(step.agent, ["send_order_confirmation"], ["orders"], []);
    res = Agents.confirmToCustomer({ ...input, broker: b });
    collect(b);
  } else if (step.type === "notify" && step.agent === "orchestrator") {
    const b = brokerFor("orchestrator", ["notify_owner"], ["agent_results"], ["run_log"]);
    res = Agents.ownerSummary({ ...input, broker: b }, summaryText(work));
    collect(b);
  } else if (step.type === "notify") {
    // No Orchestrator on the team: the runner writes the summary itself (attributed to "EmployAI runner").
    res = { output: { summary: summaryText(work), sent: false }, reasoning: "Summary shown in EmployAI (no message sent)." };
    simulated.push("Shown in EmployAI (no message sent)");
  } else if (step.type === "payment") {
    // Finance's request_payment tool call is gated (rules 1–3) here; the payment itself is decided at commit.
    const b = brokerFor("finance", ["request_payment"], [], []);
    b.use("request_payment");
    collect(b);
    res = { output: {}, reasoning: "" };
  } else {
    throw new Error("UNSUPPORTED_STEP");
  }
  return { output: res.output, reasoning: res.reasoning, toolsUsed, reads, writes, simulated, error: null, transient: false };
}

function summaryText(work: Work): string {
  const rec = work.records as Record<string, unknown>;
  const orders = (rec.orders ?? []) as Array<{ total_ngn?: number; status: string }>;
  const reorder = rec.reorder as { item: string; quantity: number; unit: string } | null | undefined;
  const proposal = ((rec.purchase_proposals ?? []) as Array<{ supplier: string; total_ngn: number }>)[0];
  const paid = rec.payment_outcome as { amount: number; counterparty: string } | undefined;
  const parts: string[] = [];
  const o = orders.at(-1);
  if (o) parts.push(o.status === "confirmed" ? `Demo order confirmed (₦${(o.total_ngn ?? 0).toLocaleString("en-NG")}).` : "The demo order was rejected.");
  parts.push(reorder ? `${reorder.item} needed a reorder of ${reorder.quantity} ${reorder.unit}.` : "No reorder was needed.");
  if (proposal) parts.push(`${proposal.supplier} was recommended (₦${proposal.total_ngn.toLocaleString("en-NG")}).`);
  if (paid) parts.push(`Simulated payment recorded for ${paid.counterparty}: test run, no transaction.`);
  return parts.join(" ");
}

// ---------------------------------------------------------------------------------------------------
// The commit (synchronous, inside one store transaction)
// ---------------------------------------------------------------------------------------------------

type CommitArgs = {
  businessId: string; runId: string; step: Step; doc: WorkflowDoc; rec: RunStepRecord;
  exec: { output: unknown; reasoning: string | null; toolsUsed: string[]; reads: string[]; writes: string[]; simulated: string[]; error: { code: string; message: string } | null; transient: boolean };
  work: Work; durationMs: number; nowIsoStr: string;
};

function commitStep(tx: RunTx, a: CommitArgs): StepOutcome {
  const { businessId, runId, step, doc, rec, exec, work, durationMs } = a;
  const run = tx.run(businessId, runId);
  if (!run || run.status !== "running") return "stopped";
  // Signals that arrived while the step executed (§5.6): a kill switch or stop refuses the commit and the
  // step's local effects are discarded; a pause lets this step commit, then pauses before the next.
  if (tx.business(businessId)?.kill_switch) { finaliseCancel(tx, run, "KILL_SWITCH_ACTIVE", "system"); return "stopped"; }
  if (run.control === "stop") { finaliseCancel(tx, run, "STOPPED_BY_OWNER", "system"); return "stopped"; }

  const snap = work.snapshot as unknown as DemoScenario;
  const rec2 = work.records as Record<string, unknown>;
  const agentActor: Actor = rec.agent_key && rec.agent_key !== "system" ? `agent:${rec.agent_key}` : "system";
  const finishStep = (status: RunStepRecord["status"], patch: Partial<RunStepRecord> = {}) => tx.patchStep(runId, rec.id, rec.status, {
    status, output: exec.output, reasoning: exec.reasoning, tools_used: exec.toolsUsed, reads: exec.reads, writes: exec.writes, simulated: exec.simulated,
    ended_at: tx.now, duration_ms: durationMs, ...patch,
  });
  const advance = (outcome: string, extra: Partial<RunRecord> = {}) => {
    const next = step.next[outcome] ?? null;
    return tx.patchRun(businessId, runId, {
      demo_snapshot: work.snapshot, records: work.records, cursor: next, steps_done: run.steps_done + 1, exec_ms: run.exec_ms + durationMs, ...extra,
    }, { status: ["running"], control: run.control });
  };

  // Agent step failures (gate or scope refusals never retry; a transient error retries once).
  if (exec.error) {
    finishStep("failed", { error: exec.error, output: null });
    tx.appendEvent(businessId, agentActor, "run.step.failed", `step:${step.id}`, "failed", runId, { code: exec.error.code, attempt: rec.attempt });
    if (exec.transient && rec.attempt < 2) return "retry";
    endRun(tx, run, "failed", exec.error.code, "system", { error: exec.error, records: work.records }, ["running"]);
    return "stopped";
  }

  switch (step.type) {
    case "trigger": {
      const order = SCENARIO_DEFS[run.scenario].order;
      if (step.source === "demo_order") rec2.orders = [{ id: `${runId}:order`, items: structuredClone(order.items), status: "received" }];
      exec.output = step.source === "demo_order" ? { order: order.items } : { stock_check: true };
      exec.reasoning = step.source === "demo_order" ? `Demo order received: ${order.items.map(l => `${l.qty} × ${l.item}`).join(", ")}. Not a real order.` : "Demo stock check started.";
      exec.simulated = ["Demo order (not a real customer)"];
      finishStep("succeeded");
      advance("next");
      break;
    }
    case "condition": {
      const yes = !!rec2.reorder;
      exec.output = { reorder_needed: yes };
      exec.reasoning = yes ? "Something is below its reorder point." : "Everything is above its reorder point.";
      finishStep("succeeded");
      advance(yes ? "yes" : "no");
      break;
    }
    case "security_check": {
      const req = ((rec2.payment_requests ?? []) as Array<{ request_id: string; beneficiary: string; amount_ngn: number; channel: { kind: string; method: string } }>)[0];
      if (!req) { finishStep("failed", { error: { code: "NO_PAYMENT_REQUEST", message: "There's no payment request to check." } }); endRun(tx, run, "failed", "NO_PAYMENT_REQUEST", "system", {}, ["running"]); return "stopped"; }
      const finance = agentFor(tx.agents(businessId), "finance");
      const result = evaluate(
        { kind: "payment_request", agentKey: "finance", tool: "request_payment", stepId: "payment", requestId: req.request_id, beneficiary: req.beneficiary, amountNgn: req.amount_ngn, channel: req.channel, provenance: "system" },
        { ...gateBase(tx, businessId, doc, snap, a.nowIsoStr), agent: finance ? { status: finance.status, allowedTools: finance.definition.allowed_tools } : null, stepTools: ["request_payment"] },
      );
      const hash = actionHash({ businessId, runId, requestId: req.request_id, beneficiary: req.beneficiary, amountNgn: req.amount_ngn, method: "request_payment" });
      const d = tx.appendDecision({
        business_id: businessId, run_id: runId, step_id: step.id, agent_key: "finance",
        action: { request_id: req.request_id, beneficiary: req.beneficiary, amount_ngn: req.amount_ngn, channel: req.channel, tool: "request_payment" },
        action_hash: hash, decision: result.decision, reason_codes: result.reasons, signals: result.signals, policy_version: result.policyVersion, provenance: { source: "system" }, mode: "test_run",
      });
      rec2.security_decision_id = d.id;
      tx.appendEvent(businessId, "system", "security.decision", `decision:${d.id}`, result.decision, runId, { reasons: result.reasons, mode: "test_run" });
      exec.output = { decision: result.decision, reasons: result.reasons };
      exec.reasoning = `Security check: ${result.decision}${result.reasons.length ? ` (${result.reasons.join(", ")})` : ""}. Test-run decision on demo data; on-chain checks run from the next stage.`;
      rec.agent_key = "system";
      finishStep("succeeded", { agent_key: "system" });
      advance(result.decision.toLowerCase());
      break;
    }
    case "approval": return commitApproval(tx, a, run, finishStep, advance);
    case "payment": return commitPayment(tx, a, run, finishStep, advance);
    case "end": {
      exec.output = { result: step.result };
      exec.reasoning = step.title;
      finishStep("succeeded");
      const status: RunStatus = step.result === "blocked" ? "blocked" : step.result === "rejected" ? "rejected" : "completed";
      advance("__end");
      const latest = tx.run(businessId, runId)!;
      endRun(tx, latest, status, step.result, "system", { summary: latest.summary ?? summaryText(work) }, ["running"]);
      break;
    }
    default: {
      // agent_task and notify: the handler already ran on the copy; commit its result and effects.
      finishStep("succeeded", { simulated: exec.simulated });
      if ((step.type === "agent_task" || step.type === "notify") && rec.requester !== rec.agent_key) {
        const handoffs = (rec2.handoffs ?? []) as unknown[];
        handoffs.push({ step_id: step.id, requester: rec.requester, assignee: rec.agent_key, task: rec.task_id, status: "succeeded" });
        rec2.handoffs = handoffs;
        tx.appendEvent(businessId, rec.requester === "orchestrator" ? "agent:orchestrator" : "system", "handoff", `step:${step.id}`, "succeeded", runId, { assignee: rec.agent_key, task: rec.task_id });
      }
      const summary = step.type === "notify" && step.audience === "owner" ? ((exec.output as { summary?: string })?.summary ?? null) : undefined;
      advance("next", summary !== undefined ? { summary } : {});
      tx.appendEvent(businessId, agentActor, "run.step.succeeded", `step:${step.id}`, "succeeded", runId, { tools: exec.toolsUsed, simulated: exec.simulated });
    }
  }
  return "executed";
}

type Finish = (status: RunStepRecord["status"], patch?: Partial<RunStepRecord>) => boolean;
type Advance = (outcome: string, extra?: Partial<RunRecord>) => boolean;

/** The approval step: authorise automatically (ALLOW), wait for the owner (WARN), or take the owner's decision. */
function commitApproval(tx: RunTx, a: CommitArgs, run: RunRecord, finishStep: Finish, advance: Advance): StepOutcome {
  const { businessId, runId, work, exec } = a;
  const rec2 = work.records as Record<string, unknown>;
  const decisionId = rec2.security_decision_id as string | undefined;
  const decision = tx.decisions(businessId).find(d => d.id === decisionId);
  const req = ((rec2.payment_requests ?? []) as Array<{ request_id: string; beneficiary: string; amount_ngn: number }>)[0];
  if (!decision || !req) { finishStep("failed", { error: { code: "NO_DECISION", message: "No security decision to act on." } }); endRun(tx, run, "failed", "NO_DECISION", "system", {}, ["running"]); return "stopped"; }
  let approval = tx.approvals(businessId).find(x => x.run_id === runId && x.decision_id === decision.id);
  if (!approval) {
    if (decision.decision === "BLOCK") { exec.output = { approved: false }; exec.reasoning = "Blocked by the security check."; finishStep("succeeded"); advance("rejected"); return "executed"; }
    const auto = decision.decision === "ALLOW";
    approval = tx.insertApproval({
      business_id: businessId, run_id: runId, decision_id: decision.id, request_id: req.request_id, action_hash: decision.action_hash,
      amount_ngn: req.amount_ngn, beneficiary: req.beneficiary, reason_codes: decision.reason_codes, status: auto ? "approved" : "pending", auto_approved: auto,
      expires_at: expiresAt(tx.now), decided_at: auto ? tx.now : null, decided_by: auto ? "system" : null, consumed_at: null, invalidated_reason: null,
    });
    tx.appendEvent(businessId, "system", auto ? "approval.approved" : "approval.requested", `approval:${approval.id}`, approval.status, runId, { auto_approved: auto, reasons: decision.reason_codes });
    if (!auto) {
      exec.output = { approval_id: approval.id, waiting: true };
      exec.reasoning = `Waiting for your approval: ${decision.reason_codes.join(", ")}.`;
      finishStep("waiting", { ended_at: null, duration_ms: null });
      tx.patchRun(businessId, runId, { status: "waiting_approval", records: work.records, demo_snapshot: work.snapshot, exec_ms: run.exec_ms + a.durationMs }, { status: ["running"], control: run.control });
      tx.appendEvent(businessId, "agent:orchestrator", "approval.escalated", `approval:${approval.id}`, "pending", runId, {});
      return "stopped";
    }
  } else if (approval.status === "pending" && isExpired(approval.expires_at, tx.now)) {
    tx.patchApproval(businessId, approval.id, ["pending"], { status: "expired", decided_at: tx.now, decided_by: "system" });
    tx.appendEvent(businessId, "system", "approval.expired", `approval:${approval.id}`, "expired", runId, {});
    approval = { ...approval, status: "expired" };
  } else if (approval.status === "pending") {
    tx.patchRun(businessId, runId, { status: "waiting_approval" }, { status: ["running"] });
    return "stopped";
  }
  if (approval.status === "invalidated") { finaliseCancel(tx, run, "KILL_SWITCH_ACTIVE", "system"); return "stopped"; }
  const ok = approval.status === "approved";
  exec.output = { approval_id: approval.id, approved: ok, auto_approved: approval.auto_approved, status: approval.status };
  exec.reasoning = ok ? (approval.auto_approved ? "Authorised automatically: ALLOW at or below your approval threshold." : "Approved by you.") : approval.status === "expired" ? "Your approval expired, so nothing is paid." : "You declined the payment.";
  finishStep("succeeded");
  advance(ok ? "approved" : "rejected");
  return "executed";
}

/**
 * The payment step: SIMULATED outcome only (C3, C4). Reconciled by request_id (never repeated); otherwise
 * re-checks the hard rules and uses the authorisation ONCE with a matching action hash, then records one
 * owner-only test-run ledger row (tx_hash null). All in this single atomic write.
 */
function commitPayment(tx: RunTx, a: CommitArgs, run: RunRecord, finishStep: Finish, advance: Advance): StepOutcome {
  const { businessId, runId, work, exec, doc } = a;
  const snap = work.snapshot as unknown as DemoScenario;
  const rec2 = work.records as Record<string, unknown>;
  const req = ((rec2.payment_requests ?? []) as Array<{ request_id: string; beneficiary: string; amount_ngn: number; channel: { kind: string; method: string } }>)[0];
  const fail = (code: string, message: string, status: RunStatus) => {
    finishStep("failed", { error: { code, message } });
    tx.appendEvent(businessId, "agent:finance", "payment.refused", `run:${runId}`, "refused", runId, { code });
    endRun(tx, run, status, code, "system", { error: { code, message }, records: work.records }, ["running"]);
    return "stopped" as const;
  };
  if (!req) return fail("NO_PAYMENT_REQUEST", "There's no payment request.", "failed");
  // Reconciliation: an outcome for this request already exists → reuse it, never produce a second one.
  const existing = tx.ledger(businessId).find(l => l.request_id === req.request_id);
  if (existing) {
    rec2.payment_outcome = { amount: existing.amount, counterparty: existing.counterparty, ledger_id: existing.id };
    exec.output = { reconciled: true, ledger_id: existing.id };
    exec.reasoning = "This payment's simulated outcome was already recorded; it was reconciled, not repeated.";
    finishStep("succeeded");
    advance("next");
    return "executed";
  }
  // Re-check the hard rules at the moment of payment (the duplicate rule ignores this request's own decision).
  const finance = agentFor(tx.agents(businessId), "finance");
  const recheck = evaluate(
    { kind: "payment_request", agentKey: "finance", tool: "request_payment", stepId: "payment", requestId: req.request_id, beneficiary: req.beneficiary, amountNgn: req.amount_ngn, channel: req.channel, provenance: "system" },
    { ...gateBase(tx, businessId, doc, snap, a.nowIsoStr, req.request_id), agent: finance ? { status: finance.status, allowedTools: finance.definition.allowed_tools } : null, stepTools: ["request_payment"] },
  );
  if (recheck.decision === "BLOCK") return fail(recheck.reasons[0] ?? "BLOCKED", "The payment no longer passes the security rules.", "blocked");
  const hash = actionHash({ businessId, runId, requestId: req.request_id, beneficiary: req.beneficiary, amountNgn: req.amount_ngn, method: "request_payment" });
  const approval = tx.approvals(businessId).find(x => x.run_id === runId && x.request_id === req.request_id && x.status === "approved" && !x.consumed_at);
  if (!approval || !tx.consumeApproval(businessId, approval.id, hash)) return fail("PAYMENT_NOT_AUTHORISED", "No valid, unused authorisation matches this payment.", "failed");
  const ledger = tx.appendLedger({
    business_id: businessId, run_id: runId, type: "supplier_payout", mode: "test_run", amount: req.amount_ngn, unit: "ngn_illustrative",
    counterparty: req.beneficiary, agent_key: "finance", tx_hash: null, tx_status: "simulated", request_id: req.request_id, label: "Test run — no transaction",
  });
  rec2.payment_outcome = { amount: ledger.amount, counterparty: ledger.counterparty, ledger_id: ledger.id };
  tx.appendEvent(businessId, "agent:finance", "payment.simulated", `ledger:${ledger.id}`, "simulated", runId, { amount_ngn: ledger.amount, counterparty: ledger.counterparty, tx_hash: null });
  exec.output = { simulated: true, ledger_id: ledger.id, amount_ngn: ledger.amount, beneficiary: ledger.counterparty, tx_hash: null };
  exec.reasoning = `Payment request through the treasury contract (test run). Simulated outcome recorded: no money moved, no transaction.`;
  exec.simulated = [...exec.simulated, "Test run — no transaction"];
  finishStep("succeeded");
  advance("next");
  return "executed";
}

// ---------------------------------------------------------------------------------------------------
// Owner decisions and controls (never execute steps)
// ---------------------------------------------------------------------------------------------------

export async function decideApproval(businessId: string, approvalId: string, decision: "approve" | "reject"): Promise<{ runId: string }> {
  return lockWait(businessId, async () => {
    const out = await runTransact(tx => {
      const a = tx.approvals(businessId).find(x => x.id === approvalId);
      if (!a) return { err: ["NOT_FOUND", 404, "That approval doesn't exist."] as const };
      const run = tx.run(businessId, a.run_id);
      if (!run) return { err: ["NOT_FOUND", 404, "That run doesn't exist."] as const };
      if (a.status !== "pending") return { err: [a.status === "expired" ? "APPROVAL_EXPIRED" : a.status === "invalidated" ? "APPROVAL_INVALIDATED" : "ALREADY_DECIDED", 409, "This approval has already been settled."] as const, runId: run.id };
      if (isExpired(a.expires_at, tx.now)) {
        tx.patchApproval(businessId, a.id, ["pending"], { status: "expired", decided_at: tx.now, decided_by: "system" });
        tx.appendEvent(businessId, "system", "approval.expired", `approval:${a.id}`, "expired", run.id, {});
        tx.patchRun(businessId, run.id, { status: "running" }, { status: ["waiting_approval"], control: null });
        return { err: ["APPROVAL_EXPIRED", 409, "This approval expired, so nothing will be paid."] as const, runId: run.id };
      }
      if (run.control === "stop" || run.status !== "waiting_approval") return { err: ["RUN_STOPPED", 409, "This run is no longer waiting for your approval."] as const, runId: run.id };
      if (tx.business(businessId)?.kill_switch) { finaliseCancel(tx, run, "KILL_SWITCH_ACTIVE", "owner"); return { err: ["KILL_SWITCH_ACTIVE", 409, "The kill switch is on, so the approval was invalidated."] as const, runId: run.id }; }
      if (decision === "approve") {
        // Re-check before the approval takes effect: the fingerprint and the hard rules (doc 05).
        const wf = tx.workflows(businessId).find(w => w.id === run.workflow_id);
        if (!wf || workflowFingerprint(wf) !== run.approval_fingerprint) {
          endRun(tx, run, "failed", "WORKFLOW_CHANGED", "system", { error: { code: "WORKFLOW_CHANGED", message: "The approved workflow changed." } });
          return { err: ["WORKFLOW_CHANGED", 409, "The workflow changed, so the approval was invalidated."] as const, runId: run.id };
        }
        const snap = run.demo_snapshot as DemoScenario;
        const finance = agentFor(tx.agents(businessId), "finance");
        const r = evaluate(
          { kind: "payment_request", agentKey: "finance", tool: "request_payment", stepId: "payment", requestId: a.request_id, beneficiary: a.beneficiary, amountNgn: a.amount_ngn, channel: { kind: "treasury_contract", method: "request_payment" }, provenance: "system" },
          { ...gateBase(tx, businessId, wf.steps, snap, tx.now, a.request_id), agent: finance ? { status: finance.status, allowedTools: finance.definition.allowed_tools } : null, stepTools: ["request_payment"] },
        );
        if (r.decision === "BLOCK") {
          endRun(tx, run, "blocked", r.reasons[0] ?? "BLOCKED", "system");
          return { err: ["BLOCKED", 409, "The payment no longer passes the security rules, so the approval was invalidated."] as const, runId: run.id };
        }
      }
      const status = decision === "approve" ? "approved" : "rejected";
      if (!tx.patchApproval(businessId, a.id, ["pending"], { status, decided_at: tx.now, decided_by: "owner" })) return { err: ["ALREADY_DECIDED", 409, "This approval has already been settled."] as const, runId: run.id };
      tx.patchRun(businessId, run.id, { status: "running" }, { status: ["waiting_approval"], control: null });
      tx.appendEvent(businessId, "owner", `approval.${status}`, `approval:${a.id}`, status, run.id, {});
      return { runId: run.id };
    });
    if ("err" in out && out.err) throw new ServiceError(out.err[0], out.err[1], out.err[2]);
    return { runId: out.runId! };
  });
}

/** Pause or stop: the request is persisted AT ONCE through the store queue (no business lock), then finalised. */
export async function requestControl(businessId: string, runId: string, control: "pause" | "stop"): Promise<{ finalised: boolean }> {
  const recorded = await runTransact(tx => {
    const run = tx.run(businessId, runId);
    if (!run) return { err: ["NOT_FOUND", 404, "That run doesn't exist."] as const };
    const allowed: readonly RunStatus[] = control === "pause" ? ["running"] : ACTIVE_RUN_STATUSES;
    if (!allowed.includes(run.status)) return { err: ["INVALID_TRANSITION", 409, control === "pause" ? "Only a running test run can be paused." : "This run has already ended."] as const };
    if (tx.setRunControl(businessId, runId, control)) tx.appendEvent(businessId, "owner", `run.${control}_requested`, `run:${runId}`, run.status, runId, {});
    return { ok: true as const };
  });
  if ("err" in recorded && recorded.err) throw new ServiceError(recorded.err[0], recorded.err[1], recorded.err[2]);
  try {
    await withBusinessLock(businessId, () => runTransact(tx => {
      const run = tx.run(businessId, runId);
      if (!run || !run.control) return;
      if (run.control === "stop") finaliseCancel(tx, run, "STOPPED_BY_OWNER", "owner");
      else if (run.status === "running" && !tx.steps(runId).some(s => s.status === "running")) {
        if (tx.patchRun(businessId, runId, { status: "paused", pause_reason: "owner" }, { status: ["running"], control: "pause" })) {
          tx.clearRunControl(businessId, runId, "pause");
          tx.appendEvent(businessId, "owner", "run.paused", `run:${runId}`, "paused", runId, { reason: "owner" });
        }
      }
    }), { mode: "wait", timeoutMs: DEFAULT_LOCK_WAIT_MS });
    return { finalised: true };
  } catch (e) {
    if (e instanceof LockBusyError) return { finalised: false };   // persisted; honoured at the next step boundary
    throw e;
  }
}

/** Resume a paused or interrupted run (it runs again only when the page advances it). */
export async function resumeRun(businessId: string, runId: string, hooks?: RunHooks): Promise<void> {
  await lockWait(businessId, async () => {
    const out = await runTransact(tx => {
      const run = tx.run(businessId, runId);
      if (!run) return { err: ["NOT_FOUND", 404, "That run doesn't exist."] as const };
      if (run.status === "running" && tx.steps(runId).some(s => s.status === "running")) {
        if (!leaseExpired(run, nowIso(hooks))) return { err: ["STEP_SETTLING", 409, "A step is still being checked. Try again in a few seconds."] as const };
        markInterrupted(tx, run);
      }
      const latest = tx.run(businessId, runId)!;
      if (latest.status === "paused" && latest.pause_reason?.startsWith("agent_paused:")) {
        const key = latest.pause_reason.slice("agent_paused:".length);
        if (agentFor(tx.agents(businessId), key)?.status === "paused") return { err: ["AGENT_STILL_PAUSED", 409, "Resume the paused agent first."] as const };
      }
      if (latest.status !== "paused" && latest.status !== "interrupted") return { err: ["INVALID_TRANSITION", 409, "Only a paused or interrupted run can be resumed."] as const };
      if (tx.business(businessId)?.kill_switch) return { err: ["KILL_SWITCH_ACTIVE", 409, "The kill switch is on."] as const };
      tx.patchRun(businessId, runId, { status: "running", pause_reason: null }, { status: ["paused", "interrupted"] });
      tx.appendEvent(businessId, "owner", "run.resumed", `run:${runId}`, "running", runId, { from: latest.status });
      return { ok: true as const };
    });
    if ("err" in out && out.err) throw new ServiceError(out.err[0], out.err[1], out.err[2]);
  });
}

/** The kill switch: the flag is persisted AT ONCE (no business lock); runs and approvals are then finalised. */
export async function setKillSwitch(businessId: string, active: boolean): Promise<{ finalised: boolean }> {
  await runTransact(tx => {
    const changed = tx.setKillSwitch(businessId, active);
    tx.appendEvent(businessId, "owner", active ? "kill_switch.on" : "kill_switch.off", `business:${businessId}`, changed ? "applied" : "no_change", businessId, {});
  });
  if (!active) return { finalised: true };
  try {
    await withBusinessLock(businessId, () => runTransact(tx => {
      for (const run of tx.runs(businessId).filter(r => ACTIVE_RUN_STATUSES.includes(r.status))) finaliseCancel(tx, run, "KILL_SWITCH_ACTIVE", "owner");
      for (const a of tx.approvals(businessId).filter(x => x.status === "pending" || (x.status === "approved" && !x.consumed_at))) {
        if (tx.patchApproval(businessId, a.id, ["pending", "approved"], { status: "invalidated", invalidated_reason: "KILL_SWITCH_ACTIVE", decided_at: tx.now, decided_by: "system" })) {
          tx.appendEvent(businessId, "owner", "approval.invalidated", `approval:${a.id}`, "invalidated", a.run_id, { reason: "KILL_SWITCH_ACTIVE" });
        }
      }
    }), { mode: "wait", timeoutMs: DEFAULT_LOCK_WAIT_MS });
    return { finalised: true };
  } catch (e) {
    if (e instanceof LockBusyError) return { finalised: false };   // persisted; the runner finalises at the next step
    throw e;
  }
}

/** Pause or resume one approved agent (D4). Resuming lets runs paused for that agent continue. */
export async function setAgentPaused(businessId: string, key: AgentKey, paused: boolean): Promise<void> {
  const ok = await runTransact(tx => {
    const changed = paused ? tx.setAgentStatus(businessId, key, "approved", "paused") : tx.setAgentStatus(businessId, key, "paused", "approved");
    if (changed) tx.appendEvent(businessId, "owner", paused ? "agent.paused" : "agent.resumed", `agent:${key}`, paused ? "paused" : "approved", businessId, {});
    return changed;
  });
  if (!ok) throw new ServiceError("INVALID_TRANSITION", 409, paused ? "Only an approved agent can be paused." : "This agent isn't paused.");
  if (!paused) {
    await lockWait(businessId, () => runTransact(tx => {
      for (const run of tx.runs(businessId).filter(r => r.status === "paused" && r.pause_reason === `agent_paused:${key}`)) {
        if (tx.patchRun(businessId, run.id, { status: "running", pause_reason: null }, { status: ["paused"] })) {
          tx.appendEvent(businessId, "owner", "run.resumed", `run:${run.id}`, "running", run.id, { from: "paused", agent: key });
        }
      }
    }));
  }
}

export { leaseExpired };
