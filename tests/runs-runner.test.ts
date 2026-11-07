// M4 phase 3 · runner, agents, tools and scenarios. Fictional demo data only; no network (tests/setup.ts
// blocks fetch); no signer, contract or NEAR code anywhere in the run or security code (static test).
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { setDiscoveryRepository, type FileDevStore } from "@/lib/discovery/store";
import { runRead, runTransact } from "@/lib/runs/repo";
import { advanceRun, decideApproval, requestControl, resumeRun, setAgentPaused, setKillSwitch, startRun, MAX_BATCH_STEPS } from "@/lib/runs/runner";
import type { ScenarioKey } from "@/lib/runs/types";
import { readyRestaurant, tempStore } from "./helpers/run-fixture";

afterEach(() => { setDiscoveryRepository(null); vi.useRealTimers(); });

let keySeq = 0;
async function setup(opts: Parameters<typeof readyRestaurant>[1] = {}) {
  const t = tempStore();
  const r = await readyRestaurant(t.store, opts);
  return { ...t, ...r };
}
const start = (b: string, w: string, scenario: ScenarioKey = "standard", key = `key-${++keySeq}`) => startRun(b, { workflowId: w, scenario, idempotencyKey: key });
async function toEnd(b: string, runId: string) {
  for (let i = 0; i < 20; i++) { const r = await advanceRun(b, runId); if (!r.more) return r; }
  throw new Error("did not settle");
}
const state = (b: string, runId: string) => runRead(tx => ({ run: tx.run(b, runId)!, steps: tx.steps(runId), decisions: tx.decisions(b), approvals: tx.approvals(b), ledger: tx.ledger(b), events: tx.events(b) }));

describe("start and advance", () => {
  test("start persists the run and executes nothing; advance runs a bounded batch", async () => {
    const { businessId, workflow } = await setup();
    const { runId, created } = await start(businessId, workflow.id);
    expect(created).toBe(true);
    let s = await state(businessId, runId);
    expect(s.run).toMatchObject({ status: "running", cursor: "trigger", steps_done: 0, mode: "test_run" });
    expect(s.steps).toEqual([]);
    const r = await advanceRun(businessId, runId);
    expect(r.advanced).toBeLessThanOrEqual(MAX_BATCH_STEPS);
    expect(r.advanced).toBeGreaterThan(0);
    s = await state(businessId, runId);
    expect(s.steps.every(x => x.status === "succeeded")).toBe(true);
    expect(s.run.lease_expires_at).toBeNull();                          // lease released after the batch
  });
  test("AT-07: a repeated start with the same key returns the same run", async () => {
    const { businessId, workflow } = await setup();
    const a = await start(businessId, workflow.id, "standard", "same");
    const b = await start(businessId, workflow.id, "standard", "same");
    expect(b).toEqual({ runId: a.runId, created: false });
    expect(await runRead(tx => tx.runs(businessId).length)).toBe(1);
  });
  test("a second start while a run is active is refused (RUN_IN_PROGRESS)", async () => {
    const { businessId, workflow } = await setup();
    await start(businessId, workflow.id);
    await expect(start(businessId, workflow.id)).rejects.toMatchObject({ code: "RUN_IN_PROGRESS", status: 409 });
  });
  test("advance on a run that isn't running is a safe no-op", async () => {
    const { businessId, workflow } = await setup();
    const { runId } = await start(businessId, workflow.id, "quiet_day");
    await toEnd(businessId, runId);
    expect(await advanceRun(businessId, runId)).toEqual({ advanced: 0, more: false, settling: false });
  });
});

