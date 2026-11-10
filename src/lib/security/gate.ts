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
      /** M5 testnet only: the exact on-chain payout. Present ⇒ the NEAR rules below apply too. */
      near?: { recipientAccount: string; amountYocto: string };
    };

/** M5 · NEAR testnet context (both currencies are enforced; the stricter result wins, plan §8.2). */
export type NearGateContext = {
  policy: { version: string; maxPerTxYocto: string; dailyCapYocto: string; approvalThresholdYocto: string } | null;
  /** Confirmed + in-flight testnet payouts today (the larger of the app's count and the contract's). */
  spentTodayYocto: string;
  /** Hard refusals from the read-only chain checks (readiness, recipient on-chain), in check order. */
  chainFailures: readonly string[];
  /** Confirmed testnet payouts per recipient account (the only "paid before" signal in testnet, R7). */
  confirmedPayouts: Readonly<Record<string, number>>;
  signals: Record<string, unknown>;
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
  registry: ReadonlyArray<{ name: string; approved: boolean; priorPayments: number; account?: string }>;
  /** M6 shared blocklist: CONFIRMED names or account IDs (hard BLOCK). */
  blocklist: readonly string[];
  /** M6: REPORTED (unreviewed) account IDs: WARN only, so one report can't block on its own. */
  reported?: readonly string[];
  /** Simulated test-run payouts recorded today for this business (for the daily limit). */
  spentTodayNgn: number;
  /** request_ids already evaluated for this business. */
  seenRequestIds: readonly string[];
  /** M5: required for a payment request that carries `near` (absent ⇒ BLOCK POLICY_MISSING). */
  near?: NearGateContext;
};

const DIGITS = /^[1-9]\d{0,39}$/;
const nearPolicyValid = (p: NearGateContext["policy"]): p is NonNullable<NearGateContext["policy"]> =>
  !!p && [p.maxPerTxYocto, p.dailyCapYocto, p.approvalThresholdYocto].every(v => DIGITS.test(v)) && BigInt(p.approvalThresholdYocto) <= BigInt(p.maxPerTxYocto);

export type GateResult = {
  decision: GateDecisionValue;
  reasons: string[];
  signals: Record<string, unknown>;
  policyVersion: string;
};

const policyValid = (p: GatePolicy | null): p is GatePolicy =>
  !!p && [p.maxPaymentNgn, p.approvalThresholdNgn, p.dailyLimitNgn].every(n => Number.isInteger(n) && n > 0) && p.approvalThresholdNgn <= p.maxPaymentNgn;

