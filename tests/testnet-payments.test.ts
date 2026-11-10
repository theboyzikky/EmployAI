// M5 Phase 4 · Testnet payments through the runner, with a FAKE PaymentChain (no network, no key).
// Covers: approval always required and bound to the exact payment, fresh checks before signing,
// write-ahead before broadcast, unknown outcomes reconciled (never blind retries), restart recovery
// that never re-signs a persisted transaction, kill switch at each point, concurrency, and the views.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { setDiscoveryRepository } from "@/lib/discovery/store";
import { setPaymentChainForTests, type ChainVerdict, type PaymentChain, type ReconcileOutcome, type SignOutcome } from "@/lib/runs/payment-port";
import { runRead, runTransact } from "@/lib/runs/repo";
import { advanceRun, armTestnetBatch, decideApproval, nearToYocto, requestControl, requestPaymentRetry, setKillSwitch, startRun } from "@/lib/runs/runner";
import type { ScenarioKey } from "@/lib/runs/types";
import { buildRunView } from "@/lib/runs/view";
import { readyRestaurant, tempStore } from "./helpers/run-fixture";
import { blockedFetch } from "./setup";

// Each test drives a whole run through the file store many times: allow for a loaded machine.
vi.setConfig({ testTimeout: 20_000 });

const T = "treasury.employai-demo.testnet";
const AGENT = "finance-agent.employai-demo.testnet";
const S1 = "supplier-1.employai-demo.testnet";
const S2 = "supplier-2.employai-demo.testnet";
const NEAR_0_031 = "31000000000000000000000";

type FakeState = {
  failures: Array<{ code: string; detail: string }>;
  precheckThrows: boolean;
  spent: string;
  npv: string;
  sign: (n: number) => Promise<SignOutcome>;
  broadcast: (bytes: string, n: number) => Promise<ChainVerdict>;
  reconcile: ReconcileOutcome[];
};

function fakeChain(over: Partial<FakeState> = {}) {
  const calls = { precheck: 0, npv: 0, sign: 0, broadcast: 0, reconcile: 0 };
  const sent: string[] = [];
  const signInputs: Array<Parameters<PaymentChain["sign"]>[0]> = [];
  const st: FakeState = {
    failures: [], precheckThrows: false, spent: "0", npv: "npv-1",
    sign: async n => ({ ok: true, signed: { txHash: `tx-${n}`, signedTxBase64: `bytes-${n}`, nonce: `${276931238000000 + n}`, publicKey: "ed25519:fake", blockHash: "blockhash", signedBlockHeight: 1_000, validityPeriodBlocks: 86_400, expiresAfterHeight: 87_400 } }),
    broadcast: async (_b, n) => ({ outcome: "confirmed", txHash: `tx-${n}`, gasBurnt: 2_400_000_000_000, evidence: { final_execution_status: "FINAL" } }),
    reconcile: [],
    ...over,
  };
  let lastSigned = 0;
  const chain: PaymentChain = {
    target: { network: "testnet", contractId: T, expectedCodeHash: "HvewFdJa6y2jaJxWn5oU4VckoUDhXo61fKyvd9VFBDJt", agent: AGENT },
    async precheck() {
      calls.precheck++;
      if (st.precheckThrows) throw new Error("rpc down");
      return { failures: st.failures, onchainSpentTodayYocto: st.spent, nearPolicyVersion: st.npv, onchainLimits: { maxPerTxYocto: "100000000000000000000000", dailyCapYocto: "250000000000000000000000" }, checkedAt: new Date().toISOString() };
    },
    async nearPolicyVersion() { calls.npv++; return st.npv; },
    async sign(input) { calls.sign++; signInputs.push(input); lastSigned = calls.sign; return st.sign(calls.sign); },
    async broadcast(i) { calls.broadcast++; sent.push(i.signedTxBase64); return st.broadcast(i.signedTxBase64, lastSigned || 1); },
    async reconcile() { calls.reconcile++; return st.reconcile.shift() ?? { action: "wait", reason: "request is Pending on-chain; never resubmit" }; },
  };
  setPaymentChainForTests(chain);
  return { chain, calls, sent, st, signInputs };
}

beforeEach(() => setPaymentChainForTests(null));
afterEach(() => { setDiscoveryRepository(null); setPaymentChainForTests(null); });

let keySeq = 0;
async function setup(batch: { payments?: number; near?: string } | null = {}) {
  const t = tempStore();
  const r = await readyRestaurant(t.store);
  if (batch) await armTestnetBatch(r.businessId, { batchRef: "B3", maxPayments: batch.payments ?? 3, maxTotalNear: batch.near ?? "0.25", expiresInMinutes: 60 });
  return { ...t, ...r };
}
const startTestnet = (b: string, w: string, scenario: ScenarioKey = "standard") =>
  startRun(b, { workflowId: w, scenario, idempotencyKey: `tn-${++keySeq}`, mode: "testnet", confirmRealTransactions: true });
