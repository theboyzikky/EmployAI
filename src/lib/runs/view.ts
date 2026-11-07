import "server-only";
// M4 · Read-only views for the Runs tab. Built with runRead (a private copy of the stored state):
// nothing here can execute a step or persist a transition (D11). Expired approvals and stale leases
// are SHOWN as such and persisted by the next mutating call.
import { AGENT_TEMPLATES } from "@/lib/catalogue/catalogue";
import { causeOf, playbookByKey } from "@/lib/discovery/playbooks";
import type { BusinessRecord } from "@/lib/discovery/store";
import { REASON_TEXT } from "@/lib/security/gate";
import { isRunnableIndustry, restaurantDemoScenario } from "@/lib/workflows/demo-data";
import { checkRunEligibility } from "./eligibility";
import { runRead, type RunTx } from "./repo";
import { expectedFor } from "./runner";
import { SCENARIO_DEFS } from "./scenarios";
import { ACTIVE_RUN_STATUSES, SCENARIOS, type RunRecord } from "./types";
import type { AddressedItem, RunSummary, RunView, RunsView } from "./view-types";

const reasonList = (codes: string[]) => codes.map(code => ({ code, text: REASON_TEXT[code] ?? code }));
const agentName = (k: string | null) => (k && k in AGENT_TEMPLATES ? AGENT_TEMPLATES[k as keyof typeof AGENT_TEMPLATES].name : k === "system" ? "Security and approvals (system)" : "EmployAI runner");

const summaryOf = (r: RunRecord): RunSummary => ({
  id: r.id, status: r.status, scenario: r.scenario, scenarioTitle: SCENARIO_DEFS[r.scenario]?.title ?? r.scenario, workflowVersion: r.workflow_version,
  startedAt: r.started_at, endedAt: r.ended_at, elapsedMs: r.elapsed_ms, endReason: r.end_reason,
});

/** D15: what the workflow addresses, from the M3.5 case file (the owner's business information). */
function addressesOf(b: BusinessRecord): AddressedItem[] {
  const cf = b.profile.case_file;
  if (!cf) return [];
  const out: AddressedItem[] = [];
  for (const p of cf.problems) {
    const sym = cf.claims.find(c => c.id === p.symptom_claim)?.text ?? "";
    const pb = playbookByKey(p.playbook);
    const conf = p.hypotheses.find(h => h.status === "confirmed");
    const sup = p.hypotheses.find(h => h.status === "supported");
    const h = conf ?? sup;
    out.push({
      kind: p.from_goal ? "goal" : "problem", text: sym, cause: h && pb ? causeOf(pb, h.key)?.label ?? null : null,
      basis: conf ? "Confirmed by you" : sup ? "Supported by your answers" : "Cause not yet known",
    });
  }
  for (const n of (cf.needs ?? []).filter(x => x.status === "stated")) {
    if (!out.some(o => o.kind === "goal")) out.push({ kind: "need", text: n.label, cause: null, basis: "You asked for this" });
  }
  return out.slice(0, 6);
}

export async function buildRunsView(b: BusinessRecord): Promise<RunsView> {
  return runRead(tx => {
    const business = tx.business(b.id)!;
    const workflows = tx.workflows(b.id);
    const current = workflows.filter(w => w.status === "approved").sort((x, y) => y.version - x.version)[0] ?? null;
    const runs = tx.runs(b.id).slice().sort((x, y) => y.started_at.localeCompare(x.started_at));
    const agents = tx.agents(b.id);
    const runnable = isRunnableIndustry(business.business_type);
    const elig = current
      ? checkRunEligibility({ business, agents, workflows, runs, workflowId: current.id })
      : { code: "WORKFLOW_NOT_APPROVED", status: 409 as const, message: "Approve a workflow on the Workflows tab first." };
    const spent = tx.ledger(b.id).filter(l => l.occurred_at.slice(0, 10) === new Date().toISOString().slice(0, 10)).reduce((t, l) => t + l.amount, 0);
    return {
      businessId: business.id, businessName: business.name, runnable,
      killSwitch: !!business.kill_switch, killSwitchChangedAt: business.kill_switch_changed_at ?? null,
      eligibility: "ok" in elig ? { canRun: true, code: null, message: null } : { canRun: false, code: elig.code, message: elig.message },
      workflow: current ? { id: current.id, version: current.version, approvedAt: current.approved_at, fingerprinted: !!current.approval_fingerprint } : null,
      scenarios: SCENARIOS.map(k => ({ key: k, title: SCENARIO_DEFS[k].title, description: SCENARIO_DEFS[k].description, changes: SCENARIO_DEFS[k].changes,
        expected: current ? expectedFor(current.steps, k, spent) : { decision: null, end: "completed" } })),
      addresses: addressesOf(business),
      agents: agents.filter(a => a.status !== "removed" && a.status !== "proposed").map(a => ({ key: a.key, name: a.name, status: a.status, runnable: a.executable && runnable })),
      activeRunId: runs.find(r => ACTIVE_RUN_STATUSES.includes(r.status))?.id ?? null,
      runs: runs.slice(0, 20).map(summaryOf),
      demoLabel: restaurantDemoScenario().label,
    };
  });
}

