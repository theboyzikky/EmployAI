// M4 · Run records (local dev store; mirrors approved tables 5–10 with the M4 additions in the plan §11).
// Client-safe: types only. NGN amounts are ILLUSTRATIVE business amounts for the fictional demo.
// M5 adds the "testnet" mode: real NEAR testnet payouts through the treasury contract. A testnet amount
// is yoctoNEAR (a decimal string) and is never converted to or from NGN (R4).

/** D9: all nine are new to the code; `paused` and `cancelled` are also new to the design (doc 03). */
export const RUN_STATUSES = ["running", "waiting_approval", "paused", "completed", "blocked", "rejected", "failed", "interrupted", "cancelled"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
/** A run in any of these blocks a new start for the same business (D13). */
export const ACTIVE_RUN_STATUSES: readonly RunStatus[] = ["running", "waiting_approval", "paused", "interrupted"];
export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ["completed", "blocked", "rejected", "failed", "cancelled"];

export const SCENARIOS = ["standard", "large_catering", "new_supplier", "price_spike", "quiet_day"] as const;
export type ScenarioKey = (typeof SCENARIOS)[number];

/** M5: "test_run" = simulated (M4, unchanged); "testnet" = a real NEAR testnet transaction. */
export const RUN_MODES = ["test_run", "testnet"] as const;
export type RunMode = (typeof RUN_MODES)[number];

export type Actor = "owner" | "system" | `agent:${string}`;

export type RunControl = "pause" | "stop" | null;

export type RunRecord = {
  id: string;
  business_id: string;
  workflow_id: string;
  workflow_version: number;
  approval_fingerprint: string;
  mode: RunMode;
  /** M5: the armed testnet batch this run counts against (testnet only). */
  batch_id?: string | null;
  /** M5: set when the owner asked to retry a payment proven failed or expired (R12, §11.1). */
  payment_retry?: { of_attempt: string; mode: Exclude<SignMode, "new">; requested_at: string } | null;
  scenario: ScenarioKey;
  status: RunStatus;
  trigger: { source: "demo_order" | "demo_stock_check"; requested_by: "owner" };
  idempotency_key: string;
  /** Run-local copy of the fictional demo data. Never written back anywhere. */
  demo_snapshot: unknown;
  /** Run-local working records produced by the agents (orders, proposals, payment requests). */
  records: Record<string, unknown>;
  cursor: string | null;          // the next step id to execute
  steps_done: number;
  exec_ms: number;                // execution time only (excludes waiting for the owner)
  lease_expires_at: string | null;
  control: RunControl;            // written only by the pause / stop / resume endpoints
  control_at: string | null;
  pause_reason: string | null;    // "owner" | "agent_paused:<key>"
  started_at: string;
  ended_at: string | null;
  elapsed_ms: number | null;
  summary: string | null;
  expected: { decision: "ALLOW" | "WARN" | "BLOCK" | null; end: string };
  end_reason: string | null;
  error: { code: string; message: string } | null;
  /** Incremented on every change, so views can tell what's new. */
  version: number;
  updated_at: string;
};

export type StepStatus = "running" | "succeeded" | "failed" | "interrupted" | "cancelled" | "waiting";

export type RunStepRecord = {
  id: string;
  run_id: string;
  business_id: string;
  seq: number;
  step_id: string;
  step_type: string;
  agent_key: string | null;       // set by the runner, never by an agent
  requester: string;              // "orchestrator" | "runner" | "owner"
  task_id: string | null;
  status: StepStatus;
  attempt: number;
  input: unknown;
  output: unknown;
  reasoning: string | null;
  tools_used: string[];
  reads: string[];
  writes: string[];
  /** Labels of simulated external actions, e.g. "Demo confirmation (not sent)". */
  simulated: string[];
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  error: { code: string; message: string } | null;
};

export type GateDecision = "ALLOW" | "WARN" | "BLOCK";

/** Append-only (doc 03 table 7). */
export type SecurityDecisionRecord = {
  id: string;
  business_id: string;
  run_id: string;
  step_id: string;
  agent_key: string;
  action: unknown;
  action_hash: string;
  decision: GateDecision;
  reason_codes: string[];
  signals: Record<string, unknown>;
  policy_version: string;
  provenance: { source: string };
  mode: RunMode;
  created_at: string;
};

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired" | "invalidated";

/** The single authorisation record the payment executor accepts (doc 03 table 8). */
export type ApprovalRecord = {
  id: string;
  business_id: string;
  run_id: string;
  decision_id: string;
  request_id: string;
  action_hash: string;
  amount_ngn: number;
  beneficiary: string;
  reason_codes: string[];
  status: ApprovalStatus;
  auto_approved: boolean;
  expires_at: string;
  decided_at: string | null;
  decided_by: "owner" | "system" | null;
  consumed_at: string | null;
  invalidated_reason: string | null;
  created_at: string;
  /** M5 testnet only: never auto-approved (R5); bound to the exact payment (V1). */
  mode?: RunMode;
  recipient_account?: string;
  amount_yocto?: string;
  binding?: PaymentBinding;
};

/** M5 · What one testnet approval authorises (plan §8.3, V1). Its canonical hash is the action hash. */
export type PaymentBinding = {
  request_id: string; run_id: string; business_id: string;
  recipient_account_id: string; amount_yocto: string; amount_ngn_business: number;
  workflow_id: string; workflow_version: number; approval_fingerprint: string;
  ngn_policy_version: string; near_policy_version: string;
  network: "testnet"; contract_id: string; expected_code_hash: string; agent_account_id: string; method: "request_payment";
  gate_decision_id: string; batch_id: string;
};

/** Append-only (doc 03 table 9). Test runs write simulated rows; testnet writes verified chain outcomes. */
export type LedgerRecord = TestRunLedgerRecord | TestnetLedgerRecord;

export type TestRunLedgerRecord = {
  id: string;
  business_id: string;
  run_id: string;
  type: "supplier_payout";
  mode: "test_run";
  amount: number;
  unit: "ngn_illustrative";
  counterparty: string;
  agent_key: "finance";
  tx_hash: null;
  tx_status: "simulated";
  request_id: string;
  label: "Test run — no transaction";
  occurred_at: string;
};

/** M5 · A testnet payout written ONLY from a verified RPC outcome (plan §12, §13). */
export type TestnetLedgerRecord = {
  id: string;
  business_id: string;
  run_id: string;
  type: "supplier_payout";
  mode: "testnet";
  /** yoctoNEAR, decimal string. */
  amount: string;
  unit: "yoctoNEAR";
  amount_ngn_business: number;
  counterparty: string;            // the recipient account ID
  supplier_name: string;
  agent_key: "finance";
  tx_hash: string | null;
  tx_status: "confirmed" | "failed";
  request_id: string;
  attempt_id: string;
  batch_id: string;
  explorer_url: string | null;
  label: "NEAR testnet · real transaction" | "Failed on-chain";
  occurred_at: string;
};

/** NGN business amount of a ledger row (test runs: the amount; testnet: only confirmed payouts count). */
export const ledgerNgn = (l: LedgerRecord): number => (l.mode === "test_run" ? l.amount : l.tx_status === "confirmed" ? l.amount_ngn_business : 0);

/** M5 · An owner-armed testnet batch (plan §8.4): an extra limit, never a substitute for approval. */
export type TestnetBatch = {
  id: string;
  business_id: string;
  batch_ref: string;              // the ID of the approved written batch sheet, e.g. "B3"
  max_payments: number;
  max_total_yocto: string;
  expires_at: string;
  armed_at: string;
  disarmed_at: string | null;
  disarm_reason: string | null;
  payments_used: number;
  yocto_used: string;
};

/** M5 · Payment attempt state machine (plan §4.4). */
export const ATTEMPT_STATUSES = ["prepared", "signing", "signed", "submitting", "unknown", "confirmed", "failed_onchain", "aborted", "expired_unexecuted"] as const;
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];
export const TERMINAL_ATTEMPT_STATUSES: readonly AttemptStatus[] = ["confirmed", "failed_onchain", "aborted", "expired_unexecuted"];
/** A signature is persisted and the transaction may reach the chain: it is NEVER signed again. */
export const SIGNED_ATTEMPT_STATUSES: readonly AttemptStatus[] = ["signed", "submitting", "unknown"];

