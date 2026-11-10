// M4 phase 2 · the deterministic security gate (D1, D19) and payment authorisation (use once, hash-bound,
// expiry). Offline only: tests/setup.ts blocks fetch.
import { afterEach, describe, expect, test } from "vitest";
import { setDiscoveryRepository } from "@/lib/discovery/store";
import { runRead, runTransact } from "@/lib/runs/repo";
import { actionHash, authorisationFor, expiresAt, isExpired, type PaymentAction } from "@/lib/security/authorisation";
import { REASON_TEXT, evaluate, type GateAction, type GateContext } from "@/lib/security/gate";
import { readyRestaurant, tempStore } from "./helpers/run-fixture";

afterEach(() => setDiscoveryRepository(null));

const policy = { version: "demo-policy-v2", maxPaymentNgn: 250_000, approvalThresholdNgn: 50_000, dailyLimitNgn: 500_000 };
const registry = [
  { name: "Lagos Fresh Foods (demo)", approved: true, priorPayments: 6 },
  { name: "Mainland Grains (demo)", approved: true, priorPayments: 0 },
  { name: "QuickSupply Express (demo)", approved: false, priorPayments: 3 },
];
const ctx = (over: Partial<GateContext> = {}): GateContext => ({
  killSwitch: false, agent: { status: "approved", allowedTools: ["read_budget", "request_payment", "record_ledger"] }, stepTools: ["request_payment"],
  policy, registry, blocklist: [], spentTodayNgn: 0, seenRequestIds: [], ...over,
});
const pay = (over: Partial<Extract<GateAction, { kind: "payment_request" }>> = {}): GateAction => ({
  kind: "payment_request", agentKey: "finance", tool: "request_payment", stepId: "payment", requestId: "req-1",
  beneficiary: "Lagos Fresh Foods (demo)", amountNgn: 42_780, channel: { kind: "treasury_contract", method: "request_payment" }, provenance: "system", ...over,
});

