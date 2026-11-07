// M4 · Run records (local dev store; mirrors approved tables 5–10 with the M4 additions in the plan §11).
// Client-safe: types only. Every money amount here is ILLUSTRATIVE NGN for the fictional demo, and no
// record can describe a real transaction: `tx_hash` is always null and `tx_status` always "simulated".

/** D9: all nine are new to the code; `paused` and `cancelled` are also new to the design (doc 03). */
export const RUN_STATUSES = ["running", "waiting_approval", "paused", "completed", "blocked", "rejected", "failed", "interrupted", "cancelled"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
/** A run in any of these blocks a new start for the same business (D13). */
export const ACTIVE_RUN_STATUSES: readonly RunStatus[] = ["running", "waiting_approval", "paused", "interrupted"];
export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ["completed", "blocked", "rejected", "failed", "cancelled"];

export const SCENARIOS = ["standard", "large_catering", "new_supplier", "price_spike", "quiet_day"] as const;
export type ScenarioKey = (typeof SCENARIOS)[number];

export type Actor = "owner" | "system" | `agent:${string}`;

export type RunControl = "pause" | "stop" | null;

export type RunRecord = {
  id: string;
  business_id: string;
  workflow_id: string;
  workflow_version: number;
  approval_fingerprint: string;
  mode: "test_run";
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
  mode: "test_run";
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
};

/** Append-only (doc 03 table 9). M4 writes only simulated, owner-only test-run rows. */
export type LedgerRecord = {
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
