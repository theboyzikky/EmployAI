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
import { expectedFor, retryEligibility } from "./runner";
import { SCENARIO_DEFS } from "./scenarios";
import { nearText } from "./agents";
import { EXPLORER_TX_URL } from "./payment-executor";
import { ACTIVE_RUN_STATUSES, SCENARIOS, ledgerNgn, type AttemptStatus, type PaymentAttempt, type RunRecord } from "./types";
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
    const spent = tx.ledger(b.id).filter(l => l.occurred_at.slice(0, 10) === new Date().toISOString().slice(0, 10)).reduce((t, l) => t + ledgerNgn(l), 0);
    const batch = tx.armedBatch(b.id);
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
      testnet: {
        batch: batch ? { ref: batch.batch_ref, maxPayments: batch.max_payments, paymentsUsed: batch.payments_used, maxTotalNear: nearText(batch.max_total_yocto), usedNear: nearText(batch.yocto_used), expiresAt: batch.expires_at } : null,
        recipients: restaurantDemoScenario().suppliers.filter(s => s.approved && s.testnet_account).map(s => ({ supplier: s.name, account: s.testnet_account! })),
      },
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
      ...summaryOf(run), mode: run.mode, batchRef: run.batch_id ? tx.batches(businessId).find(x => x.id === run.batch_id)?.batch_ref ?? null : null, cursor: run.cursor, stepsDone: run.steps_done, execMs: run.exec_ms, pauseReason: run.pause_reason, control: run.control,
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
      channel: approval.mode === "testnet" ? "Treasury contract · NEAR testnet (real transaction)" : "Treasury contract (test run)", reasons: reasonList(approval.reason_codes), expiresAt: approval.expires_at, decidedAt: approval.decided_at, decidedBy: approval.decided_by,
      expiredNotPersisted: approval.status === "pending" && approval.expires_at <= now,
      thresholdNgn: doc?.params.approval_threshold_ngn ?? 0, maxPaymentNgn: doc?.params.max_payment_ngn ?? 0,
      rationale: proposal ? procurementReason : null,
      testnet: approval.mode === "testnet" && approval.binding ? {
        recipientAccount: approval.binding.recipient_account_id, amountNear: nearText(approval.binding.amount_yocto), amountYocto: approval.binding.amount_yocto,
        contract: approval.binding.contract_id, agent: approval.binding.agent_account_id,
        batchRef: tx.batches(businessId).find(x => x.id === approval.binding!.batch_id)?.batch_ref ?? approval.binding.batch_id,
      } : null,
    } : null,
    ledger: ledger.map(l => l.mode === "testnet"
      ? { id: l.id, mode: l.mode, amountText: `${nearText(l.amount)} NEAR`, counterparty: l.counterparty, supplier: l.supplier_name, label: l.label, txHash: l.tx_hash, explorerUrl: l.tx_hash ? `${EXPLORER_TX_URL}${l.tx_hash}` : null, status: l.tx_status, occurredAt: l.occurred_at }
      : { id: l.id, mode: l.mode, amountText: `₦${l.amount.toLocaleString("en-NG")}`, counterparty: l.counterparty, supplier: null, label: l.label, txHash: null, explorerUrl: null, status: l.tx_status, occurredAt: l.occurred_at }),
    payment: attemptView(tx.attempts(businessId).filter(x => x.run_id === runId).at(-1) ?? null),
    retry: run.mode === "testnet" && run.status === "failed" ? (() => { const e = retryEligibility(tx, run); return e.allowed ? { allowed: true, reason: null } : { allowed: false, reason: e.reason }; })() : null,
    events: events.map(e => ({ id: e.id, actor: e.actor, type: e.type, subject: e.subject, status: e.status, createdAt: e.created_at })),
    more: run.status === "running" && run.cursor !== null && !openStep,
  };
}

const ATTEMPT_TEXT: Record<AttemptStatus, string> = {
  prepared: "Approved · about to be checked and signed",
  signing: "Checking the chain and signing",
  signed: "Signed and saved · about to be sent",
  submitting: "Sent · waiting for the final outcome",
  unknown: "Outcome not known yet · reconciling from the contract (never re-sent as a new payment)",
  confirmed: "Paid · verified on NEAR testnet",
  failed_onchain: "Failed on-chain · nothing was paid",
  aborted: "Not sent",
  expired_unexecuted: "Not sent · the signed transaction expired without executing",
};

/** The attempt as the owner sees it. Never includes the signed bytes or anything secret. */
function attemptView(a: PaymentAttempt | null) {
  if (!a) return null;
  const lastCheck = a.checks.at(-1) ?? null;
  return {
    id: a.id, status: a.status, statusText: ATTEMPT_TEXT[a.status], recipient: a.recipient, amountNear: nearText(a.amount_yocto), amountNgn: a.amount_ngn,
    txHash: a.tx_hash, explorerUrl: a.tx_hash && a.status !== "aborted" ? `${EXPLORER_TX_URL}${a.tx_hash}` : null, nonce: a.nonce,
    signedBlockHeight: a.signed_block_height, expiresAfterHeight: a.expires_after_height, broadcasts: a.broadcasts, verifiedAt: a.verified_at, error: a.error, lastCheck,
  };
}
