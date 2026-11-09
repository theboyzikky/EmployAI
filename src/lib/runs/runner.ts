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
// - Test runs: nothing leaves the run; a payment ends as a SIMULATED outcome only (C1–C4).
// - M5 testnet runs: the payment is real. Phase A (here, under the lock, atomic) consumes the owner's
//   approval and records a durable attempt; Phase B (payment-executor.ts, OUTSIDE the lock) signs,
//   writes ahead, broadcasts and verifies through the injected PaymentChain; Phase C (here) moves the run
//   on from the verified outcome. This module itself has no network, signer or NEAR code.
import type { AgentKey } from "@/lib/catalogue/catalogue";
import { ServiceError } from "@/lib/discovery/service";
import type { AgentRecord } from "@/lib/discovery/store";
import { DEFAULT_LOCK_WAIT_MS, LockBusyError, withBusinessLock } from "@/lib/locks";
import { actionHash, expiresAt, isExpired } from "@/lib/security/authorisation";
import { evaluate, type GateContext, type GatePolicy } from "@/lib/security/gate";
import type { DemoScenario } from "@/lib/workflows/demo-data";
import type { Params, Step, WorkflowDoc } from "@/lib/workflows/schema";
import * as Agents from "./agents";
import { currentBinding, firstRequest, type PreparedRequest } from "./binding";
import { abortUnsentAttempts, driveAttempt, driveRunAttempts } from "./payment-executor";
import { getPaymentChain, type ChainPrecheck, type PaymentChain } from "./payment-port";
import { bindingDiff, testnetActionHash } from "@/lib/security/authorisation";
import type { NearGateContext } from "@/lib/security/gate";
import { checkRunEligibility } from "./eligibility";
import { workflowFingerprint } from "./fingerprint";
import { runRead, runTransact, type RunTx } from "./repo";
import { SCENARIO_DEFS, chooseSupplier, reorderFor, scenarioSnapshot, stockAfterOrder } from "./scenarios";
import { BrokerRefusal, makeBroker, scopeAccess, type Work } from "./tools";
import { ACTIVE_RUN_STATUSES, TERMINAL_ATTEMPT_STATUSES, ledgerNgn, type Actor, type RunMode, type RunRecord, type RunStatus, type RunStepRecord, type ScenarioKey } from "./types";

/** M5 · What one advance may need from the chain: the injected port and a fresh precheck. */
type RunEnv = { chain: PaymentChain | null; precheck: { requestKey: string; data: ChainPrecheck } | null };
const NO_ENV: RunEnv = { chain: null, precheck: null };
const requestKey = (r: PreparedRequest) => `${r.request_id}|${r.recipient_account}|${r.amount_yocto}`;
const PRECHECK_MAX_AGE_MS = 60_000;

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
    registry: snap.suppliers.map(s => ({ name: s.name, approved: s.approved, priorPayments: s.prior_payments ?? 0, account: s.testnet_account })),
    blocklist: [],
    spentTodayNgn: tx.ledger(businessId).filter(l => today(l.occurred_at) === today(nowIsoStr)).reduce((t, l) => t + ledgerNgn(l), 0),
    seenRequestIds: tx.decisions(businessId).map(d => (d.action as { request_id?: string }).request_id ?? "").filter(id => id && id !== excludeRequestId),
  };
}

/**
 * M5 · NEAR gate context: the app policy, today's testnet total (the larger of the app's confirmed +
 * in-flight attempts and the contract's own counter), the chain checks' hard refusals, and the
 * confirmed payouts per account ("paid before", R7).
 */
function nearContext(tx: RunTx, businessId: string, snap: DemoScenario, pre: ChainPrecheck | null, nowIsoStr: string): NearGateContext {
  const np = snap.near_policy;
  const failures = pre ? pre.failures.map(f => f.code) : ["CHAIN_UNAVAILABLE"];
  if (pre?.onchainLimits && np && (pre.onchainLimits.maxPerTxYocto !== np.max_per_tx_yocto || pre.onchainLimits.dailyCapYocto !== np.daily_cap_yocto)) failures.push("TREASURY_POLICY_MISMATCH");
  const day = today(nowIsoStr);
  const local = tx.attempts(businessId).filter(a => today(a.created_at) === day && !["failed_onchain", "aborted", "expired_unexecuted"].includes(a.status))
    .reduce((t, a) => t + BigInt(a.amount_yocto), BigInt(0));
  const onchain = pre?.onchainSpentTodayYocto ? BigInt(pre.onchainSpentTodayYocto) : BigInt(0);
  const confirmedPayouts = paidTestnet(tx, businessId);
  return {
    policy: np ? { version: np.version, maxPerTxYocto: np.max_per_tx_yocto, dailyCapYocto: np.daily_cap_yocto, approvalThresholdYocto: np.approval_threshold_yocto } : null,
    spentTodayYocto: (local > onchain ? local : onchain).toString(),
    chainFailures: failures,
    confirmedPayouts,
    signals: {
      near_policy_version: pre?.nearPolicyVersion ?? null, onchain_spent_today_yocto: pre?.onchainSpentTodayYocto ?? null, app_spent_today_yocto: local.toString(),
      chain_checked_at: pre?.checkedAt ?? null, chain_failures: pre?.failures ?? [{ code: "CHAIN_UNAVAILABLE", detail: "no chain check" }],
    },
  };
}