describe("D1 · rules and reason codes (doc 05 §3)", () => {
  test.each([
    ["1 kill switch", pay(), ctx({ killSwitch: true }), "BLOCK", ["KILL_SWITCH_ACTIVE"]],
    ["1 agent paused", pay(), ctx({ agent: { status: "paused", allowedTools: ["request_payment"] } }), "BLOCK", ["AGENT_PAUSED"]],
    ["2 no policy", pay(), ctx({ policy: null }), "BLOCK", ["POLICY_MISSING"]],
    ["2 invalid policy (threshold above max)", pay(), ctx({ policy: { ...policy, approvalThresholdNgn: 300_000 } }), "BLOCK", ["POLICY_MISSING"]],
    ["3 agent not on the team", pay(), ctx({ agent: null }), "BLOCK", ["NOT_AUTHORISED"]],
    ["3 agent only proposed", pay(), ctx({ agent: { status: "proposed", allowedTools: ["request_payment"] } }), "BLOCK", ["NOT_AUTHORISED"]],
    ["3 tool not in the definition", pay(), ctx({ agent: { status: "approved", allowedTools: ["read_budget"] } }), "BLOCK", ["NOT_AUTHORISED"]],
    ["3 tool not in the step", pay(), ctx({ stepTools: ["read_budget"] }), "BLOCK", ["NOT_AUTHORISED"]],
    ["3 channel isn't the treasury", pay({ channel: { kind: "direct_transfer", method: "transfer" } }), ctx(), "BLOCK", ["NOT_AUTHORISED"]],
    ["3 invalid amount", pay({ amountNgn: -5 }), ctx(), "BLOCK", ["NOT_AUTHORISED"]],
    ["4 unknown recipient", pay({ beneficiary: "Scam Supplier" }), ctx(), "BLOCK", ["RECIPIENT_NOT_FOUND"]],
    ["5 blocklisted", pay(), ctx({ blocklist: ["Lagos Fresh Foods (demo)"] }), "BLOCK", ["RECIPIENT_BLOCKLISTED"]],
    ["6 over the per-payment limit", pay({ amountNgn: 250_001 }), ctx(), "BLOCK", ["OVER_TX_LIMIT"]],
    ["6 over the daily limit", pay(), ctx({ spentTodayNgn: 460_000 }), "BLOCK", ["OVER_DAILY_LIMIT"]],
    ["7 duplicate request", pay(), ctx({ seenRequestIds: ["req-1"] }), "BLOCK", ["DUPLICATE_REQUEST"]],
    ["8 not an approved recipient", pay({ beneficiary: "QuickSupply Express (demo)" }), ctx(), "WARN", ["RECIPIENT_NOT_APPROVED"]],
    ["8 first interaction", pay({ beneficiary: "Mainland Grains (demo)" }), ctx(), "WARN", ["FIRST_INTERACTION"]],
    ["8 above the threshold", pay({ amountNgn: 56_580 }), ctx(), "WARN", ["ABOVE_APPROVAL_THRESHOLD"]],
    ["8 untrusted source", pay({ provenance: "untrusted" }), ctx(), "WARN", ["UNTRUSTED_INSTRUCTION_SOURCE"]],
    ["8 several reasons, all listed", pay({ beneficiary: "Mainland Grains (demo)", amountNgn: 60_000 }), ctx(), "WARN", ["FIRST_INTERACTION", "ABOVE_APPROVAL_THRESHOLD"]],
    ["9 allow", pay(), ctx(), "ALLOW", []],
  ] as const)("%s", (_n, action, c, decision, reasons) => {
    expect(evaluate(action, c)).toMatchObject({ decision, reasons });
  });

  test("ordering: the kill switch beats everything; BLOCK beats WARN", () => {
    const everything = ctx({ killSwitch: true, policy: null, agent: null, blocklist: ["Lagos Fresh Foods (demo)"], seenRequestIds: ["req-1"] });
    expect(evaluate(pay({ amountNgn: 999_999_999 }), everything).reasons).toEqual(["KILL_SWITCH_ACTIVE"]);
    expect(evaluate(pay({ beneficiary: "Mainland Grains (demo)", amountNgn: 260_000 }), ctx()).reasons).toEqual(["OVER_TX_LIMIT"]);
  });
  test("threshold boundary: equal is ALLOW, one naira over is WARN", () => {
    expect(evaluate(pay({ amountNgn: 50_000 }), ctx()).decision).toBe("ALLOW");
    expect(evaluate(pay({ amountNgn: 50_001 }), ctx())).toMatchObject({ decision: "WARN", reasons: ["ABOVE_APPROVAL_THRESHOLD"] });
  });
  test("daily-limit boundary: reaching the limit exactly is allowed, one naira over is not", () => {
    expect(evaluate(pay({ amountNgn: 40_000 }), ctx({ spentTodayNgn: 460_000 })).decision).toBe("ALLOW");
    expect(evaluate(pay({ amountNgn: 40_001 }), ctx({ spentTodayNgn: 460_000 })).reasons).toEqual(["OVER_DAILY_LIMIT"]);
  });
  test("D2 · test-run decisions are stamped: on-chain checks not run in test mode", () => {
    expect(evaluate(pay(), ctx()).signals).toEqual({ source: "demo_registry", chain_checks: "not_run_in_test_mode", mode: "test_run" });
  });
  test("deterministic: the same inputs always give the same output", () => {
    const a = pay({ beneficiary: "Mainland Grains (demo)", amountNgn: 60_000 });
    expect(new Set(Array.from({ length: 20 }, () => JSON.stringify(evaluate(a, ctx())))).size).toBe(1);
  });
  test("every reason code has plain-language text", () => {
    const codes = ["KILL_SWITCH_ACTIVE", "AGENT_PAUSED", "POLICY_MISSING", "NOT_AUTHORISED", "RECIPIENT_NOT_FOUND", "RECIPIENT_BLOCKLISTED", "OVER_TX_LIMIT", "OVER_DAILY_LIMIT", "DUPLICATE_REQUEST", "RECIPIENT_NOT_APPROVED", "FIRST_INTERACTION", "ABOVE_APPROVAL_THRESHOLD", "UNTRUSTED_INSTRUCTION_SOURCE"];
    for (const c of codes) expect(REASON_TEXT[c]).toBeTruthy();
  });
});

describe("D19 · every tool call passes rules 1–3", () => {
  const call = (tool: string): GateAction => ({ kind: "tool_call", agentKey: "order", tool, stepId: "order_check" });
  const orderCtx = (over: Partial<GateContext> = {}) => ctx({ agent: { status: "approved", allowedTools: ["read_catalogue", "create_order", "send_order_confirmation"] }, stepTools: ["read_catalogue", "create_order"], ...over });
  test("allowed only when the tool is in both the agent's definition and the step", () => {
    expect(evaluate(call("read_catalogue"), orderCtx()).decision).toBe("ALLOW");
    expect(evaluate(call("send_order_confirmation"), orderCtx())).toMatchObject({ decision: "BLOCK", reasons: ["NOT_AUTHORISED"] });   // in definition, not in step
    expect(evaluate(call("request_payment"), orderCtx({ stepTools: ["request_payment"] }))).toMatchObject({ decision: "BLOCK", reasons: ["NOT_AUTHORISED"] });   // not in definition
  });
  test("kill switch, paused agent and missing policy block ordinary tool calls too", () => {
    expect(evaluate(call("read_catalogue"), orderCtx({ killSwitch: true })).reasons).toEqual(["KILL_SWITCH_ACTIVE"]);
    expect(evaluate(call("read_catalogue"), orderCtx({ agent: { status: "paused", allowedTools: ["read_catalogue"] } })).reasons).toEqual(["AGENT_PAUSED"]);
    expect(evaluate(call("read_catalogue"), orderCtx({ policy: null })).reasons).toEqual(["POLICY_MISSING"]);
  });
  test("the Orchestrator has no money tool, and Finance has no transfer tool, in the catalogue", async () => {
    const { AGENT_TEMPLATES } = await import("@/lib/catalogue/catalogue");
    expect(AGENT_TEMPLATES.orchestrator.allowed_tools).not.toEqual(expect.arrayContaining(["request_payment"]));
    expect(AGENT_TEMPLATES.finance.allowed_tools.filter(t => /transfer|send_funds|sign|withdraw/.test(t))).toEqual([]);
  });
});