/**
 * How an attempt may be signed: "new" (no on-chain record may exist), "retry_after_failed" (the contract's
 * record is Failed with identical details), "resubmit_after_expiry" (the earlier signed transaction's
 * validity window closed by block height and the contract has no record).
 */
export type SignMode = "new" | "retry_after_failed" | "resubmit_after_expiry";

export type PaymentAttempt = {
  id: string;
  /** M5 retry: absent means "new" (every attempt before retries existed). */
  sign_mode?: SignMode;
  retry_of?: string | null;
  previous_expires_after_height?: number | null;
  business_id: string;
  run_id: string;
  request_id: string;
  batch_id: string;
  approval_id: string;
  action_hash: string;
  status: AttemptStatus;
  recipient: string;
  supplier_name: string;
  amount_yocto: string;
  amount_ngn: number;
  /** One driver at a time (compare-and-set lease). */
  lease_owner: string | null;
  lease_expires_at: string | null;
  pre_sign_errors: number;
  // write-ahead (stored BEFORE broadcast)
  nonce: string | null;
  signer_public_key: string | null;
  tx_hash: string | null;
  signed_tx_b64: string | null;    // cleared once the attempt is final
  signed_block_hash: string | null;
  signed_block_height: number | null;
  validity_period_blocks: number | null;
  expires_after_height: number | null;
  broadcasts: number;
  // verified outcome
  outcome: unknown;
  gas_burnt: number | null;
  verified_at: string | null;
  error: { code: string; message: string } | null;
  checks: Array<{ at: string; result: string; detail: string }>;
  created_at: string;
  updated_at: string;
};

/** Append-only (doc 03 table 10). */
export type ActivityEvent = {
  id: string;
  business_id: string;
  actor: Actor;
  type: string;
  subject: string;
  status: string;
  correlation_id: string;
  payload: Record<string, unknown>;
  created_at: string;
};