describe("D6 · the five scenarios: expected = actual", () => {
  test("Standard order → ALLOW → simulated payment (₦42,780, no transaction) → completed", async () => {
    const { businessId, workflow } = await setup();
    const { runId } = await start(businessId, workflow.id, "standard");
    await toEnd(businessId, runId);
    const s = await state(businessId, runId);
    expect(s.run).toMatchObject({ status: "completed", end_reason: "completed", expected: { decision: "ALLOW", end: "completed" } });
    expect(s.decisions).toMatchObject([{ decision: "ALLOW", reason_codes: [], mode: "test_run", signals: { chain_checks: "not_run_in_test_mode" } }]);
    expect(s.approvals).toMatchObject([{ status: "approved", auto_approved: true }]);
    expect(s.approvals[0].consumed_at).toBeTruthy();
    expect(s.ledger).toEqual([expect.objectContaining({ amount: 42_780, counterparty: "Lagos Fresh Foods (demo)", mode: "test_run", unit: "ngn_illustrative", tx_hash: null, tx_status: "simulated", label: "Test run — no transaction" })]);
    expect(s.steps.map(x => x.step_id)).toEqual(["trigger", "order_check", "notify_customer", "stock_update", "reorder_needed", "supplier_choice", "payment_prepare", "security_check", "owner_approval", "payment", "notify_owner", "end"]);
  });
  test("Large catering order → WARN (above threshold) → waits → owner approves → simulated payment (₦56,580)", async () => {
    const { businessId, workflow } = await setup();
    const { runId } = await start(businessId, workflow.id, "large_catering");
    await toEnd(businessId, runId);
    let s = await state(businessId, runId);
    expect(s.run).toMatchObject({ status: "waiting_approval", expected: { decision: "WARN", end: "approval" } });
    expect(s.decisions[0]).toMatchObject({ decision: "WARN", reason_codes: ["ABOVE_APPROVAL_THRESHOLD"] });
    expect(s.approvals[0]).toMatchObject({ status: "pending", auto_approved: false, amount_ngn: 56_580 });
    expect(s.ledger).toEqual([]);                                        // nothing before approval (FR-13)
    await decideApproval(businessId, s.approvals[0].id, "approve");
    await toEnd(businessId, runId);
    s = await state(businessId, runId);
    expect(s.run.status).toBe("completed");
    expect(s.ledger).toMatchObject([{ amount: 56_580, tx_hash: null }]);
  });
  test("Large catering order rejected → the workflow's rejected route; nothing paid", async () => {
    const { businessId, workflow } = await setup();
    const { runId } = await start(businessId, workflow.id, "large_catering");
    await toEnd(businessId, runId);
    const a = (await state(businessId, runId)).approvals[0];
    await decideApproval(businessId, a.id, "reject");
    await toEnd(businessId, runId);
    const s = await state(businessId, runId);
    expect(s.run).toMatchObject({ status: "rejected", end_reason: "rejected" });
    expect(s.ledger).toEqual([]);
  });
  test("New supplier → Mainland Grains (approved, never paid) → WARN FIRST_INTERACTION, every time (D7)", async () => {
    const { businessId, workflow } = await setup();
    for (let i = 0; i < 2; i++) {
      const { runId } = await start(businessId, workflow.id, "new_supplier");
      await toEnd(businessId, runId);
      let s = await state(businessId, runId);
      expect(s.decisions.at(-1)).toMatchObject({ decision: "WARN", reason_codes: ["FIRST_INTERACTION"] });
      expect((s.run.records.purchase_proposals as Array<{ supplier: string; total_ngn: number }>)[0]).toMatchObject({ supplier: "Mainland Grains (demo)", total_ngn: 44_950 });
      await decideApproval(businessId, s.approvals.at(-1)!.id, "approve");
      await toEnd(businessId, runId);
      s = await state(businessId, runId);
      expect(s.run.status).toBe("completed");
    }
    // The simulated payout never turned Mainland Grains into a "paid before" supplier.
    expect((await runRead(tx => tx.decisions(businessId))).map(d => d.reason_codes)).toEqual([["FIRST_INTERACTION"], ["FIRST_INTERACTION"]]);
  });
  test("Price spike → ₦263,500 over the ₦250,000 maximum → BLOCK OVER_TX_LIMIT; nothing requested or paid", async () => {
    const { businessId, workflow } = await setup();
    const { runId } = await start(businessId, workflow.id, "price_spike");
    await toEnd(businessId, runId);
    const s = await state(businessId, runId);
    expect(s.run).toMatchObject({ status: "blocked", end_reason: "blocked", expected: { decision: "BLOCK", end: "blocked" } });
    expect(s.decisions[0]).toMatchObject({ decision: "BLOCK", reason_codes: ["OVER_TX_LIMIT"] });
    expect(s.approvals).toEqual([]);
    expect(s.ledger).toEqual([]);
  });
  test("Quiet day → no reorder → completed early; no decision", async () => {
    const { businessId, workflow } = await setup();
    const { runId } = await start(businessId, workflow.id, "quiet_day");
    await toEnd(businessId, runId);
    const s = await state(businessId, runId);
    expect(s.run).toMatchObject({ status: "completed", end_reason: "no_reorder", expected: { decision: null, end: "no_reorder" } });
    expect(s.decisions).toEqual([]);
  });
  test("the owner's settings change the outcome: a lower threshold turns the standard order into a WARN", async () => {
    const { DEFAULT_PARAMS } = await import("@/lib/workflows/generate");
    const { businessId, workflow } = await setup({ params: { ...DEFAULT_PARAMS, approval_threshold_ngn: 40_000 } });
    const { runId } = await start(businessId, workflow.id, "standard");
    await toEnd(businessId, runId);
    expect((await state(businessId, runId)).run).toMatchObject({ status: "waiting_approval", expected: { decision: "WARN" } });
  });
});

