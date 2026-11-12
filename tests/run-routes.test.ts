// M4 phase 4 · run routes: real route handlers + runner + an isolated dev store. Fictional demo data only,
// no network (fetch blocked), no signing or transactions anywhere.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { RunView, RunsView } from "@/lib/runs/view-types";

const h = vi.hoisted(() => ({ jar: new Map<string, string>(), headers: new Map<string, string>([["host", "localhost:3101"]]) }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (n: string) => (h.jar.has(n) ? { name: n, value: h.jar.get(n)! } : undefined),
    set: (n: string, v: string) => { h.jar.set(n, v); },
  }),
  headers: async () => ({ get: (n: string) => h.headers.get(n.toLowerCase()) ?? null }),
}));

import { GET as listRuns, POST as startRunRoute } from "@/app/api/w/[id]/runs/route";
import { GET as getRun } from "@/app/api/w/[id]/runs/[runId]/route";
import { POST as advance } from "@/app/api/w/[id]/runs/[runId]/advance/route";
import { POST as pause } from "@/app/api/w/[id]/runs/[runId]/pause/route";
import { POST as resume } from "@/app/api/w/[id]/runs/[runId]/resume/route";
import { POST as stop } from "@/app/api/w/[id]/runs/[runId]/stop/route";
import { POST as decide } from "@/app/api/w/[id]/approvals/[approvalId]/route";
import { POST as killSwitch } from "@/app/api/w/[id]/kill-switch/route";
import { PATCH as patchAgent } from "@/app/api/w/[id]/team/[agentKey]/route";
import { hashOwnerToken, setDiscoveryRepository } from "@/lib/discovery/store";
import { runTransact } from "@/lib/runs/repo";
import { blockedFetch } from "./setup";
import { storeDigest } from "./helpers/store";
import { readyRestaurant, tempStore, type FixtureOptions } from "./helpers/run-fixture";