/** Rebuild a precheck from a stored decision's signals (re-checks without new RPC: approve click, Phase A). */
function precheckFromSignals(signals: Record<string, unknown>): ChainPrecheck {
  return { failures: [], onchainSpentTodayYocto: (signals.onchain_spent_today_yocto as string | null) ?? null, nearPolicyVersion: (signals.near_policy_version as string | null) ?? null, onchainLimits: null, checkedAt: (signals.chain_checked_at as string) ?? "" };
}

/** Confirmed testnet payouts per account (R7: the only "paid before" signal in testnet). */
const paidTestnet = (tx: RunTx, businessId: string) => {
  const out: Record<string, number> = {};
  for (const l of tx.ledger(businessId)) if (l.mode === "testnet" && l.tx_status === "confirmed") out[l.counterparty] = (out[l.counterparty] ?? 0) + 1;
  return out;
};

const nearAction = (req: PreparedRequest | undefined) => (req?.recipient_account && req.amount_yocto ? { recipientAccount: req.recipient_account, amountYocto: req.amount_yocto } : undefined);

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
export function expectedFor(doc: WorkflowDoc, scenario: ScenarioKey, spentTodayNgn: number, mode: RunMode = "test_run", testnetPaid: Readonly<Record<string, number>> = {}): RunRecord["expected"] {
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
    { killSwitch: false, agent: { status: "approved", allowedTools: ["request_payment"] }, stepTools: ["request_payment"], policy: policyOf(doc, snap), registry: snap.suppliers.map(s => ({ name: s.name, approved: s.approved, priorPayments: mode === "testnet" ? testnetPaid[s.testnet_account ?? ""] ?? 0 : s.prior_payments ?? 0 })), blocklist: [], spentTodayNgn, seenRequestIds: [] });
  // Testnet: approval is ALWAYS required (R5), so ALLOW and WARN both wait for the owner.
  if (mode === "testnet") return { decision: r.decision, end: r.decision === "BLOCK" ? "blocked" : "approval" };
  return { decision: r.decision, end: r.decision === "ALLOW" ? "completed" : r.decision === "WARN" ? "approval" : "blocked" };
}

// ---------------------------------------------------------------------------------------------------
// Start (creates and persists; executes nothing)
// ---------------------------------------------------------------------------------------------------