describe("hand-offs, tools and simulations", () => {
  test("every hand-off records requester, assignee, task, tools and data; external actions are labelled simulations", async () => {
    const { businessId, workflow } = await setup();
    const { runId } = await start(businessId, workflow.id, "standard");
    await toEnd(businessId, runId);
    const s = await state(businessId, runId);
    const by = (id: string) => s.steps.find(x => x.step_id === id)!;
    expect(by("order_check")).toMatchObject({ requester: "orchestrator", agent_key: "order", task_id: "validate", tools_used: ["delegate_task", "read_catalogue", "create_order"], reads: ["products", "orders"], writes: ["orders"] });
    expect(by("notify_customer").simulated).toEqual(["Demo confirmation (not sent)"]);
    expect(by("supplier_choice").simulated).toEqual(["Simulated quote from demo data (no supplier contacted)"]);
    expect(by("supplier_choice").reasoning).toMatch(/QuickSupply Express \(demo\) \(not an approved supplier\)/);
    expect(by("notify_owner").simulated).toEqual(["Shown in EmployAI (no message sent)"]);
    expect(by("payment").simulated).toContain("Test run — no transaction");
    expect(by("security_check").agent_key).toBe("system");
    expect(s.events.filter(e => e.type === "handoff")).toHaveLength(5);
    expect(s.events.every(e => e.correlation_id && e.created_at && e.actor && e.status)).toBe(true);
  });
  test("a tool outside the agent's definition is refused by the gate: the step fails and is never retried", async () => {
    const { businessId, workflow, store } = await setup();
    const { runId } = await start(businessId, workflow.id, "standard");
    const inv = (await store.listAgents(businessId)).find(a => a.key === "inventory")!;
    await store.updateAgent(businessId, "inventory", { definition: { ...inv.definition, allowed_tools: ["read_stock"] } });
    await toEnd(businessId, runId);
    const s = await state(businessId, runId);
    expect(s.run).toMatchObject({ status: "failed", end_reason: "NOT_AUTHORISED" });
    expect(s.steps.filter(x => x.step_id === "stock_update")).toEqual([expect.objectContaining({ status: "failed", attempt: 1 })]);
    expect(s.ledger).toEqual([]);
  });
  test("reduced team (Order Agent only): the reduced workflow runs, coordinated by the runner", async () => {
    const { businessId, workflow } = await setup({ caps: ["order_intake"] });
    const { runId } = await start(businessId, workflow.id, "standard");
    await toEnd(businessId, runId);
    const s = await state(businessId, runId);
    expect(s.run.status).toBe("completed");
    expect(s.steps.find(x => x.step_id === "order_check")!.requester).toBe("runner");
    expect(s.decisions).toEqual([]);
    expect(s.run.expected).toEqual({ decision: null, end: "completed" });
  });
  test("runs never write to the business profile or case file", async () => {
    const { businessId, workflow, store } = await setup();
    const before = (await store.getBusiness(businessId))!.profile;
    const { runId } = await start(businessId, workflow.id, "large_catering");
    await toEnd(businessId, runId);
    expect((await store.getBusiness(businessId))!.profile).toEqual(before);
  });
});