const ORIGIN = "http://localhost:3101";
const TOKEN = "t".repeat(43);
const req = (method: string, body?: unknown, extra: Record<string, string> = {}) =>
  new Request(`${ORIGIN}/x`, { method, headers: { "content-type": "application/json", origin: ORIGIN, ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
const ctx = (id: string, more: Record<string, string> = {}) => ({ params: Promise.resolve({ id, ...more }) }) as never;
type Body = { view?: RunsView; run?: RunView; more?: boolean; created?: boolean; advanced?: number; settling?: boolean; finalised?: boolean; error?: { code: string } };
const json = async (r: Response) => (await r.json()) as Body;
let keySeq = 0;

beforeEach(() => { h.jar.clear(); h.jar.set("eai_owner", TOKEN); for (const m of ["log", "info", "warn", "error"] as const) vi.spyOn(console, m).mockImplementation(() => {}); });
afterEach(() => { setDiscoveryRepository(null); vi.useRealTimers(); });

async function env(opts: FixtureOptions = {}) {
  const t = tempStore();
  const r = await readyRestaurant(t.store, { ownerHash: hashOwnerToken(TOKEN), ...opts });
  return { ...t, ...r };
}
const startReq = (b: string, w: string, scenario = "standard", key = `idem-key-${++keySeq}`) =>
  startRunRoute(req("POST", { workflow_id: w, scenario }, { "idempotency-key": key }), ctx(b));
async function runToEnd(b: string, runId: string): Promise<Body> {
  let last: Body = {};
  for (let i = 0; i < 20; i++) {
    const r = await advance(req("POST", {}), ctx(b, { runId }));
    expect(r.status).toBe(200);
    last = await json(r);
    if (!last.more) return last;
  }
  throw new Error("did not settle");
}
const sha = (f: string) => storeDigest(f);

describe("start → advance → end, through the routes", () => {
  test("start needs an Idempotency-Key; it persists the run and executes nothing; a repeat returns the same run", async () => {
    const { businessId, workflow } = await env();
    expect((await startRunRoute(req("POST", { workflow_id: workflow.id, scenario: "standard" }), ctx(businessId))).status).toBe(400);
    const r = await startReq(businessId, workflow.id, "standard", "the-same-key");
    expect(r.status).toBe(200);
    const b = await json(r);
    expect(b).toMatchObject({ created: true, more: true, run: { run: { status: "running", stepsDone: 0, mode: "test_run" }, steps: [] } });
    const again = await json(await startReq(businessId, workflow.id, "standard", "the-same-key"));
    expect(again).toMatchObject({ created: false, run: { run: { id: b.run!.run.id } } });
  });
  test("standard order end to end: ALLOW, simulated payment, expected = actual, every money row labelled", async () => {
    const { businessId, workflow } = await env();
    const runId = (await json(await startReq(businessId, workflow.id))).run!.run.id;
    const end = await runToEnd(businessId, runId);
    expect(end.run!.run).toMatchObject({ status: "completed", expected: { decision: "ALLOW", end: "completed" }, actual: { decision: "ALLOW", end: "completed" } });
    expect(end.run!.ledger).toEqual([expect.objectContaining({ amountText: "₦42,780", mode: "test_run", label: "Test run — no transaction", txHash: null })]);
    expect(end.run!.steps.find(s => s.stepId === "notify_customer")!.simulated).toEqual(["Demo confirmation (not sent)"]);
    expect(end.view!.runs[0]).toMatchObject({ id: runId, status: "completed", scenarioTitle: "Standard order" });
    expect(blockedFetch).not.toHaveBeenCalled();
  });
  test("WARN waits for the owner; approve (re-checked) continues; a second decision is refused", async () => {
    const { businessId, workflow } = await env();
    const runId = (await json(await startReq(businessId, workflow.id, "large_catering"))).run!.run.id;
    const w = await runToEnd(businessId, runId);
    expect(w.run!.run.status).toBe("waiting_approval");
    expect(w.run!.approval).toMatchObject({ status: "pending", amountNgn: 56_580, reasons: [{ code: "ABOVE_APPROVAL_THRESHOLD" }], thresholdNgn: 50_000, maxPaymentNgn: 250_000 });
    expect(w.run!.approval!.rationale).toMatch(/Lagos Fresh Foods \(demo\)/);
    const id = w.run!.approval!.id;
    expect((await decide(req("POST", { decision: "approve" }), ctx(businessId, { approvalId: id }))).status).toBe(200);
    const second = await decide(req("POST", { decision: "approve" }), ctx(businessId, { approvalId: id }));
    expect([second.status, (await json(second)).error!.code]).toEqual([409, "ALREADY_DECIDED"]);
    const end = await runToEnd(businessId, runId);
    expect(end.run!.run.status).toBe("completed");
    expect(end.run!.ledger).toHaveLength(1);
  });
  test("reject → the rejected route; nothing paid", async () => {
    const { businessId, workflow } = await env();
    const runId = (await json(await startReq(businessId, workflow.id, "new_supplier"))).run!.run.id;
    const w = await runToEnd(businessId, runId);
    await decide(req("POST", { decision: "reject" }), ctx(businessId, { approvalId: w.run!.approval!.id }));
    const end = await runToEnd(businessId, runId);
    expect(end.run!.run).toMatchObject({ status: "rejected" });
    expect(end.run!.ledger).toEqual([]);
  });
});

describe("GET is strictly read-only (D11)", () => {
  test("GET never changes the store file, even for an expired approval or a stale lease; it only shows them", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { businessId, workflow, file } = await env();
    const runId = (await json(await startReq(businessId, workflow.id, "large_catering"))).run!.run.id;
    await runToEnd(businessId, runId);
    vi.setSystemTime(Date.now() + 16 * 60_000);
    const before = sha(file);
    const g = await json(await getRun(req("GET"), ctx(businessId, { runId })));
    await listRuns(req("GET"), ctx(businessId));
    expect(sha(file)).toBe(before);
    expect(g.run!.approval).toMatchObject({ status: "pending", expiredNotPersisted: true });
    // The next mutating call (advance) persists the expiry and takes the rejected route.
    const end = await runToEnd(businessId, runId);
    expect(end.run!.approval!.status).toBe("expired");
    expect(end.run!.run.status).toBe("rejected");
  });
  test("a stale lease is shown as interrupted (detected) without being persisted", async () => {
    const { businessId, workflow, file } = await env();
    const runId = (await json(await startReq(businessId, workflow.id, "quiet_day"))).run!.run.id;
    await runTransact(businessId, tx => {
      tx.insertStep({ run_id: runId, business_id: businessId, step_id: "trigger", step_type: "trigger", agent_key: "system", requester: "runner", task_id: null, status: "running", attempt: 1,
        input: null, output: null, reasoning: null, tools_used: [], reads: [], writes: [], simulated: [], started_at: tx.now, ended_at: null, duration_ms: null, error: null });
      tx.patchRun(businessId, runId, { lease_expires_at: new Date(Date.now() - 1000).toISOString() });
    });
    const before = sha(file);
    const g = await json(await getRun(req("GET"), ctx(businessId, { runId })));
    expect(sha(file)).toBe(before);
    expect(g.run!.run).toMatchObject({ status: "running", interruptedDetected: true, settling: false });
    expect(g.run!.more).toBe(false);
    await json(await advance(req("POST", {}), ctx(businessId, { runId })));
    expect((await json(await getRun(req("GET"), ctx(businessId, { runId })))).run!.run.status).toBe("interrupted");
    expect((await resume(req("POST", {}), ctx(businessId, { runId }))).status).toBe(200);
    expect((await runToEnd(businessId, runId)).run!.run.status).toBe("completed");
  });
});

describe("§4 · start refusals by the server", () => {
  test.each([
    ["PREVIEW_ONLY", { industry: "Salon / beauty services" }],
    ["DISCOVERY_INCOMPLETE", { preM35: true }],
    ["REAPPROVAL_REQUIRED", { legacy: true }],
  ] as const)("%s", async (code, opts) => {
    const { businessId, workflow } = await env(opts);
    const r = await startReq(businessId, workflow.id);
    expect([r.status, (await json(r)).error!.code]).toEqual([409, code]);
    const v = await json(await listRuns(req("GET"), ctx(businessId)));
    expect(v.view!.eligibility).toMatchObject({ canRun: false, code });
  });
  test("RUN_IN_PROGRESS, KILL_SWITCH_ACTIVE, WORKFLOW_NOT_APPROVED, APPROVAL_FINGERPRINT_MISMATCH", async () => {
    const { businessId, workflow, store } = await env();
    await startReq(businessId, workflow.id);
    expect((await json(await startReq(businessId, workflow.id))).error!.code).toBe("RUN_IN_PROGRESS");
    await killSwitch(req("POST", { active: true }), ctx(businessId));
    expect((await json(await startReq(businessId, workflow.id))).error!.code).toBe("KILL_SWITCH_ACTIVE");
    await killSwitch(req("POST", { active: false }), ctx(businessId));
    expect((await json(await startReq(businessId, "00000000-0000-4000-8000-000000000000"))).error!.code).toBe("WORKFLOW_NOT_APPROVED");
    await store.updateWorkflow(businessId, workflow.id, { steps: { ...workflow.steps, name: "Tampered" } });
    expect((await json(await startReq(businessId, workflow.id))).error!.code).toBe("APPROVAL_FINGERPRINT_MISMATCH");
  });
});

describe("controls: pause, resume, stop, kill switch, agent pause", () => {
  test("pause → paused; resume → continues; stop → cancelled", async () => {
    const { businessId, workflow } = await env();
    const runId = (await json(await startReq(businessId, workflow.id, "quiet_day"))).run!.run.id;
    const p = await json(await pause(req("POST", {}), ctx(businessId, { runId })));
    expect(p).toMatchObject({ finalised: true, run: { run: { status: "paused", pauseReason: "owner" } } });
    expect((await json(await advance(req("POST", {}), ctx(businessId, { runId })))).advanced).toBe(0);
    await resume(req("POST", {}), ctx(businessId, { runId }));
    expect((await runToEnd(businessId, runId)).run!.run.status).toBe("completed");
    const run2 = (await json(await startReq(businessId, workflow.id, "large_catering"))).run!.run.id;
    await runToEnd(businessId, run2);
    const s = await json(await stop(req("POST", {}), ctx(businessId, { runId: run2 })));
    expect(s.run!.run.status).toBe("cancelled");
    expect(s.run!.approval!.status).toBe("invalidated");
  });
  test("kill switch: cancels the active run, invalidates the pending approval, blocks new starts", async () => {
    const { businessId, workflow } = await env();
    const runId = (await json(await startReq(businessId, workflow.id, "large_catering"))).run!.run.id;
    const w = await runToEnd(businessId, runId);
    const k = await json(await killSwitch(req("POST", { active: true }), ctx(businessId)));
    expect(k).toMatchObject({ finalised: true, view: { killSwitch: true, activeRunId: null } });
    const after = await json(await getRun(req("GET"), ctx(businessId, { runId })));
    expect(after.run!.run.status).toBe("cancelled");
    expect(after.run!.approval!.status).toBe("invalidated");
    const late = await decide(req("POST", { decision: "approve" }), ctx(businessId, { approvalId: w.run!.approval!.id }));
    expect(late.status).toBe(409);
    expect(after.run!.ledger).toEqual([]);
  });
  test("agent pause and resume through the team route (approved agents only)", async () => {
    const { businessId, workflow } = await env();
    expect((await patchAgent(req("PATCH", { status: "paused" }), ctx(businessId, { agentKey: "procurement" }))).status).toBe(200);
    const runId = (await json(await startReq(businessId, workflow.id))).run!.run.id;
    const r = await runToEnd(businessId, runId);
    expect(r.run!.run).toMatchObject({ status: "paused", pauseReason: "agent_paused:procurement" });
    expect((await patchAgent(req("PATCH", { status: "approved" }), ctx(businessId, { agentKey: "procurement" }))).status).toBe(200);
    expect((await runToEnd(businessId, runId)).run!.run.status).toBe("completed");
    expect((await patchAgent(req("PATCH", { status: "approved" }), ctx(businessId, { agentKey: "procurement" }))).status).toBe(409);
  });
});

describe("ownership, origin and the case file", () => {
  test("another browser gets 404 on every run route; nothing leaks", async () => {
    const { businessId, workflow } = await env();
    const runId = (await json(await startReq(businessId, workflow.id))).run!.run.id;
    h.jar.set("eai_owner", "z".repeat(43));
    const calls: Array<Promise<Response>> = [
      listRuns(req("GET"), ctx(businessId)), getRun(req("GET"), ctx(businessId, { runId })), advance(req("POST", {}), ctx(businessId, { runId })),
      pause(req("POST", {}), ctx(businessId, { runId })), stop(req("POST", {}), ctx(businessId, { runId })), resume(req("POST", {}), ctx(businessId, { runId })),
      killSwitch(req("POST", { active: true }), ctx(businessId)), startReq(businessId, workflow.id),
      decide(req("POST", { decision: "approve" }), ctx(businessId, { approvalId: "00000000-0000-4000-8000-000000000000" })),
    ];
    for (const r of await Promise.all(calls)) { expect(r.status).toBe(404); expect(JSON.stringify(await r.json())).not.toContain(runId); }
  });
  test("cross-origin and non-JSON mutations are refused", async () => {
    const { businessId, workflow } = await env();
    expect((await startRunRoute(req("POST", { workflow_id: workflow.id, scenario: "standard" }, { origin: "https://evil.example", "idempotency-key": "cross-origin-key" }), ctx(businessId))).status).toBe(403);
    const plain = new Request(`${ORIGIN}/x`, { method: "POST", headers: { "content-type": "text/plain", origin: ORIGIN }, body: "{}" });
    expect((await killSwitch(plain, ctx(businessId))).status).toBe(415);
  });
  test("D15: the runs view shows what the workflow addresses from the case file, read-only; runs never write to it", async () => {
    const { businessId, workflow, store } = await env();
    const b = (await store.getBusiness(businessId))!;
    const cf = structuredClone(b.profile.case_file!);
    cf.claims.push({ id: "c1", kind: "symptom", text: "We often run out of rice", status: "stated", sources: ["m1"], problem_id: "p1" });
    cf.problems.push({ id: "p1", playbook: "running_out", symptom_claim: "c1", cause_claim: null, resolution: "cause_confirmed", probes: 2, uncertainty: null,
      hypotheses: [{ key: "manual_ordering", status: "confirmed", evidence: ["m1"], owner_view: false }] });
    await store.updateBusiness(businessId, { profile: { ...b.profile, case_file: cf } });
    const before = (await store.getBusiness(businessId))!.profile;
    const v = await json(await listRuns(req("GET"), ctx(businessId)));
    expect(v.view!.addresses).toEqual([{ kind: "problem", text: "We often run out of rice", cause: "reordering by phone or in person takes time and gets delayed", basis: "Confirmed by you" }]);
    const runId = (await json(await startReq(businessId, workflow.id))).run!.run.id;
    await runToEnd(businessId, runId);
    expect((await store.getBusiness(businessId))!.profile).toEqual(before);
  });
});