export async function startRun(businessId: string, input: { workflowId: string; scenario: ScenarioKey; idempotencyKey: string; mode?: RunMode; confirmRealTransactions?: boolean }, hooks?: RunHooks): Promise<{ runId: string; created: boolean }> {
  const mode: RunMode = input.mode ?? "test_run";
  if (mode === "testnet") {
    if (input.confirmRealTransactions !== true) throw new ServiceError("CONFIRMATION_REQUIRED", 400, "Confirm that this run signs a real NEAR testnet transaction.");
    const av = await getPaymentChain();
    if (!av.ok) throw new ServiceError(av.code, 503, av.message);
  }
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
      const spent = tx.ledger(businessId).filter(l => today(l.occurred_at) === today(now)).reduce((t, l) => t + ledgerNgn(l), 0);
      // Testnet: a payment run needs an armed, unexpired batch with capacity (plan §8.4).
      const batch = mode === "testnet" ? tx.armedBatch(businessId) : null;
      if (mode === "testnet" && !batch) return { refusal: { code: "BATCH_NOT_ARMED", status: 409, message: "Arm an approved testnet batch before starting a NEAR testnet run." } };
      if (batch && batch.payments_used >= batch.max_payments) return { refusal: { code: "BATCH_LIMIT_REACHED", status: 409, message: "The armed testnet batch has no payments left." } };
      const trigger = doc.steps.find(s => s.type === "trigger");
      const run = tx.insertRun({
        business_id: businessId, workflow_id: elig.workflow.id, workflow_version: elig.workflow.version, approval_fingerprint: elig.fingerprint,
        mode, batch_id: batch?.id ?? null, scenario: input.scenario, status: "running",
        trigger: { source: trigger?.type === "trigger" ? trigger.source : "demo_order", requested_by: "owner" }, idempotency_key: input.idempotencyKey,
        demo_snapshot: snap, records: { orders: [], handoffs: [] }, cursor: doc.start, steps_done: 0, exec_ms: 0, lease_expires_at: null,
        control: null, control_at: null, pause_reason: null, started_at: now, ended_at: null, elapsed_ms: null, summary: null,
        expected: expectedFor(doc, input.scenario, spent, mode, paidTestnet(tx, businessId)), end_reason: null, error: null,
      });
      tx.appendEvent(businessId, "owner", "run.started", `run:${run.id}`, "running", run.id, { workflow_version: elig.workflow.version, scenario: input.scenario, mode, batch: batch?.batch_ref ?? null });
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
  // M5: a payment not yet broadcast is aborted (any signed bytes are discarded, never sent). One already
  // broadcast can't be recalled: it keeps being reconciled and its real outcome is recorded (§14).
  abortUnsentAttempts(tx, run.business_id, run.id, reason);
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

/**
 * Advance a run. Steps execute under the business lock in bounded batches (unchanged M4 behaviour). For
 * a NEAR testnet run, the chain work between batches happens OUTSIDE the lock: the read-only precheck
 * before the security check, and driving the payment attempt (sign → write-ahead → broadcast → verify,
 * or reconcile). Any unfinished attempt is driven first, so a restarted server recovers on the next
 * advance without ever re-signing a persisted transaction.
 */
export async function advanceRun(businessId: string, runId: string, hooks?: RunHooks): Promise<AdvanceResult> {
  const peek = await runRead(tx => tx.run(businessId, runId));
  if (!peek) throw new ServiceError("NOT_FOUND", 404, "That run doesn't exist.");
  if (peek.mode !== "testnet") return lockWait(businessId, () => runBatch(businessId, runId, NO_ENV, hooks));

  const av = await getPaymentChain();
  if (!av.ok) throw new ServiceError(av.code, 503, av.message);   // nothing changes without the chain
  const env: RunEnv = { chain: av.chain, precheck: null };
  const drove = new Set<string>();
  await driveRunAttempts(businessId, runId, av.chain);
  const pending = await runRead(tx => tx.attempts(businessId).filter(a => a.run_id === runId && !TERMINAL_ATTEMPT_STATUSES.includes(a.status)).map(a => a.id));
  for (const id of pending) drove.add(id);
  let advanced = 0;
  let last: AdvanceResult = { advanced: 0, more: false, settling: false };
  for (let round = 0; round < 4; round++) {
    last = await lockWait(businessId, () => runBatch(businessId, runId, env, hooks));
    advanced += last.advanced;
    const work = await runRead(tx => chainWorkFor(tx, businessId, runId, env));
    if (!work) break;
    if (work.kind === "precheck") {
      if (env.precheck?.requestKey === work.requestKey) break;
      env.precheck = { requestKey: work.requestKey, data: await safePrecheck(av.chain, work.recipient, work.amountYocto) };
      continue;
    }
    if (drove.has(work.attemptId)) break;      // drive each attempt at most once per advance
    drove.add(work.attemptId);
    await driveAttempt(businessId, work.attemptId, av.chain);
  }
  const unfinished = await runRead(tx => tx.attempts(businessId).some(a => a.run_id === runId && !TERMINAL_ATTEMPT_STATUSES.includes(a.status)));
  return { advanced, more: !unfinished && last.more, settling: unfinished || last.settling };
}

type ChainWork = { kind: "precheck"; requestKey: string; recipient: string; amountYocto: string } | { kind: "attempt"; attemptId: string };

/** What chain work the run needs before it can move on (read-only). */
function chainWorkFor(tx: RunTx, businessId: string, runId: string, env: RunEnv): ChainWork | null {
  const att = tx.attempts(businessId).filter(a => a.run_id === runId && !TERMINAL_ATTEMPT_STATUSES.includes(a.status)).at(-1);
  if (att) return { kind: "attempt", attemptId: att.id };
  const run = tx.run(businessId, runId);
  if (!run || run.status !== "running" || run.mode !== "testnet") return null;
  const step = docOf(tx, run)?.steps.find(s => s.id === run.cursor);
  const req = firstRequest(run.records);
  if (step?.type !== "security_check" || !req?.recipient_account || !req.amount_yocto) return null;
  const key = requestKey(req);
  return env.precheck?.requestKey === key ? null : { kind: "precheck", requestKey: key, recipient: req.recipient_account, amountYocto: req.amount_yocto };
}

async function safePrecheck(chain: PaymentChain, recipient: string, amountYocto: string): Promise<ChainPrecheck> {
  try {
    return await chain.precheck({ recipient, amountYocto });
  } catch {
    return { failures: [{ code: "CHAIN_UNAVAILABLE", detail: "the chain checks could not be completed" }], onchainSpentTodayYocto: null, nearPolicyVersion: null, onchainLimits: null, checkedAt: new Date().toISOString() };
  }
}

async function runBatch(businessId: string, runId: string, env: RunEnv, hooks?: RunHooks): Promise<AdvanceResult> {
  {
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
        const r = await runOneStep(businessId, runId, env, hooks);
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
  }
}

type StepOutcome = "executed" | "retry" | "stopped";

async function runOneStep(businessId: string, runId: string, env: RunEnv, hooks?: RunHooks): Promise<StepOutcome> {
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
    // M5 · testnet: chain work happens outside the lock, so stop here when the step needs it first.
    if (run.mode === "testnet") {
      if (!env.chain) return { stop: true as const };
      const req = firstRequest(run.records);
      if (step.type === "security_check" && req?.recipient_account && req.amount_yocto) {
        const fresh = env.precheck?.requestKey === requestKey(req) && Date.now() - Date.parse(env.precheck.data.checkedAt) <= PRECHECK_MAX_AGE_MS;
        if (!fresh) return { stop: true as const };
      }
      if (step.type === "payment" && req && tx.attempts(businessId).some(a => a.request_id === req.request_id && !TERMINAL_ATTEMPT_STATUSES.includes(a.status))) {
        return { stop: true as const };   // Phase B in progress: the executor drives it
      }
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
  return runTransact(tx => commitStep(tx, { businessId, runId, step, doc, rec, exec, work, durationMs, nowIsoStr: nowIso(hooks), env }));
}

const needsAgentHandler = (s: Step) => s.type === "agent_task" || (s.type === "notify") || s.type === "payment";

function executeAgentStep(step: Step, doc: WorkflowDoc, run: RunRecord, agents: AgentRecord[], work: Work, gate: Omit<GateContext, "agent" | "stepTools">) {
  const toolsUsed: string[] = [], reads: string[] = [], writes: string[] = [], simulated: string[] = [];
  const budget = { max_payment_ngn: doc.params.max_payment_ngn, approval_threshold_ngn: doc.params.approval_threshold_ngn, daily_limit_ngn: (run.demo_snapshot as DemoScenario).policy?.daily_limit_ngn ?? 0 };
  const scopes = scopeAccess(work, { budget });
  const collect = (b: ReturnType<typeof makeBroker>) => { for (const [to, from] of [[toolsUsed, b.toolsUsed], [reads, b.reads], [writes, b.writes], [simulated, b.simulated]] as const) for (const x of from) if (!to.includes(x)) to.push(x); };
  const brokerFor = (key: string | null, tools: readonly string[], r: readonly string[], w: readonly string[]) => makeBroker({ agent: brokerAgent(agentFor(agents, key)), step: { id: step.id, tools, reads: r, writes: w }, gate, scopes });
  const input = { runId: run.id, params: doc.params, mode: run.mode };

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
  const paid = rec.payment_outcome as { amount: number; counterparty: string; testnet?: { amount_near: string; account: string; tx_hash: string } } | undefined;
  const parts: string[] = [];
  const o = orders.at(-1);
  if (o) parts.push(o.status === "confirmed" ? `Demo order confirmed (₦${(o.total_ngn ?? 0).toLocaleString("en-NG")}).` : "The demo order was rejected.");
  parts.push(reorder ? `${reorder.item} needed a reorder of ${reorder.quantity} ${reorder.unit}.` : "No reorder was needed.");
  if (proposal) parts.push(`${proposal.supplier} was recommended (₦${proposal.total_ngn.toLocaleString("en-NG")}).`);
  if (paid?.testnet) parts.push(`Paid ${paid.testnet.amount_near} NEAR on NEAR testnet to ${paid.testnet.account} (${paid.counterparty}); verified on-chain, transaction ${paid.testnet.tx_hash}.`);
  else if (paid) parts.push(`Simulated payment recorded for ${paid.counterparty}: test run, no transaction.`);
  return parts.join(" ");
}

// ---------------------------------------------------------------------------------------------------
// The commit (synchronous, inside one store transaction)
// ---------------------------------------------------------------------------------------------------

type CommitArgs = {
  businessId: string; runId: string; step: Step; doc: WorkflowDoc; rec: RunStepRecord;
  exec: { output: unknown; reasoning: string | null; toolsUsed: string[]; reads: string[]; writes: string[]; simulated: string[]; error: { code: string; message: string } | null; transient: boolean };
  work: Work; durationMs: number; nowIsoStr: string; env: RunEnv;
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
      const req = firstRequest(rec2);
      const testnet = run.mode === "testnet";
      const near = testnet ? nearAction(req) : undefined;
      if (!req || (testnet && !near)) { finishStep("failed", { error: { code: "NO_PAYMENT_REQUEST", message: "There's no payment request to check." } }); endRun(tx, run, "failed", "NO_PAYMENT_REQUEST", "system", {}, ["running"]); return "stopped"; }
      const finance = agentFor(tx.agents(businessId), "finance");
      const pre = testnet && a.env.precheck?.requestKey === requestKey(req) ? a.env.precheck.data : null;
      const result = evaluate(
        { kind: "payment_request", agentKey: "finance", tool: "request_payment", stepId: "payment", requestId: req.request_id, beneficiary: req.beneficiary, amountNgn: req.amount_ngn, channel: req.channel, provenance: "system", near },
        // A retry re-evaluates the SAME request: its own earlier decision isn't a duplicate (the contract and
        // the signer still allow at most one success per request_id).
        { ...gateBase(tx, businessId, doc, snap, a.nowIsoStr, run.payment_retry ? req.request_id : undefined), agent: finance ? { status: finance.status, allowedTools: finance.definition.allowed_tools } : null, stepTools: ["request_payment"],
          near: testnet ? nearContext(tx, businessId, snap, pre, a.nowIsoStr) : undefined },
      );
      const hash = actionHash({ businessId, runId, requestId: req.request_id, beneficiary: req.beneficiary, amountNgn: req.amount_ngn, method: "request_payment" });
      const d = tx.appendDecision({
        business_id: businessId, run_id: runId, step_id: step.id, agent_key: "finance",
        action: { request_id: req.request_id, beneficiary: req.beneficiary, amount_ngn: req.amount_ngn, channel: req.channel, tool: "request_payment", ...(near ? { recipient_account: near.recipientAccount, amount_yocto: near.amountYocto } : {}) },
        action_hash: hash, decision: result.decision, reason_codes: result.reasons, signals: result.signals, policy_version: result.policyVersion, provenance: { source: "system" }, mode: run.mode,
      });
      rec2.security_decision_id = d.id;
      tx.appendEvent(businessId, "system", "security.decision", `decision:${d.id}`, result.decision, runId, { reasons: result.reasons, mode: run.mode });
      exec.output = { decision: result.decision, reasons: result.reasons };
      exec.reasoning = `Security check: ${result.decision}${result.reasons.length ? ` (${result.reasons.join(", ")})` : ""}. ` + (testnet
        ? `NEAR testnet: rules checked in both currencies, plus the treasury's readiness and the on-chain allowlist${pre ? "" : " (the chain checks couldn't run, so the payment is blocked)"}. ${result.decision === "BLOCK" ? "Nothing will be signed." : "Your approval is required before anything is signed."}`
        : "Test-run decision on demo data; on-chain checks run from the next stage.");
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
    const testnet = run.mode === "testnet";
    // Testnet: NEVER automatic, even on ALLOW (R5); the approval binds the exact payment (V1).
    const auto = decision.decision === "ALLOW" && !testnet;
    let binding: ReturnType<typeof currentBinding> = null;
    if (testnet) {
      const npv = (decision.signals as { near_policy_version?: string | null }).near_policy_version;
      binding = a.env.chain && npv ? currentBinding(tx, run, { gateDecisionId: decision.id, target: a.env.chain.target, nearPolicyVersion: npv }) : null;
      if (!binding) { finishStep("failed", { error: { code: "APPROVAL_STALE", message: "The payment couldn't be bound to an approval." } }); endRun(tx, run, "failed", "APPROVAL_STALE", "system", {}, ["running"]); return "stopped"; }
    }
    const reqFull = firstRequest(rec2);
    approval = tx.insertApproval({
      business_id: businessId, run_id: runId, decision_id: decision.id, request_id: req.request_id, action_hash: binding ? testnetActionHash(binding) : decision.action_hash,
      amount_ngn: req.amount_ngn, beneficiary: req.beneficiary, reason_codes: decision.reason_codes, status: auto ? "approved" : "pending", auto_approved: auto,
      expires_at: expiresAt(tx.now), decided_at: auto ? tx.now : null, decided_by: auto ? "system" : null, consumed_at: null, invalidated_reason: null,
      ...(binding ? { mode: "testnet" as const, binding, recipient_account: reqFull?.recipient_account, amount_yocto: reqFull?.amount_yocto } : {}),
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
  if (run.mode === "testnet") return commitTestnetPayment(tx, a, run, finishStep, advance, fail);
  // Reconciliation: an outcome for this request already exists → reuse it, never produce a second one.
  const existing = tx.ledger(businessId).find((l): l is Extract<typeof l, { mode: "test_run" }> => l.request_id === req.request_id && l.mode === "test_run");
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

/**
 * M5 · The testnet payment step.
 * Phase A (no attempt yet; atomic): re-check the hard rules, recompute the approval binding from the
 * current state, count the payment against the armed batch, consume the owner's approval ONCE and
 * record a durable `prepared` attempt. The step then waits while the executor (outside the lock) does
 * Phase B. Phase C (attempt final): move the run on from the VERIFIED outcome only.
 */
function commitTestnetPayment(tx: RunTx, a: CommitArgs, run: RunRecord, finishStep: Finish, advance: Advance, fail: (code: string, message: string, status: RunStatus) => "stopped"): StepOutcome {
  const { businessId, runId, work, exec, doc } = a;
  const snap = work.snapshot as unknown as DemoScenario;
  const rec2 = work.records as Record<string, unknown>;
  const req = firstRequest(rec2)!;
  const near = nearAction(req);
  if (!near) return fail("NO_PAYMENT_REQUEST", "There's no testnet payment request.", "failed");
  const latest = tx.attempts(businessId).filter(x => x.request_id === req.request_id).at(-1);
  // An owner-requested retry of a PROVEN failure/expiry starts a NEW attempt (Phase A) on top of it.
  const retry = run.payment_retry && latest && latest.id === run.payment_retry.of_attempt && (latest.status === "failed_onchain" || latest.status === "expired_unexecuted") ? run.payment_retry : null;
  const prior = retry ? undefined : latest;

  // ---- Phase C: the attempt is final ---------------------------------------------------------------
  if (prior) {
    const nearAmt = Agents.nearText(prior.amount_yocto);
    switch (prior.status) {
      case "confirmed": {
        rec2.payment_outcome = { amount: req.amount_ngn, counterparty: req.beneficiary, attempt_id: prior.id, testnet: { amount_near: nearAmt, account: prior.recipient, tx_hash: prior.tx_hash } };
        exec.output = { testnet: true, attempt_id: prior.id, tx_hash: prior.tx_hash, amount_yocto: prior.amount_yocto, amount_near: nearAmt, recipient: prior.recipient, amount_ngn_business: prior.amount_ngn, verified_at: prior.verified_at };
        exec.reasoning = `Paid ${nearAmt} NEAR to ${prior.recipient} on NEAR testnet through the treasury contract. Verified on-chain: final success, payout callback true, payout event matches, request record Paid. Business amount ₦${prior.amount_ngn.toLocaleString("en-NG")} (illustrative, not converted).`;
        exec.simulated = [];
        finishStep("succeeded");
        advance("next");
        tx.appendEvent(businessId, "agent:finance", "payment.settled", `attempt:${prior.id}`, "confirmed", runId, { tx_hash: prior.tx_hash });
        return "executed";
      }
      case "failed_onchain":
        exec.output = { testnet: true, attempt_id: prior.id, tx_hash: prior.tx_hash, status: "failed_onchain" };
        return fail(prior.error?.code ?? "PAYOUT_FAILED", prior.error?.message ?? "The payout failed on-chain.", "failed");
      case "expired_unexecuted":
        return fail("PAYMENT_NOT_SENT", prior.error?.message ?? "The signed transaction expired without executing; nothing was paid.", "failed");
      case "aborted": {
        const code = prior.error?.code ?? "PAYMENT_ABORTED";
        if (code === "KILL_SWITCH_ACTIVE" || code === "STOPPED_BY_OWNER") { finaliseCancel(tx, run, code, "system"); return "stopped"; }
        return fail(code, prior.error?.message ?? "The payment was not sent.", code === "APPROVAL_STALE" ? "failed" : "blocked");
      }
      default:
        return "stopped";      // still in flight (the executor drives it)
    }
  }

  // ---- Phase A ------------------------------------------------------------------------------------
  const chain = a.env.chain;
  if (!chain) return "stopped";
  const decision = tx.decisions(businessId).find(d => d.id === (rec2.security_decision_id as string | undefined));
  if (!decision) return fail("NO_DECISION", "No security decision to act on.", "failed");
  const finance = agentFor(tx.agents(businessId), "finance");
  const recheck = evaluate(
    { kind: "payment_request", agentKey: "finance", tool: "request_payment", stepId: "payment", requestId: req.request_id, beneficiary: req.beneficiary, amountNgn: req.amount_ngn, channel: req.channel, provenance: "system", near },
    { ...gateBase(tx, businessId, doc, snap, a.nowIsoStr, req.request_id), agent: finance ? { status: finance.status, allowedTools: finance.definition.allowed_tools } : null, stepTools: ["request_payment"],
      near: nearContext(tx, businessId, snap, precheckFromSignals(decision.signals), a.nowIsoStr) },
  );
  if (recheck.decision === "BLOCK") return fail(recheck.reasons[0] ?? "BLOCKED", "The payment no longer passes the security rules.", "blocked");
  const approval = tx.approvals(businessId).find(x => x.run_id === runId && x.request_id === req.request_id && x.mode === "testnet" && x.status === "approved" && !x.consumed_at && !x.auto_approved);
  if (!approval?.binding) return fail("PAYMENT_NOT_AUTHORISED", "No valid, unused owner approval matches this payment.", "failed");
  const now = currentBinding(tx, run, { gateDecisionId: approval.binding.gate_decision_id, target: chain.target, nearPolicyVersion: approval.binding.near_policy_version });
  const hash = now ? testnetActionHash(now) : "";
  if (!now || hash !== approval.action_hash) {
    const changed = now ? bindingDiff(approval.binding, now) : ["request"];
    tx.patchApproval(businessId, approval.id, ["approved"], { status: "invalidated", invalidated_reason: `APPROVAL_STALE: ${changed.join(", ")}`, decided_at: tx.now, decided_by: "system" });
    return fail("APPROVAL_STALE", `Changed since your approval: ${changed.join(", ")}. Nothing was signed.`, "failed");
  }
  const used = tx.useBatch(businessId, run.batch_id ?? "", near.amountYocto);
  if (used !== "ok") return fail(used, used === "BATCH_NOT_ARMED" ? "The testnet batch is no longer armed." : "The testnet batch has no capacity left.", "blocked");
  if (!tx.consumeApproval(businessId, approval.id, hash)) return fail("PAYMENT_NOT_AUTHORISED", "No valid, unused owner approval matches this payment.", "failed");
  const attempt = tx.insertAttempt({
    business_id: businessId, run_id: runId, request_id: req.request_id, batch_id: run.batch_id!, approval_id: approval.id, action_hash: hash, status: "prepared",
    recipient: near.recipientAccount, supplier_name: req.beneficiary, amount_yocto: near.amountYocto, amount_ngn: req.amount_ngn,
    lease_owner: null, lease_expires_at: null, pre_sign_errors: 0, nonce: null, signer_public_key: null, tx_hash: null, signed_tx_b64: null,
    signed_block_hash: null, signed_block_height: null, validity_period_blocks: null, expires_after_height: null, broadcasts: 0,
    outcome: null, gas_burnt: null, verified_at: null, error: null, checks: [],
    sign_mode: retry ? retry.mode : "new", retry_of: retry ? latest!.id : null,
    previous_expires_after_height: retry?.mode === "resubmit_after_expiry" ? latest!.expires_after_height : null,
  });
  tx.appendEvent(businessId, "agent:finance", "payment.prepared", `attempt:${attempt.id}`, "prepared", runId, { amount_yocto: near.amountYocto, recipient: near.recipientAccount, batch: run.batch_id, sign_mode: retry ? retry.mode : "new" });
  exec.output = { testnet: true, attempt_id: attempt.id, status: "prepared", amount_yocto: near.amountYocto, amount_near: Agents.nearText(near.amountYocto), recipient: near.recipientAccount };
  exec.reasoning = `Your approval was used once for this exact payment. Sending ${Agents.nearText(near.amountYocto)} NEAR to ${near.recipientAccount} on NEAR testnet: the signer re-checks everything, then the transaction is saved before it is sent.`;
  finishStep("waiting", { ended_at: null, duration_ms: null });
  tx.patchRun(businessId, runId, { records: work.records, demo_snapshot: work.snapshot, exec_ms: run.exec_ms + a.durationMs }, { status: ["running"], control: run.control });
  return "stopped";
}

// ---------------------------------------------------------------------------------------------------
// Owner decisions and controls (never execute steps)
// ---------------------------------------------------------------------------------------------------

export async function decideApproval(businessId: string, approvalId: string, decision: "approve" | "reject"): Promise<{ runId: string }> {
  // M5: approving a testnet payment re-checks its binding against the chain target in use NOW.
  const isTestnet = decision === "approve" && (await runRead(tx => tx.approvals(businessId).find(x => x.id === approvalId)?.mode)) === "testnet";
  let target: PaymentChain["target"] | null = null;
  if (isTestnet) {
    const av = await getPaymentChain();
    if (!av.ok) throw new ServiceError(av.code, 503, av.message);
    target = av.chain.target;
  }
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
        let nearCtx: NearGateContext | undefined;
        let near: ReturnType<typeof nearAction>;
        if (a.mode === "testnet") {
          // Testnet: the batch must still be armed, and every bound field must be unchanged (V1).
          const batch = tx.armedBatch(businessId);
          const stale = (code: string, message: string) => {
            tx.patchApproval(businessId, a.id, ["pending"], { status: "invalidated", invalidated_reason: code, decided_at: tx.now, decided_by: "system" });
            tx.appendEvent(businessId, "system", "approval.invalidated", `approval:${a.id}`, "invalidated", run.id, { reason: code });
            endRun(tx, run, "failed", code, "system", { error: { code, message } });
            return { err: [code, 409, message] as const, runId: run.id };
          };
          if (!batch || batch.id !== run.batch_id) return stale("BATCH_NOT_ARMED", "The testnet batch for this run is no longer armed, so the approval was invalidated.");
          const now = a.binding && target ? currentBinding(tx, run, { gateDecisionId: a.binding.gate_decision_id, target, nearPolicyVersion: a.binding.near_policy_version }) : null;
          if (!a.binding || !now || testnetActionHash(now) !== a.action_hash) {
            const changed = a.binding && now ? bindingDiff(a.binding, now).join(", ") : "the payment";
            return stale("APPROVAL_STALE", `Something this approval covered has changed (${changed}), so it was invalidated. Nothing was signed.`);
          }
          const d = tx.decisions(businessId).find(x => x.id === a.decision_id);
          near = nearAction(firstRequest(run.records));
          nearCtx = nearContext(tx, businessId, snap, precheckFromSignals(d?.signals ?? {}), tx.now);
        }
        const r = evaluate(
          { kind: "payment_request", agentKey: "finance", tool: "request_payment", stepId: "payment", requestId: a.request_id, beneficiary: a.beneficiary, amountNgn: a.amount_ngn, channel: { kind: "treasury_contract", method: "request_payment" }, provenance: "system", near },
          { ...gateBase(tx, businessId, wf.steps, snap, tx.now, a.request_id), agent: finance ? { status: finance.status, allowedTools: finance.definition.allowed_tools } : null, stepTools: ["request_payment"], near: nearCtx },
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
    // M5 (§14): the kill switch also disarms any armed testnet batch, at once.
    if (active && tx.disarmBatches(businessId, "KILL_SWITCH_ACTIVE") > 0) tx.appendEvent(businessId, "owner", "testnet.disarmed", `business:${businessId}`, "disarmed", businessId, { reason: "KILL_SWITCH_ACTIVE" });
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

/** NEAR → yoctoNEAR, exactly (decimal string with up to 24 places). */
export function nearToYocto(near: string): string {
  const m = /^(\d+)(?:\.(\d{1,24}))?$/.exec(near);
  if (!m) throw new ServiceError("VALIDATION_FAILED", 400, "Give the NEAR amount as a decimal, e.g. 0.1.");
  return (BigInt(m[1]) * BigInt("1000000000000000000000000") + BigInt((m[2] ?? "").padEnd(24, "0") || "0")).toString();
}

/** The most NEAR one batch may move: the contract's daily cap (0.25 NEAR). */
const BATCH_MAX_TOTAL_YOCTO = BigInt("250000000000000000000000");

/**
 * M5 · Arm the owner's approved testnet batch (plan §8.4). A batch never approves a payment: every
 * payment still needs its own owner approval. Refused while the kill switch is on.
 */
export async function armTestnetBatch(businessId: string, input: { batchRef: string; maxPayments: number; maxTotalNear: string; expiresInMinutes: number }): Promise<void> {
  const total = nearToYocto(input.maxTotalNear);
  if (BigInt(total) <= BigInt(0) || BigInt(total) > BATCH_MAX_TOTAL_YOCTO) throw new ServiceError("VALIDATION_FAILED", 400, "A batch can move more than 0 and at most 0.25 NEAR (the contract's daily cap).");
  await lockWait(businessId, async () => {
    const out = await runTransact(tx => {
      const b = tx.business(businessId);
      if (!b) return { err: ["NOT_FOUND", 404, "Not found."] as const };
      if (b.kill_switch) return { err: ["KILL_SWITCH_ACTIVE", 409, "Switch the kill switch off before arming a testnet batch."] as const };
      const batch = tx.armBatch({ business_id: businessId, batch_ref: input.batchRef, max_payments: input.maxPayments, max_total_yocto: total, expires_at: new Date(Date.parse(tx.now) + input.expiresInMinutes * 60_000).toISOString() });
      tx.appendEvent(businessId, "owner", "testnet.armed", `batch:${batch.id}`, "armed", businessId, { batch_ref: batch.batch_ref, max_payments: batch.max_payments, max_total_yocto: batch.max_total_yocto, expires_at: batch.expires_at });
      return { ok: true as const };
    });
    if ("err" in out && out.err) throw new ServiceError(out.err[0], out.err[1], out.err[2]);
  });
}

export async function disarmTestnetBatch(businessId: string): Promise<void> {
  await runTransact(tx => {
    if (tx.disarmBatches(businessId, "OWNER") > 0) tx.appendEvent(businessId, "owner", "testnet.disarmed", `business:${businessId}`, "disarmed", businessId, { reason: "OWNER" });
  });
}

/** M5 · Whether a run's payment may be retried by the owner, and how (pure over a read). */
export function retryEligibility(tx: RunTx, run: RunRecord): { allowed: true; attemptId: string; mode: "retry_after_failed" | "resubmit_after_expiry" } | { allowed: false; reason: string } {
  if (run.mode !== "testnet") return { allowed: false, reason: "Only NEAR testnet payments can be retried." };
  if (run.status !== "failed") return { allowed: false, reason: "Only a run whose payment failed can be retried." };
  const req = firstRequest(run.records);
  const attempts = req ? tx.attempts(run.business_id).filter(x => x.request_id === req.request_id) : [];
  const last = attempts.at(-1);
  if (!last) return { allowed: false, reason: "There's no payment attempt to retry." };
  if (attempts.length >= 3) return { allowed: false, reason: "This payment has been tried three times; start a new run instead." };
  // Only PROVEN outcomes: the contract recorded the payout as Failed (funds refunded), or the signed
  // transaction's window closed by block height with no contract record. Never an unknown outcome.
  if (last.status === "failed_onchain" && last.error?.code === "PAYOUT_FAILED") return { allowed: true, attemptId: last.id, mode: "retry_after_failed" };
  if (last.status === "expired_unexecuted") return { allowed: true, attemptId: last.id, mode: "resubmit_after_expiry" };
  if (last.status === "failed_onchain") return { allowed: false, reason: "The contract rejected this request, so retrying it would be rejected again. Fix the cause and start a new run." };
  return { allowed: false, reason: "This payment's outcome isn't a proven failure, so it can't be retried." };
}

/**
 * M5 · Manual retry (R12, §11.1). Reopens the run at its security check: fresh chain checks, a fresh gate
 * decision and a NEW owner approval are required, counted against the batch armed now. Nothing is
 * signed here; the signer later re-checks the contract-side condition for the retry mode.
 */
export async function requestPaymentRetry(businessId: string, runId: string): Promise<void> {
  const av = await getPaymentChain();
  if (!av.ok) throw new ServiceError(av.code, 503, av.message);
  await lockWait(businessId, async () => {
    const out = await runTransact(tx => {
      const run = tx.run(businessId, runId);
      if (!run) return { err: ["NOT_FOUND", 404, "That run doesn't exist."] as const };
      const e = retryEligibility(tx, run);
      if (!e.allowed) return { err: ["RETRY_NOT_ALLOWED", 409, e.reason] as const };
      if (tx.business(businessId)?.kill_switch) return { err: ["KILL_SWITCH_ACTIVE", 409, "Switch the kill switch off first."] as const };
      if (tx.runs(businessId).some(r => r.id !== runId && ACTIVE_RUN_STATUSES.includes(r.status))) return { err: ["RUN_IN_PROGRESS", 409, "Another run is in progress for this business."] as const };
      const wf = tx.workflows(businessId).find(w => w.id === run.workflow_id);
      if (!wf || wf.status !== "approved" || workflowFingerprint(wf) !== run.approval_fingerprint) return { err: ["WORKFLOW_CHANGED", 409, "The approved workflow changed, so this run can't be retried."] as const };
      const batch = tx.armedBatch(businessId);
      if (!batch || batch.payments_used >= batch.max_payments) return { err: ["BATCH_NOT_ARMED", 409, "Arm an approved testnet batch with capacity for the retry first."] as const };
      const check = wf.steps.steps.find(s => s.type === "security_check");
      if (!check) return { err: ["RETRY_NOT_ALLOWED", 409, "This workflow has no security check to re-run."] as const };
      const ok = tx.patchRun(businessId, runId, {
        status: "running", cursor: check.id, end_reason: null, ended_at: null, elapsed_ms: null, error: null, summary: null, lease_expires_at: null,
        batch_id: batch.id, payment_retry: { of_attempt: e.attemptId, mode: e.mode, requested_at: tx.now },
      }, { status: ["failed"] });
      if (!ok) return { err: ["RETRY_NOT_ALLOWED", 409, "The run changed; try again."] as const };
      tx.appendEvent(businessId, "owner", "payment.retry_requested", `attempt:${e.attemptId}`, "running", runId, { mode: e.mode, batch: batch.batch_ref });
      return { ok: true as const };
    });
    if ("err" in out && out.err) throw new ServiceError(out.err[0], out.err[1], out.err[2]);
  });
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