describe("concurrency and control signals during a batch (§5.6)", () => {
  test("two advances at once are serialised: no step is executed twice", async () => {
    const { businessId, workflow } = await setup();
    const { runId } = await start(businessId, workflow.id, "standard");
    await Promise.all([advanceRun(businessId, runId), advanceRun(businessId, runId), advanceRun(businessId, runId)]);
    await toEnd(businessId, runId);
    const s = await state(businessId, runId);
    const ids = s.steps.filter(x => x.status === "succeeded").map(x => x.step_id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(s.ledger).toHaveLength(1);
  });
  test("the kill switch pressed while a step executes: flag persisted at once, commit refused, run cancelled", async () => {
    const { businessId, workflow } = await setup();
    const { runId } = await start(businessId, workflow.id, "standard");
    await advanceRun(businessId, runId);                             // trigger … stock_update (5 steps)
    expect((await state(businessId, runId)).run.cursor).toBe("supplier_choice");
    let kill!: Promise<unknown>;
    const r = await advanceRun(businessId, runId, { beforeCommit: async id => { if (id === "supplier_choice" && !kill) { kill = setKillSwitch(businessId, true); await new Promise(res => setTimeout(res, 5)); } } });
    expect(r.more).toBe(false);
    expect(await kill).toEqual({ finalised: true });                 // finalised once the batch released the lock
    const s = await state(businessId, runId);
    expect(s.run).toMatchObject({ status: "cancelled", end_reason: "KILL_SWITCH_ACTIVE" });
    expect(s.steps.find(x => x.step_id === "supplier_choice")).toMatchObject({ status: "cancelled" });
    expect(s.run.records.reorder).toBeTruthy();                      // earlier steps stay committed…
    expect(s.run.records.purchase_proposals).toBeUndefined();        // …the cut-off step's effects were discarded…
    expect(s.steps.some(x => x.step_id === "payment_prepare")).toBe(false);   // …and nothing after it ran
    await expect(start(businessId, workflow.id)).rejects.toMatchObject({ code: "KILL_SWITCH_ACTIVE" });
  });
  test("pause requested during a step: that step commits, then the run pauses; resume continues", async () => {
    const { businessId, workflow } = await setup();
    const { runId } = await start(businessId, workflow.id, "quiet_day");
    let p!: Promise<unknown>;
    await advanceRun(businessId, runId, { beforeCommit: async id => { if (id === "order_check" && !p) { p = requestControl(businessId, runId, "pause"); await new Promise(res => setTimeout(res, 5)); } } });
    await p;
    let s = await state(businessId, runId);
    expect(s.run).toMatchObject({ status: "paused", pause_reason: "owner", control: null });
    expect(s.steps.find(x => x.step_id === "order_check")!.status).toBe("succeeded");
    expect(s.steps.some(x => x.step_id === "notify_customer")).toBe(false);
    await resumeRun(businessId, runId);
    await toEnd(businessId, runId);
    s = await state(businessId, runId);
    expect(s.run.status).toBe("completed");
  });
  test("stop requested during a step: the commit is refused and the run is cancelled", async () => {
    const { businessId, workflow } = await setup();
    const { runId } = await start(businessId, workflow.id, "standard");
    let p!: Promise<unknown>;
    await advanceRun(businessId, runId, { beforeCommit: async id => { if (id === "order_check" && !p) { p = requestControl(businessId, runId, "stop"); await new Promise(res => setTimeout(res, 5)); } } });
    await p;
    const s = await state(businessId, runId);
    expect(s.run).toMatchObject({ status: "cancelled", end_reason: "STOPPED_BY_OWNER" });
    expect(s.steps.find(x => x.step_id === "order_check")!.status).toBe("cancelled");
    expect((s.run.records.orders as Array<{ status: string }>)[0].status).toBe("received");   // the step's effects were discarded
  });
});

describe("approvals: re-checked, single decision, expiry, kill switch", () => {
  const waiting = async () => {
    const env = await setup();
    const { runId } = await start(env.businessId, env.workflow.id, "large_catering");
    await toEnd(env.businessId, runId);
    const a = (await state(env.businessId, runId)).approvals[0];
    return { ...env, runId, a };
  };
  test("a second decision is refused (ALREADY_DECIDED) and there is still exactly one payment outcome", async () => {
    const { businessId, runId, a } = await waiting();
    await decideApproval(businessId, a.id, "approve");
    await expect(decideApproval(businessId, a.id, "approve")).rejects.toMatchObject({ code: "ALREADY_DECIDED" });
    await toEnd(businessId, runId);
    expect((await state(businessId, runId)).ledger).toHaveLength(1);
  });
  test("approve after stop is refused; the approval is invalidated and nothing is paid", async () => {
    const { businessId, runId, a } = await waiting();
    await requestControl(businessId, runId, "stop");
    await expect(decideApproval(businessId, a.id, "approve")).rejects.toMatchObject({ status: 409 });
    const s = await state(businessId, runId);
    expect(s.run.status).toBe("cancelled");
    expect(s.approvals[0].status).toBe("invalidated");
    expect(s.ledger).toEqual([]);
  });
  test("the kill switch invalidates a pending approval (AT-11, in-app form)", async () => {
    const { businessId, runId } = await waiting();
    await setKillSwitch(businessId, true);
    const s = await state(businessId, runId);
    expect(s.run.status).toBe("cancelled");
    expect(s.approvals[0]).toMatchObject({ status: "invalidated", invalidated_reason: "KILL_SWITCH_ACTIVE" });
  });
  test("an approval expires after 15 minutes: the next advance takes the rejected route; a late decision is refused", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { businessId, runId, a } = await waiting();
    vi.setSystemTime(Date.now() + 16 * 60 * 1000);
    await toEnd(businessId, runId);
    const s = await state(businessId, runId);
    expect(s.approvals[0].status).toBe("expired");
    expect(s.run.status).toBe("rejected");
    expect(s.ledger).toEqual([]);
    await expect(decideApproval(businessId, a.id, "approve")).rejects.toMatchObject({ code: "APPROVAL_EXPIRED" });
  });
});