describe("authorisation · created from the decision, hash-bound, used once, expiring", () => {
  const base: PaymentAction = { businessId: "b", runId: "r", requestId: "q", beneficiary: "Lagos Fresh Foods (demo)", amountNgn: 42_780, method: "request_payment" };
  test("ALLOW → approved automatically; WARN → waits for the owner; BLOCK → none", () => {
    expect([authorisationFor("ALLOW"), authorisationFor("WARN"), authorisationFor("BLOCK")]).toEqual(["auto_approved", "needs_owner", "none"]);
  });
  test("the action hash changes if the payee, amount, request, run or business changes", () => {
    const h = actionHash(base);
    for (const over of [{ beneficiary: "Mainland Grains (demo)" }, { amountNgn: 42_781 }, { requestId: "q2" }, { runId: "r2" }, { businessId: "b2" }]) {
      expect(actionHash({ ...base, ...over })).not.toBe(h);
    }
    expect(actionHash({ ...base })).toBe(h);
  });
  test("expiry is 15 minutes", () => {
    const now = "2026-11-07T10:00:00.000Z";
    expect(expiresAt(now)).toBe("2026-11-07T10:15:00.000Z");
    expect(isExpired(expiresAt(now), "2026-11-07T10:14:59.999Z")).toBe(false);
    expect(isExpired(expiresAt(now), "2026-11-07T10:15:00.000Z")).toBe(true);
  });
  test("used once only; refused if pending, expired, invalidated or the hash doesn't match", async () => {
    const { store } = tempStore();
    const { businessId } = await readyRestaurant(store);
    const hash = actionHash({ ...base, businessId });
    const mk = (status: "pending" | "approved", expires: string) => runTransact(businessId, tx => tx.insertApproval({
      business_id: businessId, run_id: "r", decision_id: "d", request_id: "q", action_hash: hash, amount_ngn: 42_780, beneficiary: base.beneficiary,
      reason_codes: [], status, auto_approved: status === "approved", expires_at: expires, decided_at: null, decided_by: null, consumed_at: null, invalidated_reason: null,
    }));
    const future = new Date(Date.now() + 60_000).toISOString(), past = new Date(Date.now() - 1).toISOString();
    const ok = await mk("approved", future);
    expect(await runTransact(businessId, tx => tx.consumeApproval(businessId, ok.id, "wrong-hash"))).toBe(false);
    expect(await runTransact(businessId, tx => tx.consumeApproval(businessId, ok.id, hash))).toBe(true);
    expect(await runTransact(businessId, tx => tx.consumeApproval(businessId, ok.id, hash))).toBe(false);          // once only
    const pending = await mk("pending", future);
    expect(await runTransact(businessId, tx => tx.consumeApproval(businessId, pending.id, hash))).toBe(false);
    const expired = await mk("approved", past);
    expect(await runTransact(businessId, tx => tx.consumeApproval(businessId, expired.id, hash))).toBe(false);
    const inv = await mk("approved", future);
    await runTransact(businessId, tx => tx.patchApproval(businessId, inv.id, ["approved", "pending"], { status: "invalidated", invalidated_reason: "KILL_SWITCH_ACTIVE" }));
    expect(await runTransact(businessId, tx => tx.consumeApproval(businessId, inv.id, hash))).toBe(false);
    // A decision can't be made twice (compare-and-set on the status).
    const p2 = await mk("pending", future);
    expect(await runTransact(businessId, tx => tx.patchApproval(businessId, p2.id, ["pending"], { status: "approved", decided_by: "owner" }))).toBe(true);
    expect(await runTransact(businessId, tx => tx.patchApproval(businessId, p2.id, ["pending"], { status: "rejected", decided_by: "owner" }))).toBe(false);
    expect(await runRead(businessId, tx => tx.approvals(businessId).find(a => a.id === p2.id)!.status)).toBe("approved");
  });
});