const state = (b: string, runId: string) => runRead(b, tx => ({
  run: tx.run(b, runId)!, steps: tx.steps(runId), decisions: tx.decisions(b).filter(d => d.run_id === runId), approvals: tx.approvals(b).filter(a => a.run_id === runId),
  attempts: tx.attempts(b).filter(a => a.run_id === runId), ledger: tx.ledger(b).filter(l => l.run_id === runId), events: tx.events(b).filter(e => e.correlation_id === runId), batch: tx.batches(b).at(-1),
}));
async function advanceUntil(b: string, runId: string, done: (s: Awaited<ReturnType<typeof state>>) => boolean, max = 25) {
  for (let i = 0; i < max; i++) {
    const s = await state(b, runId);
    if (done(s)) return s;
    await advanceRun(b, runId);
  }
  return state(b, runId);
}
const toApproval = (b: string, runId: string) => advanceUntil(b, runId, s => s.run.status !== "running");
const toEnd = (b: string, runId: string) => advanceUntil(b, runId, s => !["running"].includes(s.run.status) && !s.attempts.some(a => !["confirmed", "failed_onchain", "aborted", "expired_unexecuted"].includes(a.status)));
async function approved(b: string, runId: string) {
  const s = await toApproval(b, runId);
  expect(s.run.status).toBe("waiting_approval");
  await decideApproval(b, s.approvals.at(-1)!.id, "approve");
  return s;
}