describe("recovery: interruption, reconciliation, workflow changes, agent pause", () => {
  /** Advance one step at a time until the cursor reaches `stepId`. */
  async function stepUntil(b: string, runId: string, stepId: string) {
    for (let i = 0; i < 20; i++) {
      const r = (await state(b, runId)).run;
      if (r.cursor === stepId || r.status !== "running") return;
      // Pause right after the next commit by injecting a pause request, then resume: a precise single step.
      await advanceRun(b, runId, { beforeCommit: async () => { await runTransact(tx => tx.setRunControl(b, runId, "pause")); } });
      await resumeRun(b, runId);
    }
  }
  const crashAt = (b: string, runId: string, stepId: string, leaseMsFromNow: number) => runTransact(tx => {
    tx.insertStep({ run_id: runId, business_id: b, step_id: stepId, step_type: "x", agent_key: "system", requester: "runner", task_id: null, status: "running", attempt: 1,
      input: null, output: null, reasoning: null, tools_used: [], reads: [], writes: [], simulated: [], started_at: tx.now, ended_at: null, duration_ms: null, error: null });
    tx.patchRun(b, runId, { lease_expires_at: new Date(Date.now() + leaseMsFromNow).toISOString() });
  });
  test("a step cut off mid-execution: settling while the lease is valid; interrupted after; resume re-runs it (attempt 2)", async () => {
    const { businessId, workflow } = await setup();
    const { runId } = await start(businessId, workflow.id, "quiet_day");
    await crashAt(businessId, runId, "trigger", 60_000);
    expect(await advanceRun(businessId, runId)).toMatchObject({ advanced: 0, more: false, settling: true });
    await expect(resumeRun(businessId, runId)).rejects.toMatchObject({ code: "STEP_SETTLING" });
    await runTransact(tx => tx.patchRun(businessId, runId, { lease_expires_at: new Date(Date.now() - 1).toISOString() }));
    await advanceRun(businessId, runId);
    expect((await state(businessId, runId)).run.status).toBe("interrupted");
    await resumeRun(businessId, runId);
    await toEnd(businessId, runId);
    const s = await state(businessId, runId);
    expect(s.run.status).toBe("completed");
    expect(s.steps.filter(x => x.step_id === "trigger").map(x => [x.status, x.attempt])).toEqual([["interrupted", 1], ["succeeded", 2]]);
  });
  test("a crash at the payment step: resume pays once (authorisation used once); never a second outcome", async () => {
    const { businessId, workflow } = await setup();
    const { runId } = await start(businessId, workflow.id, "standard");
    await stepUntil(businessId, runId, "payment");
    expect((await state(businessId, runId)).run.cursor).toBe("payment");
    await crashAt(businessId, runId, "payment", -1);
    await advanceRun(businessId, runId);
    await resumeRun(businessId, runId);
    await toEnd(businessId, runId);
    const s = await state(businessId, runId);
    expect(s.run.status).toBe("completed");
    expect(s.ledger).toHaveLength(1);
    expect(s.approvals[0].consumed_at).toBeTruthy();
  });
  test("reconciliation: if an outcome for the request already exists, it is reused, not repeated", async () => {
    const { businessId, workflow } = await setup();
    const { runId } = await start(businessId, workflow.id, "standard");
    await stepUntil(businessId, runId, "payment");
    await runTransact(tx => tx.appendLedger({ business_id: businessId, run_id: runId, type: "supplier_payout", mode: "test_run", amount: 42_780, unit: "ngn_illustrative", counterparty: "Lagos Fresh Foods (demo)", agent_key: "finance", tx_hash: null, tx_status: "simulated", request_id: `${runId}:payment`, label: "Test run — no transaction" }));
    await toEnd(businessId, runId);
    const s = await state(businessId, runId);
    expect(s.ledger).toHaveLength(1);
    expect(s.steps.find(x => x.step_id === "payment")!.output).toMatchObject({ reconciled: true });
  });
  test("the approved workflow changed after start → failed WORKFLOW_CHANGED; nothing further runs (C5)", async () => {
    const { businessId, workflow, store } = await setup();
    const { runId } = await start(businessId, workflow.id, "standard");
    await advanceRun(businessId, runId);
    await store.updateWorkflow(businessId, workflow.id, { steps: { ...workflow.steps, params: { ...workflow.steps.params, approval_threshold_ngn: 100_000 } } });
    await toEnd(businessId, runId);
    const s = await state(businessId, runId);
    expect(s.run).toMatchObject({ status: "failed", end_reason: "WORKFLOW_CHANGED" });
    expect(s.decisions).toEqual([]);
    expect(s.ledger).toEqual([]);
  });
  test("a paused agent's step doesn't start; resuming the agent lets the run continue (D4)", async () => {
    const { businessId, workflow } = await setup();
    const { runId } = await start(businessId, workflow.id, "standard");
    await setAgentPaused(businessId, "procurement", true);
    await toEnd(businessId, runId);
    let s = await state(businessId, runId);
    expect(s.run).toMatchObject({ status: "paused", pause_reason: "agent_paused:procurement", cursor: "supplier_choice" });
    await expect(resumeRun(businessId, runId)).rejects.toMatchObject({ code: "AGENT_STILL_PAUSED" });
    await setAgentPaused(businessId, "procurement", false);
    await toEnd(businessId, runId);
    s = await state(businessId, runId);
    expect(s.run.status).toBe("completed");
  });
  test("a Finance Agent paused before the security check: the payment request is BLOCK AGENT_PAUSED", async () => {
    const { businessId, workflow } = await setup();
    const { runId } = await start(businessId, workflow.id, "standard");
    await stepUntil(businessId, runId, "security_check");
    await setAgentPaused(businessId, "finance", true);
    await toEnd(businessId, runId);
    const s = await state(businessId, runId);
    expect(s.decisions[0]).toMatchObject({ decision: "BLOCK", reason_codes: ["AGENT_PAUSED"] });
    expect(s.run.status).toBe("blocked");
    expect(s.ledger).toEqual([]);
  });
});

