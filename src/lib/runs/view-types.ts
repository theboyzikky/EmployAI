// Client-safe types for the Runs tab (M4). Everything money-related is illustrative NGN on fictional
// demo data and labelled "Test run — no transaction".
import type { ApprovalStatus, GateDecision, RunStatus, ScenarioKey, StepStatus } from "./types";

export type RunScenarioCard = { key: ScenarioKey; title: string; description: string; changes: string; expected: { decision: GateDecision | null; end: string } };

export type RunSummary = {
  id: string; status: RunStatus; scenario: ScenarioKey; scenarioTitle: string; workflowVersion: number;
  startedAt: string; endedAt: string | null; elapsedMs: number | null; endReason: string | null;
};

export type AddressedItem = { kind: "problem" | "goal" | "need"; text: string; cause: string | null; basis: "Confirmed by you" | "Supported by your answers" | "You asked for this" | "Cause not yet known" };

export type RunsView = {
  businessId: string;
  businessName: string | null;
  runnable: boolean;
  killSwitch: boolean;
  killSwitchChangedAt: string | null;
  /** Whether the current approved workflow can run now, and if not, why (server-side checks, §4). */
  eligibility: { canRun: boolean; code: string | null; message: string | null };
  workflow: { id: string; version: number; approvedAt: string | null; fingerprinted: boolean } | null;
  scenarios: RunScenarioCard[];
  /** D15: from the M3.5 case file, labelled as the owner's business information (read-only). */
  addresses: AddressedItem[];
  agents: Array<{ key: string; name: string; status: string; runnable: boolean }>;
  activeRunId: string | null;
  runs: RunSummary[];                       // newest first
  demoLabel: string;
};

export type RunStepView = {
  id: string; seq: number; stepId: string; title: string; type: string; agentKey: string | null; agentName: string; requester: string;
  task: string | null; status: StepStatus; attempt: number; reasoning: string | null; output: unknown;
  toolsUsed: string[]; reads: string[]; writes: string[]; simulated: string[];
  startedAt: string; endedAt: string | null; durationMs: number | null; error: { code: string; message: string } | null;
};

export type RunApprovalView = {
  id: string; status: ApprovalStatus; autoApproved: boolean; amountNgn: number; beneficiary: string; channel: string;
  reasons: Array<{ code: string; text: string }>; expiresAt: string; decidedAt: string | null; decidedBy: string | null;
  /** True when the expiry time has passed but the expiry isn't persisted yet (GET never writes). */
  expiredNotPersisted: boolean; thresholdNgn: number; maxPaymentNgn: number; rationale: string | null;
};

export type RunView = {
  run: RunSummary & {
    mode: "test_run"; cursor: string | null; stepsDone: number; execMs: number; pauseReason: string | null; control: string | null;
    summary: string | null; error: { code: string; message: string } | null; expected: { decision: GateDecision | null; end: string };
    actual: { decision: GateDecision | null; end: string | null };
    /** A step was cut off and its lease has expired: shown, then persisted by the next mutating call. */
    interruptedDetected: boolean;
    /** A step is recorded as running and its lease hasn't expired yet. */
    settling: boolean;
  };
  steps: RunStepView[];
  decisions: Array<{ id: string; decision: GateDecision; reasons: Array<{ code: string; text: string }>; createdAt: string; signals: Record<string, unknown> }>;
  approval: RunApprovalView | null;
  ledger: Array<{ id: string; amount: number; counterparty: string; label: string; txHash: null; occurredAt: string }>;
  events: Array<{ id: string; actor: string; type: string; subject: string; status: string; createdAt: string }>;
  more: boolean;
};

export type RunsApiFailure = { error: { code: string; message: string; correlation_id: string }; view?: RunsView };
