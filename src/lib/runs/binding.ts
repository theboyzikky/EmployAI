import "server-only";
// M5 · Approval binding (plan §8.3, V1). One testnet approval authorises exactly one payment: the hash
// covers the request, payee, both amounts, the pinned workflow, both policy versions, the contract,
// code hash, agent, method, the gate decision the owner saw, and the batch. It is recomputed from the
// CURRENT state when the owner clicks Approve, in Phase A, and immediately before signing; any
// difference invalidates the approval (APPROVAL_STALE). Pure over a RunTx read: no I/O.
import { canonicalJson, sha256Hex, workflowFingerprint } from "./fingerprint";
import type { ChainTarget } from "./payment-port";
import type { RunTx } from "./repo";
import type { PaymentBinding, RunRecord } from "./types";
import type { DemoScenario } from "@/lib/workflows/demo-data";
import type { WorkflowDoc } from "@/lib/workflows/schema";

/** The payment request Finance prepared (run-local record). */
export type PreparedRequest = {
  request_id: string; beneficiary: string; amount_ngn: number;
  channel: { kind: string; method: string; network?: string; mode?: string };
  recipient_account?: string; amount_yocto?: string;
};

export const firstRequest = (records: Record<string, unknown>): PreparedRequest | undefined =>
  ((records.payment_requests ?? []) as PreparedRequest[])[0];

/** NGN business policy version: the demo policy version plus the workflow's payment settings. */
export function ngnPolicyVersion(doc: WorkflowDoc, snap: DemoScenario): string {
  return sha256Hex(canonicalJson({
    version: snap.policy?.version ?? "demo-policy", daily_limit_ngn: snap.policy?.daily_limit_ngn ?? 0,
    max_payment_ngn: doc.params.max_payment_ngn, approval_threshold_ngn: doc.params.approval_threshold_ngn,
  }));
}

/**
 * The binding as it stands NOW. Returns null when the payment can't be bound at all (no workflow,
 * no testnet request, no batch): the caller refuses.
 */
export function currentBinding(tx: RunTx, run: RunRecord, args: { gateDecisionId: string; target: ChainTarget; nearPolicyVersion: string }): PaymentBinding | null {
  const wf = tx.workflows(run.business_id).find(w => w.id === run.workflow_id);
  const req = firstRequest(run.records);
  if (!wf || !req || !req.recipient_account || !req.amount_yocto || !run.batch_id) return null;
  return {
    request_id: req.request_id, run_id: run.id, business_id: run.business_id,
    recipient_account_id: req.recipient_account, amount_yocto: req.amount_yocto, amount_ngn_business: req.amount_ngn,
    workflow_id: wf.id, workflow_version: wf.version, approval_fingerprint: wf.status === "approved" ? workflowFingerprint(wf) : "not-approved",
    ngn_policy_version: ngnPolicyVersion(wf.steps, run.demo_snapshot as DemoScenario),
    near_policy_version: args.nearPolicyVersion,
    network: args.target.network, contract_id: args.target.contractId, expected_code_hash: args.target.expectedCodeHash, agent_account_id: args.target.agent,
    method: "request_payment", gate_decision_id: args.gateDecisionId, batch_id: run.batch_id,
  };
}