describe("C1–C4 · no side effects outside the run (static checks)", () => {
  const files = ["src/lib/runs", "src/lib/security"].flatMap(d => readdirSync(path.join(process.cwd(), d)).filter(f => f.endsWith(".ts")).map(f => path.join(d, f)));
  test("no network, process, signer, NEAR or contract code in the run and security code", () => {
    const forbidden = /\bfetch\s*\(|XMLHttpRequest|WebSocket|node:https?\b|node:net\b|node:dgram|node:child_process|child_process|node:fs|from "fs"|near-api-js|@near-js|near-kit|signTransaction|signAndSend|functionCall\(|privateKey|secretKey|process\.env/;
    for (const f of files) expect([f, forbidden.test(readFileSync(path.join(process.cwd(), f), "utf8"))]).toEqual([f, false]);
  });
  test("agent handlers can't commit: they import no repository or store", () => {
    const src = readFileSync(path.join(process.cwd(), "src/lib/runs/agents.ts"), "utf8");
    expect(/from "\.\/repo"|lib\/discovery\/store|runTransact|transact\(/.test(src)).toBe(false);
  });
  test("every simulated external tool is labelled; none is a real external action", async () => {
    const { TOOLS } = await import("@/lib/runs/tools");
    const sim = Object.entries(TOOLS).filter(([, t]) => t.class === "simulated_external");
    expect(sim.map(([k]) => k).sort()).toEqual(["notify_owner", "request_quote", "send_order_confirmation"]);
    for (const [, t] of sim) expect(t.label).toMatch(/not sent|no supplier contacted|no message sent/);
    expect(TOOLS.request_payment.class).toBe("payment_request");
  });
  test("reading run state never writes the store file", async () => {
    const { businessId, workflow, file } = await setup();
    const { runId } = await start(businessId, workflow.id, "large_catering");
    await toEnd(businessId, runId);
    const before = createHash("sha256").update(readFileSync(file)).digest("hex");
    await state(businessId, runId);
    expect(createHash("sha256").update(readFileSync(file)).digest("hex")).toBe(before);
  });
});

export type { FileDevStore };
