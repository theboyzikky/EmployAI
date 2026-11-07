// M4 · D1: the deterministic security gate. A PURE function: no I/O, no clock, no randomness, no model.
// The same inputs always give the same decision. Rule order is doc 05 §3, unchanged:
//   1 kill switch / agent paused → BLOCK     2 no valid policy → BLOCK     3 not authorised → BLOCK
//   4 recipient not found → BLOCK            5 blocklisted → BLOCK          6 over tx / daily limit → BLOCK
//   7 duplicate request → BLOCK              8 collect WARN reasons         9 otherwise ALLOW
// D19: EVERY tool call is checked (rules 1–3); payment requests are checked against all nine.
// D2: test runs use the fictional demo registry and are stamped "chain checks not run in test mode";
// the testnet rule (an unavailable signal → WARN, never ALLOW) is unchanged for M5.

export type GateDecisionValue = "ALLOW" | "WARN" | "BLOCK";

export type GateAction =
  | { kind: "tool_call"; agentKey: string; tool: string; stepId: string }
  | {
      kind: "payment_request";
      agentKey: string;
      tool: "request_payment";
      stepId: string;
      requestId: string;
      beneficiary: string;
      amountNgn: number;
      channel: { kind: string; method: string };
      /** Where the instruction came from. M4 agents are deterministic, so it is "system". */
      provenance: "system" | "owner" | "untrusted";
    };

export type GatePolicy = { version: string; maxPaymentNgn: number; approvalThresholdNgn: number; dailyLimitNgn: number };

export type GateContext = {
  killSwitch: boolean;
  /** The agent as approved on the team (null if it isn't on the approved team). */
  agent: { status: string; allowedTools: readonly string[] } | null;
  /** Tools the current step declares; a tool must be in both the definition and the step. */
  stepTools: readonly string[];
  policy: GatePolicy | null;
  /** Fictional demo supplier registry (D5). `priorPayments` is its fictional history only (D7). */
  registry: ReadonlyArray<{ name: string; approved: boolean; priorPayments: number }>;
  /** Shared blocklist arrives in M6; empty in M4. */
  blocklist: readonly string[];
  /** Simulated test-run payouts recorded today for this business (for the daily limit). */
  spentTodayNgn: number;
  /** request_ids already evaluated for this business. */
  seenRequestIds: readonly string[];
};

export type GateResult = {
  decision: GateDecisionValue;
  reasons: string[];
  signals: Record<string, unknown>;
  policyVersion: string;
};

const policyValid = (p: GatePolicy | null): p is GatePolicy =>
  !!p && [p.maxPaymentNgn, p.approvalThresholdNgn, p.dailyLimitNgn].every(n => Number.isInteger(n) && n > 0) && p.approvalThresholdNgn <= p.maxPaymentNgn;

export function evaluate(action: GateAction, ctx: GateContext): GateResult {
  const signals: Record<string, unknown> = action.kind === "payment_request"
    ? { source: "demo_registry", chain_checks: "not_run_in_test_mode", mode: "test_run" }
    : { source: "approved_definition", mode: "test_run" };
  const policyVersion = ctx.policy?.version ?? "none";
  const block = (...reasons: string[]): GateResult => ({ decision: "BLOCK", reasons, signals, policyVersion });

  // 1 · kill switch beats everything, then a paused agent
  if (ctx.killSwitch) return block("KILL_SWITCH_ACTIVE");
  if (ctx.agent?.status === "paused") return block("AGENT_PAUSED");
  // 2 · a valid policy must exist
  if (!policyValid(ctx.policy)) return block("POLICY_MISSING");
  // 3 · authorised: approved agent, tool in its definition AND in this step, treasury channel for payments
  if (!ctx.agent || ctx.agent.status !== "approved") return block("NOT_AUTHORISED");
  if (!ctx.agent.allowedTools.includes(action.tool) || !ctx.stepTools.includes(action.tool)) return block("NOT_AUTHORISED");
  if (action.kind === "tool_call") return { decision: "ALLOW", reasons: [], signals, policyVersion };

  if (action.channel.kind !== "treasury_contract" || action.channel.method !== "request_payment") return block("NOT_AUTHORISED");
  if (!Number.isInteger(action.amountNgn) || action.amountNgn <= 0) return block("NOT_AUTHORISED");
  // 4 · the recipient must exist (demo registry in test runs)
  const recipient = ctx.registry.find(r => r.name === action.beneficiary);
  if (!recipient) return block("RECIPIENT_NOT_FOUND");
  // 5 · blocklist (M6; empty in M4)
  if (ctx.blocklist.includes(action.beneficiary)) return block("RECIPIENT_BLOCKLISTED");
  // 6 · limits
  if (action.amountNgn > ctx.policy.maxPaymentNgn) return block("OVER_TX_LIMIT");
  if (ctx.spentTodayNgn + action.amountNgn > ctx.policy.dailyLimitNgn) return block("OVER_DAILY_LIMIT");
  // 7 · duplicates
  if (ctx.seenRequestIds.includes(action.requestId)) return block("DUPLICATE_REQUEST");
  // 8 · WARN reasons, all collected
  const warn: string[] = [];
  if (!recipient.approved) warn.push("RECIPIENT_NOT_APPROVED");
  if (recipient.priorPayments <= 0) warn.push("FIRST_INTERACTION");
  if (action.amountNgn > ctx.policy.approvalThresholdNgn) warn.push("ABOVE_APPROVAL_THRESHOLD");
  if (action.provenance === "untrusted") warn.push("UNTRUSTED_INSTRUCTION_SOURCE");
  if (warn.length) return { decision: "WARN", reasons: warn, signals, policyVersion };
  // 9
  return { decision: "ALLOW", reasons: [], signals, policyVersion };
}

/** Plain-language text for each reason code (shown on approval cards and in the timeline). */
export const REASON_TEXT: Record<string, string> = {
  KILL_SWITCH_ACTIVE: "The kill switch is on.",
  AGENT_PAUSED: "This agent is paused.",
  POLICY_MISSING: "No valid spending policy is set.",
  NOT_AUTHORISED: "This agent isn't allowed to do that here.",
  RECIPIENT_NOT_FOUND: "The recipient isn't in the supplier registry.",
  RECIPIENT_BLOCKLISTED: "The recipient is on the blocklist.",
  OVER_TX_LIMIT: "The amount is over your maximum payment.",
  OVER_DAILY_LIMIT: "Today's payments would go over the daily limit.",
  DUPLICATE_REQUEST: "This payment request was already made.",
  RECIPIENT_NOT_APPROVED: "The supplier isn't on your approved list.",
  FIRST_INTERACTION: "This supplier hasn't been paid before.",
  ABOVE_APPROVAL_THRESHOLD: "The amount is above your approval threshold.",
  UNTRUSTED_INSTRUCTION_SOURCE: "The instruction came from an untrusted source.",
};