describe("starting a testnet run", () => {
  test("needs explicit confirmation, an available chain and an armed batch", async () => {
    const { businessId, workflow } = await setup(null);
    await expect(startRun(businessId, { workflowId: workflow.id, scenario: "standard", idempotencyKey: "k-1", mode: "testnet" })).rejects.toMatchObject({ code: "CONFIRMATION_REQUIRED" });
    await expect(startTestnet(businessId, workflow.id)).rejects.toMatchObject({ code: "TESTNET_UNAVAILABLE", status: 503 });
    fakeChain();
    await expect(startTestnet(businessId, workflow.id)).rejects.toMatchObject({ code: "BATCH_NOT_ARMED" });
    await armTestnetBatch(businessId, { batchRef: "B3", maxPayments: 1, maxTotalNear: "0.1", expiresInMinutes: 30 });
    const { runId } = await startTestnet(businessId, workflow.id);
    expect((await state(businessId, runId)).run).toMatchObject({ mode: "testnet", status: "running", expected: { decision: "WARN", end: "approval" } });
  });

  test("batch arming is validated and refused while the kill switch is on", async () => {
    const { businessId } = await setup(null);
    await expect(armTestnetBatch(businessId, { batchRef: "B3", maxPayments: 1, maxTotalNear: "0.3", expiresInMinutes: 30 })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await setKillSwitch(businessId, true);
    await expect(armTestnetBatch(businessId, { batchRef: "B3", maxPayments: 1, maxTotalNear: "0.1", expiresInMinutes: 30 })).rejects.toMatchObject({ code: "KILL_SWITCH_ACTIVE" });
    expect(nearToYocto("0.031")).toBe(NEAR_0_031);
    expect(nearToYocto("0.25")).toBe("250000000000000000000000");
  });

  test("a test run makes ZERO chain calls even with a chain registered", async () => {
    const { calls } = fakeChain();
    const { businessId, workflow } = await setup();
    const { runId } = await startRun(businessId, { workflowId: workflow.id, scenario: "standard", idempotencyKey: "tr-1" });
    await advanceUntil(businessId, runId, s => s.run.status !== "running");
    expect((await state(businessId, runId)).run.status).toBe("completed");
    expect(calls).toEqual({ precheck: 0, npv: 0, sign: 0, broadcast: 0, reconcile: 0 });
  });
});

describe("approval: always required, exact, once", () => {
  test("S1 · first payout to supplier-1: WARN → owner approves → signed, written ahead, sent, verified, completed", async () => {
    const { calls, sent } = fakeChain();
    const { businessId, workflow } = await setup();
    const { runId } = await startTestnet(businessId, workflow.id);
    let s = await toApproval(businessId, runId);
    expect(s.run.status).toBe("waiting_approval");
    expect(s.decisions).toMatchObject([{ decision: "WARN", reason_codes: ["FIRST_INTERACTION"], mode: "testnet", signals: { chain_checks: "run", mode: "testnet", near_policy_version: "npv-1" } }]);
    expect(s.approvals).toMatchObject([{ status: "pending", auto_approved: false, mode: "testnet", recipient_account: S1, amount_yocto: NEAR_0_031,
      binding: { recipient_account_id: S1, amount_yocto: NEAR_0_031, amount_ngn_business: 42_780, contract_id: T, agent_account_id: AGENT, network: "testnet", method: "request_payment", near_policy_version: "npv-1" } }]);
    expect(calls.sign).toBe(0);                                         // nothing signed before approval
    await decideApproval(businessId, s.approvals[0].id, "approve");
    s = await toEnd(businessId, runId);
    expect(s.run).toMatchObject({ status: "completed", end_reason: "completed" });
    expect(calls).toMatchObject({ sign: 1, broadcast: 1 });
    expect(sent).toEqual(["bytes-1"]);
    expect(s.attempts).toMatchObject([{ status: "confirmed", tx_hash: "tx-1", recipient: S1, amount_yocto: NEAR_0_031, signed_tx_b64: null, broadcasts: 1 }]);
    expect(s.approvals[0].consumed_at).toBeTruthy();
    expect(s.ledger).toEqual([expect.objectContaining({ mode: "testnet", unit: "yoctoNEAR", amount: NEAR_0_031, amount_ngn_business: 42_780, counterparty: S1, tx_hash: "tx-1", tx_status: "confirmed", label: "NEAR testnet · real transaction" })]);
    const types = s.events.map(e => e.type);
    expect(types.indexOf("payment.prepared")).toBeLessThan(types.indexOf("payment.signed"));
    expect(types.indexOf("payment.signed")).toBeLessThan(types.indexOf("payment.confirmed"));   // write-ahead before the outcome
    expect(s.batch).toMatchObject({ payments_used: 1, yocto_used: NEAR_0_031 });
    expect(s.run.summary).toMatch(/Paid 0\.031 NEAR on NEAR testnet to supplier-1/);
    expect(blockedFetch).not.toHaveBeenCalled();
  });

  test("S2 · ALLOW (supplier paid before) still waits for the owner: 0 signatures without approval", async () => {
    const { calls } = fakeChain();
    const { businessId, workflow } = await setup();
    const first = await startTestnet(businessId, workflow.id);
    await approved(businessId, first.runId);
    await toEnd(businessId, first.runId);
    const { runId } = await startTestnet(businessId, workflow.id);
    const s = await toApproval(businessId, runId);
    expect(s.decisions[0]).toMatchObject({ decision: "ALLOW", reason_codes: [] });
    expect(s.approvals[0]).toMatchObject({ status: "pending", auto_approved: false });
    expect(calls.sign).toBe(1);                                         // only the first run's payment
  });

  test("S3 · the owner rejects: no signature, run rejected", async () => {
    const { calls } = fakeChain();
    const { businessId, workflow } = await setup();
    const { runId } = await startTestnet(businessId, workflow.id);
    const s = await toApproval(businessId, runId);
    await decideApproval(businessId, s.approvals[0].id, "reject");
    const end = await toEnd(businessId, runId);
    expect(end.run.status).toBe("rejected");
    expect(calls).toMatchObject({ sign: 0, broadcast: 0 });
    expect(end.attempts).toEqual([]);
  });

  test("S4 · over the per-payment limit in both currencies: BLOCK, no approval possible, 0 signatures", async () => {
    const { calls } = fakeChain();
    const { businessId, workflow } = await setup();
    const { runId } = await startTestnet(businessId, workflow.id, "price_spike");
    const s = await toEnd(businessId, runId);
    expect(s.run.status).toBe("blocked");
    expect(s.decisions[0]).toMatchObject({ decision: "BLOCK", reason_codes: ["OVER_TX_LIMIT"] });
    expect(s.approvals).toEqual([]);
    expect(calls.sign).toBe(0);
  });

  test.each([
    ["S6 · recipient not on the on-chain allowlist", "RECIPIENT_NOT_APPROVED_ONCHAIN"],
    ["treasury paused", "TREASURY_PAUSED"],
    ["unsafe signing key", "SIGNER_KEY_UNSAFE"],
    ["code hash mismatch", "TREASURY_CODE_MISMATCH"],
  ])("%s: BLOCK before any approval, 0 signatures", async (_l, code) => {
    const { calls } = fakeChain({ failures: [{ code, detail: "fake" }] });
    const { businessId, workflow } = await setup();
    const { runId } = await startTestnet(businessId, workflow.id);
    const s = await toEnd(businessId, runId);
    expect(s.run.status).toBe("blocked");
    expect(s.decisions[0]).toMatchObject({ decision: "BLOCK", reason_codes: [code] });
    expect(s.approvals).toEqual([]);
    expect(calls.sign).toBe(0);
  });

  test("an unreachable chain at the security check blocks (never ALLOW on missing signals)", async () => {
    fakeChain({ precheckThrows: true });
    const { businessId, workflow } = await setup();
    const { runId } = await startTestnet(businessId, workflow.id);
    const s = await toEnd(businessId, runId);
    expect(s.decisions[0]).toMatchObject({ decision: "BLOCK", reason_codes: ["CHAIN_UNAVAILABLE"] });
  });

  test("the NEAR daily limit counts the contract's own total: 0.24 NEAR spent today → BLOCK OVER_DAILY_LIMIT", async () => {
    const { calls } = fakeChain({ spent: "240000000000000000000000" });
    const { businessId, workflow } = await setup();
    const { runId } = await startTestnet(businessId, workflow.id);
    const s = await toEnd(businessId, runId);
    expect(s.decisions[0]).toMatchObject({ decision: "BLOCK", reason_codes: ["OVER_DAILY_LIMIT"] });
    expect(calls.sign).toBe(0);
  });

  test("a disarmed batch at the approve click invalidates the approval (nothing signed)", async () => {
    const { calls } = fakeChain();
    const { businessId, workflow } = await setup();
    const { runId } = await startTestnet(businessId, workflow.id);
    const s = await toApproval(businessId, runId);
    await runTransact(businessId, tx => tx.disarmBatches(businessId, "TEST"));
    await expect(decideApproval(businessId, s.approvals[0].id, "approve")).rejects.toMatchObject({ code: "BATCH_NOT_ARMED" });
    const end = await state(businessId, runId);
    expect(end.approvals[0].status).toBe("invalidated");
    expect(end.run).toMatchObject({ status: "failed", end_reason: "BATCH_NOT_ARMED" });
    expect(calls.sign).toBe(0);
  });

  test("a changed bound field at the click (the request's amount) → APPROVAL_STALE, nothing signed", async () => {
    const { calls } = fakeChain();
    const { businessId, workflow } = await setup();
    const { runId } = await startTestnet(businessId, workflow.id);
    const s = await toApproval(businessId, runId);
    await runTransact(businessId, tx => {
      const r = tx.run(businessId, runId)!;
      const reqs = r.records.payment_requests as Array<Record<string, unknown>>;
      reqs[0].amount_yocto = "90000000000000000000000";            // tampered after approval was requested
      tx.patchRun(businessId, runId, { records: r.records });
    });
    await expect(decideApproval(businessId, s.approvals[0].id, "approve")).rejects.toMatchObject({ code: "APPROVAL_STALE" });
    expect((await state(businessId, runId)).run.status).toBe("failed");
    expect(calls.sign).toBe(0);
  });

  test("an on-chain policy change between approval and signing → APPROVAL_STALE, 0 signatures", async () => {
    const { calls, st } = fakeChain();
    const { businessId, workflow } = await setup();
    const { runId } = await startTestnet(businessId, workflow.id);
    await approved(businessId, runId);
    st.npv = "npv-2";                                                    // e.g. the owner changed max_per_tx on-chain
    const s = await toEnd(businessId, runId);
    expect(s.attempts).toMatchObject([{ status: "aborted", error: { code: "APPROVAL_STALE" } }]);
    expect(s.attempts[0].error!.message).toMatch(/near_policy_version/);
    expect(s.run).toMatchObject({ status: "failed", end_reason: "APPROVAL_STALE" });
    expect(calls).toMatchObject({ sign: 0, broadcast: 0 });
    expect(s.ledger).toEqual([]);
  });

  test("a batch for one payment allows exactly one; the next run is refused", async () => {
    fakeChain();
    const { businessId, workflow } = await setup({ payments: 1, near: "0.1" });
    const a = await startTestnet(businessId, workflow.id);
    await approved(businessId, a.runId);
    await toEnd(businessId, a.runId);
    await expect(startTestnet(businessId, workflow.id)).rejects.toMatchObject({ code: "BATCH_LIMIT_REACHED" });
  });
});

describe("signing failures are classified and bounded", () => {
  test("a transient chain error before signing retries (bounded), then 'Payment not sent'", async () => {
    const { calls } = fakeChain({ sign: async () => ({ ok: false, code: "CHAIN_UNAVAILABLE", detail: "rpc down", transient: true }) });
    const { businessId, workflow } = await setup();
    const { runId } = await startTestnet(businessId, workflow.id);
    await approved(businessId, runId);
    const s = await toEnd(businessId, runId);
    expect(calls.sign).toBe(3);
    expect(s.attempts).toMatchObject([{ status: "aborted", pre_sign_errors: 2, error: { code: "CHAIN_UNAVAILABLE" } }]);
    expect(s.attempts[0].error!.message).toMatch(/Payment not sent after 3 tries/);
    expect(calls.broadcast).toBe(0);
    expect(s.run.status).toBe("blocked");
  });

  test.each(["SIGNER_KEY_UNSAFE", "SIGNING_FAILED", "DUPLICATE_REQUEST", "RECIPIENT_NOT_APPROVED_ONCHAIN"])("a signer refusal %s is final: aborted, nothing sent", async code => {
    const { calls } = fakeChain({ sign: async () => ({ ok: false, code, detail: "fake", transient: false }) });
    const { businessId, workflow } = await setup();
    const { runId } = await startTestnet(businessId, workflow.id);
    await approved(businessId, runId);
    const s = await toEnd(businessId, runId);
    expect(s.attempts).toMatchObject([{ status: "aborted", error: { code } }]);
    expect(calls).toMatchObject({ sign: 1, broadcast: 0 });
    expect(s.ledger).toEqual([]);
  });
});

describe("outcomes: verified success only; unknown is reconciled, never retried blindly", () => {
  test("broadcast timeout → unknown (no success, no ledger) → reconciled from the contract → confirmed", async () => {
    const { calls, st } = fakeChain({ broadcast: async () => ({ outcome: "unknown", reason: "broadcast outcome unknown (TIMEOUT)" }) });
    const { businessId, workflow } = await setup();
    const { runId } = await startTestnet(businessId, workflow.id);
    await approved(businessId, runId);
    await advanceRun(businessId, runId);
    let s = await state(businessId, runId);
    expect(s.attempts).toMatchObject([{ status: "unknown", tx_hash: "tx-1", signed_tx_b64: "bytes-1" }]);
    expect(s.run.status).toBe("running");
    expect(s.ledger).toEqual([]);
    st.reconcile.push({ action: "wait", reason: "request is Pending on-chain; never resubmit" });
    await advanceRun(businessId, runId);
    s = await state(businessId, runId);
    expect(s.attempts[0]).toMatchObject({ status: "unknown" });
    expect(s.attempts[0].checks.at(-1)).toMatchObject({ result: "wait" });
    st.reconcile.push({ action: "settled", verdict: { outcome: "confirmed", txHash: "tx-1", gasBurnt: 1, evidence: {} } });
    s = await toEnd(businessId, runId);
    expect(s.run.status).toBe("completed");
    expect(s.attempts[0]).toMatchObject({ status: "confirmed" });
    expect(s.ledger).toHaveLength(1);
    expect(calls).toMatchObject({ sign: 1, broadcast: 1 });            // never re-signed, never re-sent blindly
  });

  test("validity window open → re-broadcast of the IDENTICAL bytes only (same hash, never a new signature)", async () => {
    const { calls, sent, st } = fakeChain({ broadcast: async () => ({ outcome: "unknown", reason: "TRANSPORT" }) });
    const { businessId, workflow } = await setup();
    const { runId } = await startTestnet(businessId, workflow.id);
    await approved(businessId, runId);
    await advanceRun(businessId, runId);
    st.broadcast = async () => ({ outcome: "confirmed", txHash: "tx-1", gasBurnt: 1, evidence: {} });
    st.reconcile.push({ action: "rebroadcast" });
    const s = await toEnd(businessId, runId);
    expect(sent).toEqual(["bytes-1", "bytes-1"]);
    expect(calls.sign).toBe(1);
    expect(s.attempts[0]).toMatchObject({ status: "confirmed", broadcasts: 2 });
    expect(s.ledger).toHaveLength(1);
  });

  test("window closed by block height with no contract record → expired_unexecuted, run failed, nothing paid", async () => {
    const { calls, st } = fakeChain({ broadcast: async () => ({ outcome: "unknown", reason: "TIMEOUT" }) });
    const { businessId, workflow } = await setup();
    const { runId } = await startTestnet(businessId, workflow.id);
    await approved(businessId, runId);
    await advanceRun(businessId, runId);
    st.reconcile.push({ action: "expired_unexecuted", detail: "past the window, no record" });
    const s = await toEnd(businessId, runId);
    expect(s.attempts[0]).toMatchObject({ status: "expired_unexecuted", signed_tx_b64: null });
    expect(s.run).toMatchObject({ status: "failed", end_reason: "PAYMENT_NOT_SENT" });
    expect(s.ledger).toEqual([]);
    expect(calls.sign).toBe(1);
  });

  test("a failed payout (callback false) is failed, not pending or paid: failed ledger row, run failed", async () => {
    fakeChain({ broadcast: async () => ({ outcome: "failed_onchain", kind: "transfer_failed", detail: "refunded", txHash: "tx-1", evidence: {} }) });
    const { businessId, workflow } = await setup();
    const { runId } = await startTestnet(businessId, workflow.id);
    await approved(businessId, runId);
    const s = await toEnd(businessId, runId);
    expect(s.attempts[0]).toMatchObject({ status: "failed_onchain", error: { code: "PAYOUT_FAILED" } });
    expect(s.ledger).toEqual([expect.objectContaining({ tx_status: "failed", label: "Failed on-chain" })]);
    expect(s.run).toMatchObject({ status: "failed", end_reason: "PAYOUT_FAILED" });
  });

  test("a contract rejection is recorded as such", async () => {
    fakeChain({ broadcast: async () => ({ outcome: "failed_onchain", kind: "contract_rejected", detail: "Smart contract panicked: Paused", txHash: "tx-1", evidence: {} }) });
    const { businessId, workflow } = await setup();
    const { runId } = await startTestnet(businessId, workflow.id);
    await approved(businessId, runId);
    const s = await toEnd(businessId, runId);
    expect(s.attempts[0]).toMatchObject({ status: "failed_onchain", error: { code: "CONTRACT_REJECTED" } });
    expect(s.run.end_reason).toBe("CONTRACT_REJECTED");
  });

  test("an RPC-reported hash that differs from the signed hash is never accepted as success", async () => {
    fakeChain({ broadcast: async () => ({ outcome: "confirmed", txHash: "some-other-hash", gasBurnt: 1, evidence: {} }) });
    const { businessId, workflow } = await setup();
    const { runId } = await startTestnet(businessId, workflow.id);
    await approved(businessId, runId);
    await advanceRun(businessId, runId);
    const s = await state(businessId, runId);
    expect(s.attempts[0]).toMatchObject({ status: "unknown", error: { code: "OUTCOME_UNKNOWN" } });
    expect(s.ledger).toEqual([]);
  });
});

describe("manual retry (R12, §11.1): proven failures only, fresh checks and a NEW approval", () => {
  const failedPayout = async (_b: string, n: number) => ({ outcome: "failed_onchain", kind: "transfer_failed", detail: "refunded", txHash: `tx-${n}`, evidence: {} }) as ChainVerdict;

  test("a refunded payout can be retried: fresh security check, new approval, retry mode, then paid once", async () => {
    const f = fakeChain({ broadcast: failedPayout });
    const { businessId, workflow } = await setup();
    const { runId } = await startTestnet(businessId, workflow.id);
    await approved(businessId, runId);
    let s = await toEnd(businessId, runId);
    expect(s.run).toMatchObject({ status: "failed", end_reason: "PAYOUT_FAILED" });
    const decisionsBefore = s.decisions.length;
    await requestPaymentRetry(businessId, runId);
    s = await toApproval(businessId, runId);
    expect(s.run.status).toBe("waiting_approval");                       // a NEW approval is required
    expect(s.decisions.length).toBe(decisionsBefore + 1);                 // a fresh gate decision (with fresh chain checks)
    expect(s.decisions.at(-1)!.decision).not.toBe("BLOCK");               // its own earlier decision isn't a "duplicate"
    expect(s.approvals.filter(a => a.status === "pending")).toHaveLength(1);
    expect(f.calls.sign).toBe(1);                                         // nothing signed before the new approval
    f.st.broadcast = async (_b, n) => ({ outcome: "confirmed", txHash: `tx-${n}`, gasBurnt: 1, evidence: {} });
    await decideApproval(businessId, s.approvals.at(-1)!.id, "approve");
    s = await toEnd(businessId, runId);
    expect(s.run.status).toBe("completed");
    expect(f.signInputs.map(i => i.mode)).toEqual(["new", "retry_after_failed"]);
    expect(s.attempts.map(a => [a.status, a.sign_mode ?? "new"])).toEqual([["failed_onchain", "new"], ["confirmed", "retry_after_failed"]]);
    expect(s.attempts[1].retry_of).toBe(s.attempts[0].id);
    expect(s.ledger.map(l => (l as { tx_status: string }).tx_status)).toEqual(["failed", "confirmed"]);   // one success, the failure kept
  });

  test("an expired-unexecuted payment is resubmitted only with the old validity window passed to the signer", async () => {
    const f = fakeChain({ broadcast: async () => ({ outcome: "unknown", reason: "TIMEOUT" }) });
    const { businessId, workflow } = await setup();
    const { runId } = await startTestnet(businessId, workflow.id);
    await approved(businessId, runId);
    await advanceRun(businessId, runId);
    f.st.reconcile.push({ action: "expired_unexecuted", detail: "window closed, no record" });
    await toEnd(businessId, runId);
    await requestPaymentRetry(businessId, runId);
    const s = await toApproval(businessId, runId);
    f.st.broadcast = async (_b, n) => ({ outcome: "confirmed", txHash: `tx-${n}`, gasBurnt: 1, evidence: {} });
    await decideApproval(businessId, s.approvals.at(-1)!.id, "approve");
    const end = await toEnd(businessId, runId);
    expect(end.run.status).toBe("completed");
    expect(f.signInputs.at(-1)).toMatchObject({ mode: "resubmit_after_expiry", previousExpiresAfterHeight: 87_400 });
  });

  test("never for an uncertain outcome: an unknown attempt can't be retried (it reconciles)", async () => {
    fakeChain({ broadcast: async () => ({ outcome: "unknown", reason: "TIMEOUT" }) });
    const { businessId, workflow } = await setup();
    const { runId } = await startTestnet(businessId, workflow.id);
    await approved(businessId, runId);
    await advanceRun(businessId, runId);
    await expect(requestPaymentRetry(businessId, runId)).rejects.toMatchObject({ code: "RETRY_NOT_ALLOWED" });
  });

  test("never for a contract rejection, and never after a success", async () => {
    fakeChain({ broadcast: async () => ({ outcome: "failed_onchain", kind: "contract_rejected", detail: "Paused", txHash: "tx-1", evidence: {} }) });
    const a = await setup();
    const r1 = await startTestnet(a.businessId, a.workflow.id);
    await approved(a.businessId, r1.runId);
    await toEnd(a.businessId, r1.runId);
    await expect(requestPaymentRetry(a.businessId, r1.runId)).rejects.toMatchObject({ code: "RETRY_NOT_ALLOWED" });
    fakeChain();
    const b = await setup();
    const r2 = await startTestnet(b.businessId, b.workflow.id);
    await approved(b.businessId, r2.runId);
    await toEnd(b.businessId, r2.runId);
    await expect(requestPaymentRetry(b.businessId, r2.runId)).rejects.toMatchObject({ code: "RETRY_NOT_ALLOWED" });
  });

  test("refused while the kill switch is on, or without an armed batch with capacity", async () => {
    fakeChain({ broadcast: failedPayout });
    const { businessId, workflow } = await setup({ payments: 1, near: "0.1" });
    const { runId } = await startTestnet(businessId, workflow.id);
    await approved(businessId, runId);
    await toEnd(businessId, runId);
    await expect(requestPaymentRetry(businessId, runId)).rejects.toMatchObject({ code: "BATCH_NOT_ARMED" });   // batch used up
    await armTestnetBatch(businessId, { batchRef: "B4", maxPayments: 1, maxTotalNear: "0.1", expiresInMinutes: 30 });
    await setKillSwitch(businessId, true);
    await expect(requestPaymentRetry(businessId, runId)).rejects.toMatchObject({ code: "KILL_SWITCH_ACTIVE" });
  });

  test("at most three attempts per payment", async () => {
    const f = fakeChain({ broadcast: failedPayout });
    const { businessId, workflow } = await setup({ payments: 5, near: "0.25" });
    const { runId } = await startTestnet(businessId, workflow.id);
    await approved(businessId, runId);
    await toEnd(businessId, runId);
    for (let i = 0; i < 2; i++) {
      await requestPaymentRetry(businessId, runId);
      const s = await toApproval(businessId, runId);
      await decideApproval(businessId, s.approvals.at(-1)!.id, "approve");
      await toEnd(businessId, runId);
    }
    expect(f.calls.sign).toBe(3);
    await expect(requestPaymentRetry(businessId, runId)).rejects.toMatchObject({ code: "RETRY_NOT_ALLOWED" });
  });
});

describe("restart recovery: a persisted signature is never signed again", () => {
  async function withAttempt(status: "signed" | "submitting" | "signing", over: Record<string, unknown> = {}) {
    const fake = fakeChain();
    const { businessId, workflow } = await setup();
    const { runId } = await startTestnet(businessId, workflow.id);
    await approved(businessId, runId);
    // Phase A only (as if the server stopped right after it): sign nothing yet.
    const realSign = fake.chain.sign;
    fake.chain.sign = async () => ({ ok: false, code: "CHAIN_UNAVAILABLE", detail: "setup", transient: true });
    await advanceRun(businessId, runId);
    fake.chain.sign = realSign;
    fake.calls.sign = 0;
    const id = (await state(businessId, runId)).attempts[0].id;
    // The crashed process left the attempt mid-way with a lease that has expired.
    await runTransact(businessId, tx => tx.patchAttempt(businessId, id, ["prepared"], {
      status, lease_owner: "dead-process", lease_expires_at: "2000-01-01T00:00:00.000Z", pre_sign_errors: 0,
      ...(status !== "signing" ? { tx_hash: "tx-persisted", signed_tx_b64: "bytes-persisted", nonce: "276931238000009", signed_block_height: 1000, validity_period_blocks: 86400, expires_after_height: 87400 } : {}),
      ...over,
    }));
    return { ...fake, businessId, runId, id };
  }

  test("signed (written ahead, never sent): the next advance sends the PERSISTED bytes, no new signature", async () => {
    const f = await withAttempt("signed");
    f.st.broadcast = async () => ({ outcome: "confirmed", txHash: "tx-persisted", gasBurnt: 1, evidence: {} });
    const s = await toEnd(f.businessId, f.runId);
    expect(f.calls.sign).toBe(0);
    expect(f.sent).toEqual(["bytes-persisted"]);
    expect(s.attempts[0]).toMatchObject({ status: "confirmed", tx_hash: "tx-persisted" });
    expect(s.run.status).toBe("completed");
  });

  test("submitting (crashed mid-broadcast): treated as UNKNOWN and reconciled; no new signature", async () => {
    const f = await withAttempt("submitting");
    f.st.reconcile.push({ action: "settled", verdict: { outcome: "confirmed", txHash: "tx-persisted", gasBurnt: 1, evidence: {} } });
    const s = await toEnd(f.businessId, f.runId);
    expect(f.calls).toMatchObject({ sign: 0, reconcile: 1 });
    expect(s.attempts[0]).toMatchObject({ status: "confirmed" });
    expect(s.events.some(e => e.type === "payment.unknown")).toBe(true);
  });

  test("signing (crashed before the write-ahead): nothing was persisted or sent, so it is signed once now", async () => {
    const f = await withAttempt("signing");
    const s = await toEnd(f.businessId, f.runId);
    expect(f.calls.sign).toBe(1);
    expect(s.attempts[0]).toMatchObject({ status: "confirmed" });
  });

  test("a live lease held by another driver is respected (no second driver)", async () => {
    const f = await withAttempt("signed", { lease_owner: "other-live-driver", lease_expires_at: "2999-01-01T00:00:00.000Z" });
    await advanceRun(f.businessId, f.runId);
    expect(f.calls).toMatchObject({ sign: 0, broadcast: 0 });
    expect((await state(f.businessId, f.runId)).attempts[0].status).toBe("signed");
  });
});

describe("kill switch and stop (§14)", () => {
  test("kill switch while waiting for approval: run cancelled, approval invalidated, batch disarmed, 0 signatures", async () => {
    const { calls } = fakeChain();
    const { businessId, workflow } = await setup();
    const { runId } = await startTestnet(businessId, workflow.id);
    await toApproval(businessId, runId);
    await setKillSwitch(businessId, true);
    const s = await state(businessId, runId);
    expect(s.run.status).toBe("cancelled");
    expect(s.approvals[0].status).toBe("invalidated");
    expect(s.batch!.disarmed_at).toBeTruthy();
    expect(calls.sign).toBe(0);
  });

  test("kill switch switched on while the signer works: the signature is discarded, never written ahead or sent", async () => {
    const f = fakeChain();
    const { businessId, workflow } = await setup();
    const { runId } = await startTestnet(businessId, workflow.id);
    await approved(businessId, runId);
    const realSign = f.st.sign;
    f.st.sign = async n => { await setKillSwitch(businessId, true); return realSign(n); };
    await advanceRun(businessId, runId);
    const s = await state(businessId, runId);
    expect(f.calls).toMatchObject({ sign: 1, broadcast: 0 });
    expect(s.attempts[0]).toMatchObject({ status: "aborted", signed_tx_b64: null, error: { code: "KILL_SWITCH_ACTIVE" } });
    expect(s.attempts[0].tx_hash).toBeNull();
    expect(s.run.status).toBe("cancelled");
  });

  test("kill switch after the write-ahead, before broadcast: the bytes are discarded and never sent", async () => {
    const f = fakeChain();
    const { businessId, workflow } = await setup();
    const { runId } = await startTestnet(businessId, workflow.id);
    await approved(businessId, runId);
    f.chain.sign = async () => ({ ok: false, code: "CHAIN_UNAVAILABLE", detail: "x", transient: true });
    await advanceRun(businessId, runId);                                // Phase A done, signing deferred
    const id = (await state(businessId, runId)).attempts[0].id;
    await runTransact(businessId, tx => tx.patchAttempt(businessId, id, ["prepared"], { status: "signed", tx_hash: "tx-w", signed_tx_b64: "bytes-w", signed_block_height: 1, validity_period_blocks: 86400 }));
    await setKillSwitch(businessId, true);
    await advanceRun(businessId, runId).catch(() => undefined);
    const s = await state(businessId, runId);
    expect(f.calls.broadcast).toBe(0);
    expect(s.attempts[0]).toMatchObject({ status: "aborted", signed_tx_b64: null });
  });

  test("after broadcast the payment can't be recalled: a stop still records the REAL outcome", async () => {
    const f = fakeChain({ broadcast: async () => ({ outcome: "unknown", reason: "TIMEOUT" }) });
    const { businessId, workflow } = await setup();
    const { runId } = await startTestnet(businessId, workflow.id);
    await approved(businessId, runId);
    await advanceRun(businessId, runId);
    await requestControl(businessId, runId, "stop");
    expect((await state(businessId, runId)).run.status).toBe("cancelled");
    f.st.reconcile.push({ action: "settled", verdict: { outcome: "confirmed", txHash: "tx-1", gasBurnt: 1, evidence: {} } });
    await advanceRun(businessId, runId);
    const s = await state(businessId, runId);
    expect(s.attempts[0].status).toBe("confirmed");
    expect(s.ledger).toEqual([expect.objectContaining({ tx_status: "confirmed", tx_hash: "tx-1" })]);
    expect(f.calls.sign).toBe(1);
  });
});

describe("concurrency and the views", () => {
  test("concurrent advances after approval produce exactly one signature and one broadcast", async () => {
    const { calls } = fakeChain();
    const { businessId, workflow } = await setup();
    const { runId } = await startTestnet(businessId, workflow.id);
    await approved(businessId, runId);
    await Promise.allSettled([advanceRun(businessId, runId), advanceRun(businessId, runId), advanceRun(businessId, runId)]);
    const s = await toEnd(businessId, runId);
    expect(calls).toMatchObject({ sign: 1, broadcast: 1 });
    expect(s.attempts).toHaveLength(1);
    expect(s.ledger).toHaveLength(1);
  });

  test("an approval is used once: its consumption and the attempt are one atomic write; no second attempt", async () => {
    fakeChain();
    const { businessId, workflow } = await setup();
    const { runId } = await startTestnet(businessId, workflow.id);
    await approved(businessId, runId);
    await toEnd(businessId, runId);
    // A request that was PAID can never get another attempt (one active-or-paid attempt per request_id).
    await expect(runTransact(businessId, tx => tx.insertAttempt({ ...tx.attempts(businessId)[0], status: "prepared" }))).rejects.toThrow("ATTEMPT_ALREADY_ACTIVE");
    const s = await state(businessId, runId);
    expect(s.approvals.filter(a => a.consumed_at)).toHaveLength(1);
  });

  test("the run view shows the payment without signed bytes or secrets", async () => {
    const f = fakeChain({ broadcast: async () => ({ outcome: "unknown", reason: "TIMEOUT" }) });
    const { businessId, workflow, store } = await setup();
    const { runId } = await startTestnet(businessId, workflow.id);
    await approved(businessId, runId);
    await advanceRun(businessId, runId);
    const v = await buildRunView((await store.getBusiness(businessId))!, runId);
    expect(v!.run).toMatchObject({ mode: "testnet", batchRef: "B3" });
    expect(v!.payment).toMatchObject({ status: "unknown", txHash: "tx-1", amountNear: "0.031", recipient: S1, signedBlockHeight: 1000, expiresAfterHeight: 87400 });
    expect(JSON.stringify(v)).not.toContain("bytes-1");
    expect(f.calls.sign).toBe(1);
  });

  test("S2's account is used when supplier-1 can't deliver (new_supplier), from the registry only", async () => {
    fakeChain();
    const { businessId, workflow } = await setup();
    const { runId } = await startTestnet(businessId, workflow.id, "new_supplier");
    const s = await toApproval(businessId, runId);
    expect(s.approvals[0]).toMatchObject({ recipient_account: S2, amount_yocto: NEAR_0_031, beneficiary: "Mainland Grains (demo)" });
  });
});