export function evaluate(action: GateAction, ctx: GateContext): GateResult {
  const testnet = action.kind === "payment_request" && !!action.near;
  const signals: Record<string, unknown> = action.kind === "payment_request"
    ? testnet
      ? { source: "demo_registry+chain", chain_checks: "run", mode: "testnet", ...(ctx.near?.signals ?? {}) }
      : { source: "demo_registry", chain_checks: "not_run_in_test_mode", mode: "test_run" }
    : { source: "approved_definition", mode: "test_run" };
  const policyVersion = ctx.policy?.version ?? "none";
  const block = (...reasons: string[]): GateResult => ({ decision: "BLOCK", reasons, signals, policyVersion });

  // 1 · kill switch beats everything, then a paused agent
  if (ctx.killSwitch) return block("KILL_SWITCH_ACTIVE");
  if (ctx.agent?.status === "paused") return block("AGENT_PAUSED");
  // 2 · a valid policy must exist (testnet: the NEAR policy too)
  if (!policyValid(ctx.policy)) return block("POLICY_MISSING");
  if (testnet && (!ctx.near || !nearPolicyValid(ctx.near.policy))) return block("POLICY_MISSING");
  // 3 · authorised: approved agent, tool in its definition AND in this step, treasury channel for payments
  if (!ctx.agent || ctx.agent.status !== "approved") return block("NOT_AUTHORISED");
  if (!ctx.agent.allowedTools.includes(action.tool) || !ctx.stepTools.includes(action.tool)) return block("NOT_AUTHORISED");
  if (action.kind === "tool_call") return { decision: "ALLOW", reasons: [], signals, policyVersion };

  if (action.channel.kind !== "treasury_contract" || action.channel.method !== "request_payment") return block("NOT_AUTHORISED");
  if (!Number.isInteger(action.amountNgn) || action.amountNgn <= 0) return block("NOT_AUTHORISED");
  // 4 · the recipient must exist (demo registry in test runs)
  const recipient = ctx.registry.find(r => r.name === action.beneficiary);
  if (!recipient) return block("RECIPIENT_NOT_FOUND");
  // testnet: the payout account must be the registry's own entry for this supplier (agents never
  // introduce account IDs), and the read-only chain checks are hard rules (R11, plan §9).
  const near = action.kind === "payment_request" ? action.near : undefined;
  if (near && (!recipient.account || recipient.account !== near.recipientAccount)) return block("RECIPIENT_NOT_FOUND");
  // 5 · shared blocklist (M6): a CONFIRMED entry for the supplier's name or its account is a hard BLOCK.
  //     The other findings that apply are listed too, so the log shows everything that was wrong.
  const ids = [action.beneficiary, recipient.account, near?.recipientAccount].filter((x): x is string => !!x);
  if (ids.some(id => ctx.blocklist.includes(id))) {
    return block("RECIPIENT_BLOCKLISTED", ...(!recipient.approved ? ["RECIPIENT_NOT_APPROVED"] : []), ...(action.provenance === "untrusted" ? ["UNTRUSTED_INSTRUCTION_SOURCE"] : []));
  }
  if (near) {
    if (!recipient.approved) return block("RECIPIENT_NOT_APPROVED");   // a real payout only ever goes to an approved supplier
    if (!DIGITS.test(near.amountYocto)) return block("NOT_AUTHORISED");
    if (ctx.near!.chainFailures.length) return block(ctx.near!.chainFailures[0]);
  }
  // 6 · limits (both currencies)
  if (action.amountNgn > ctx.policy.maxPaymentNgn) return block("OVER_TX_LIMIT");
  if (near && BigInt(near.amountYocto) > BigInt(ctx.near!.policy!.maxPerTxYocto)) return block("OVER_TX_LIMIT");
  if (ctx.spentTodayNgn + action.amountNgn > ctx.policy.dailyLimitNgn) return block("OVER_DAILY_LIMIT");
  if (near && BigInt(ctx.near!.spentTodayYocto) + BigInt(near.amountYocto) > BigInt(ctx.near!.policy!.dailyCapYocto)) return block("OVER_DAILY_LIMIT");
  // 7 · duplicates
  if (ctx.seenRequestIds.includes(action.requestId)) return block("DUPLICATE_REQUEST");
  // 8 · WARN reasons, all collected
  const warn: string[] = [];
  if (!recipient.approved) warn.push("RECIPIENT_NOT_APPROVED");
  if (ids.some(id => (ctx.reported ?? []).includes(id))) warn.push("RECIPIENT_REPORTED");
  // testnet: "paid before" counts only confirmed on-chain payouts to this account (R7)
  const priorPaid = near ? ctx.near!.confirmedPayouts[near.recipientAccount] ?? 0 : recipient.priorPayments;
  if (priorPaid <= 0) warn.push("FIRST_INTERACTION");
  if (action.amountNgn > ctx.policy.approvalThresholdNgn || (near && BigInt(near.amountYocto) > BigInt(ctx.near!.policy!.approvalThresholdYocto))) warn.push("ABOVE_APPROVAL_THRESHOLD");
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
  RECIPIENT_BLOCKLISTED: "The recipient is on the shared blocklist (confirmed, with evidence).",
  RECIPIENT_REPORTED: "The recipient was reported to the shared blocklist (not yet confirmed).",
  OVER_TX_LIMIT: "The amount is over your maximum payment.",
  OVER_DAILY_LIMIT: "Today's payments would go over the daily limit.",
  DUPLICATE_REQUEST: "This payment request was already made.",
  RECIPIENT_NOT_APPROVED: "The supplier isn't on your approved list.",
  FIRST_INTERACTION: "This supplier hasn't been paid before.",
  ABOVE_APPROVAL_THRESHOLD: "The amount is above your approval threshold.",
  UNTRUSTED_INSTRUCTION_SOURCE: "The instruction came from an untrusted source.",
  // M5 · chain checks and payment execution (testnet)
  RECIPIENT_NOT_APPROVED_ONCHAIN: "The recipient isn't on the treasury contract's on-chain allowlist.",
  RECIPIENT_IS_CONTRACT: "The recipient account is a contract, not a plain account.",
  TREASURY_NOT_FOUND: "The treasury contract account wasn't found.",
  TREASURY_CODE_MISMATCH: "The treasury contract code isn't the reviewed version.",
  TREASURY_POLICY_MISMATCH: "The treasury's on-chain policy doesn't match the approved limits.",
  TREASURY_PAUSED: "The treasury contract is paused on-chain.",
  TREASURY_UNDERFUNDED: "The treasury doesn't hold enough testnet NEAR for this payment.",
  SALES_UNEXPECTEDLY_ENABLED: "Customer sales are switched on in the contract; they must stay off.",
  SIGNER_KEY_UNSAFE: "The Finance Agent's signing key isn't the restricted key it must be.",
  INSUFFICIENT_GAS: "The Finance Agent account doesn't have enough testnet NEAR for gas.",
  CHAIN_UNAVAILABLE: "The NEAR testnet couldn't be reached, so nothing was checked or sent.",
  APPROVAL_STALE: "Something the approval covered changed, so it no longer applies.",
  BATCH_NOT_ARMED: "No testnet batch is armed.",
  BATCH_LIMIT_REACHED: "The armed testnet batch has no capacity left.",
};