export async function buildRunView(b: BusinessRecord, runId: string): Promise<RunView | null> {
  return runRead(tx => runViewFrom(tx, b.id, runId));
}

function runViewFrom(tx: RunTx, businessId: string, runId: string): RunView | null {
  const run = tx.run(businessId, runId);
  if (!run) return null;
  const now = new Date().toISOString();
  const doc = tx.workflows(businessId).find(w => w.id === run.workflow_id)?.steps ?? null;
  const steps = tx.steps(runId);
  const decisions = tx.decisions(businessId).filter(d => d.run_id === runId);
  const approval = tx.approvals(businessId).filter(a => a.run_id === runId).at(-1) ?? null;
  const ledger = tx.ledger(businessId).filter(l => l.run_id === runId);
  const events = tx.events(businessId).filter(e => e.correlation_id === runId);
  const openStep = steps.find(s => s.status === "running");
  const leaseValid = !!run.lease_expires_at && run.lease_expires_at > now;
  const lastDecision = decisions.at(-1)?.decision ?? null;
  const proposal = ((run.records.purchase_proposals ?? []) as Array<{ supplier: string }>)[0];
  const procurementReason = steps.find(s => s.step_id === "supplier_choice" && s.status === "succeeded")?.reasoning ?? null;
  return {
    run: {
      ...summaryOf(run), mode: "test_run", cursor: run.cursor, stepsDone: run.steps_done, execMs: run.exec_ms, pauseReason: run.pause_reason, control: run.control,
      summary: run.summary, error: run.error, expected: run.expected,
      actual: { decision: lastDecision, end: run.end_reason },
      interruptedDetected: run.status === "running" && !!openStep && !leaseValid,
      settling: run.status === "running" && !!openStep && leaseValid,
    },
    steps: steps.map(s => ({
      id: s.id, seq: s.seq, stepId: s.step_id, title: doc?.steps.find(x => x.id === s.step_id)?.title ?? s.step_id, type: s.step_type,
      // System steps: the security check and approval belong to "Security and approvals"; the trigger,
      // condition and end steps are the runner's own bookkeeping.
      agentKey: s.agent_key,
      agentName: s.agent_key === "system" && (s.requester === "runner" || !["security_check", "approval"].includes(s.step_type)) ? "EmployAI runner (system)" : agentName(s.agent_key),
      requester: s.requester,
      task: s.task_id, status: s.status, attempt: s.attempt, reasoning: s.reasoning, output: s.output, toolsUsed: s.tools_used, reads: s.reads, writes: s.writes,
      simulated: s.simulated, startedAt: s.started_at, endedAt: s.ended_at, durationMs: s.duration_ms, error: s.error,
    })),
    decisions: decisions.map(d => ({ id: d.id, decision: d.decision, reasons: reasonList(d.reason_codes), createdAt: d.created_at, signals: d.signals })),
    approval: approval ? {
      id: approval.id, status: approval.status, autoApproved: approval.auto_approved, amountNgn: approval.amount_ngn, beneficiary: approval.beneficiary,
      channel: "Treasury contract (test run)", reasons: reasonList(approval.reason_codes), expiresAt: approval.expires_at, decidedAt: approval.decided_at, decidedBy: approval.decided_by,
      expiredNotPersisted: approval.status === "pending" && approval.expires_at <= now,
      thresholdNgn: doc?.params.approval_threshold_ngn ?? 0, maxPaymentNgn: doc?.params.max_payment_ngn ?? 0,
      rationale: proposal ? procurementReason : null,
    } : null,
    ledger: ledger.map(l => ({ id: l.id, amount: l.amount, counterparty: l.counterparty, label: l.label, txHash: l.tx_hash, occurredAt: l.occurred_at })),
    events: events.map(e => ({ id: e.id, actor: e.actor, type: e.type, subject: e.subject, status: e.status, createdAt: e.created_at })),
    more: run.status === "running" && run.cursor !== null && !openStep,
  };
}
