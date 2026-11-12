// M4 phase 1 · foundations: shared lock, store additions (no migration rewrite), run repository
// (compare-and-set, field ownership, append-only), approval fingerprints and start-time eligibility.
// Offline only: tests/setup.ts blocks fetch.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { FileDevStore, setDiscoveryRepository, type DiscoveryRepository } from "@/lib/discovery/store";
import { sharedMode } from "./helpers/store";
import { LockBusyError, isBusinessLockHeld, withBusinessLock } from "@/lib/locks";
import { checkRunEligibility } from "@/lib/runs/eligibility";
import { FINGERPRINT_ALG, canonicalJson, workflowFingerprint } from "@/lib/runs/fingerprint";
import { RunTx, runRead, runTransact } from "@/lib/runs/repo";
import type { RunRecord } from "@/lib/runs/types";
import { approveWorkflow } from "@/lib/workflows/service";
import { readyRestaurant, tempStore } from "./helpers/run-fixture";

afterEach(() => setDiscoveryRepository(null));
const sha = (f: string) => createHash("sha256").update(readFileSync(f)).digest("hex");

describe("D20 · one shared business lock", () => {
  test("try mode fails fast while held; wait mode queues FIFO; the bounded wait times out", async () => {
    const order: string[] = [];
    let release!: () => void;
    const holder = withBusinessLock("b1", () => new Promise<void>(r => { release = r; order.push("holder"); }), { mode: "wait" });
    await Promise.resolve();
    expect(isBusinessLockHeld("b1")).toBe(true);
    await expect(withBusinessLock("b1", async () => "x", { mode: "try" })).rejects.toBeInstanceOf(LockBusyError);
    const second = withBusinessLock("b1", async () => { order.push("second"); }, { mode: "wait" });
    const third = withBusinessLock("b1", async () => { order.push("third"); }, { mode: "wait" });
    const timedOut = withBusinessLock("b1", async () => { order.push("never"); }, { mode: "wait", timeoutMs: 20 });
    await expect(timedOut).rejects.toBeInstanceOf(LockBusyError);
    release();
    await Promise.all([holder, second, third]);
    expect(order).toEqual(["holder", "second", "third"]);
    expect(isBusinessLockHeld("b1")).toBe(false);
  });
  test("different businesses never block each other", async () => {
    let release!: () => void;
    const a = withBusinessLock("A", () => new Promise<void>(r => { release = r; }), { mode: "wait" });
    await expect(withBusinessLock("B", async () => "ok", { mode: "try" })).resolves.toBe("ok");
    release(); await a;
  });
  test("the registry is process-wide (globalThis), so every module shares it", () => {
    expect((globalThis as Record<symbol, unknown>)[Symbol.for("employai.businessLocks")]).toBeInstanceOf(Map);
  });
});

describe("§11.1 · store additions rewrite nothing", () => {
  // File-store specific (it reads a copy of the real local file); the migration tests cover the shared store.
  test.skipIf(sharedMode)("a copy of the current dev store loads unchanged, and reading never rewrites the file", async () => {
    const real = path.join(process.cwd(), ".data", "dev-store.json");
    if (!existsSync(real)) return;                                   // nothing to compare on a fresh checkout
    const { dir, file } = tempStore();
    copyFileSync(real, file);
    const before = sha(file);
    const original = JSON.parse(readFileSync(file, "utf8"));
    const store = new FileDevStore(dir);
    for (const id of Object.keys(original.businesses)) {
      expect(await store.getBusiness(id)).toEqual(original.businesses[id]);
      expect(await store.listAgents(id)).toEqual(original.agents[id] ?? []);
      expect(await store.listWorkflows(id)).toEqual((original.workflows ?? {})[id] ?? []);
    }
    // Runs read back exactly as stored (the real store may already contain runs from local use).
    const storedRuns = Object.keys(original.businesses).map(id => ((original.runs ?? {})[id] ?? []).length).reduce((a: number, b: number) => a + b, 0);
    let readRuns = 0;
    for (const id of Object.keys(original.businesses)) readRuns += await runRead(id, tx => tx.runs(id).length);
    expect(readRuns).toBe(storedRuns);
    expect(sha(file)).toBe(before);
  });
});

describe("run repository · compare-and-set, field ownership, append-only", () => {
  const baseRun = (businessId: string): Omit<RunRecord, "id" | "version" | "updated_at"> => ({
    business_id: businessId, workflow_id: "w", workflow_version: 1, approval_fingerprint: "f", mode: "test_run", scenario: "standard", status: "running",
    trigger: { source: "demo_order", requested_by: "owner" }, idempotency_key: "k1", demo_snapshot: {}, records: {}, cursor: "trigger", steps_done: 0, exec_ms: 0,
    lease_expires_at: null, control: null, control_at: null, pause_reason: null, started_at: new Date().toISOString(), ended_at: null, elapsed_ms: null,
    summary: null, expected: { decision: null, end: "completed" }, end_reason: null, error: null,
  });
  test("status changes apply only if the stored state matches; control and kill switch are checked on the latest state", async () => {
    const { store } = tempStore();
    const { businessId } = await readyRestaurant(store);
    const run = await runTransact(businessId, tx => tx.insertRun(baseRun(businessId)));
    expect(await runTransact(businessId, tx => tx.patchRun(businessId, run.id, { status: "paused" }, { status: ["waiting_approval"] }))).toBe(false);
    // A pause request written by its endpoint makes the runner's expectation (control: null) fail.
    await runTransact(businessId, tx => tx.setRunControl(businessId, run.id, "pause"));
    expect(await runTransact(businessId, tx => tx.patchRun(businessId, run.id, { cursor: "next" }, { status: ["running"], control: null }))).toBe(false);
    // The kill switch, written by its owner method, makes a kill-switch-guarded write fail.
    await runTransact(businessId, tx => tx.clearRunControl(businessId, run.id, "pause"));
    await runTransact(businessId, tx => tx.setKillSwitch(businessId, true));
    expect(await runTransact(businessId, tx => tx.patchRun(businessId, run.id, { cursor: "next" }, { status: ["running"], control: null, killSwitchOff: true }))).toBe(false);
    expect(await runRead(businessId, tx => tx.run(businessId, run.id)!.cursor)).toBe("trigger");
  });
  test("interleaved writes never overwrite each other (every write patches the latest stored record)", async () => {
    const { store } = tempStore();
    const { businessId } = await readyRestaurant(store);
    const run = await runTransact(businessId, tx => tx.insertRun(baseRun(businessId)));
    await Promise.all([
      runTransact(businessId, tx => tx.patchRun(businessId, run.id, { cursor: "a" })),
      runTransact(businessId, tx => tx.setRunControl(businessId, run.id, "stop")),
      runTransact(businessId, tx => tx.setKillSwitch(businessId, true)),
      runTransact(businessId, tx => tx.patchRun(businessId, run.id, { steps_done: 3 })),
    ]);
    const after = await runRead(businessId, tx => ({ run: tx.run(businessId, run.id)!, kill: tx.business(businessId)!.kill_switch }));
    expect([after.run.cursor, after.run.control, after.run.steps_done, after.kill]).toEqual(["a", "stop", 3, true]);
  });
  test("decisions, ledger and activity events are append-only: no method updates or deletes them", () => {
    const methods = Object.getOwnPropertyNames(RunTx.prototype);
    expect(methods.filter(m => /^(patch|update|delete|remove|set|clear)/.test(m) && /(Decision|Ledger|Event)/.test(m))).toEqual([]);
    expect(methods).toEqual(expect.arrayContaining(["appendDecision", "appendLedger", "appendEvent"]));
  });
  test("reads are copies: changing what a read returns changes nothing stored", async () => {
    const { store } = tempStore();
    const { businessId } = await readyRestaurant(store);
    await runTransact(businessId, tx => { const b = tx.business(businessId)!; b.kill_switch = true; });
    expect(await runRead(businessId, tx => tx.business(businessId)!.kill_switch)).toBeUndefined();
  });
});

describe("D18 · approval fingerprints", () => {
  test("canonical JSON is key-order independent; any change to the document changes the fingerprint", async () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe(canonicalJson({ a: [{ c: 3, d: 2 }], b: 1 }));
    const { store } = tempStore();
    const { workflow } = await readyRestaurant(store);
    const fp = workflowFingerprint(workflow);
    const changed = (mut: (d: typeof workflow.steps) => void) => { const d = structuredClone(workflow.steps); mut(d); return workflowFingerprint({ ...workflow, steps: d }); };
    expect(changed(d => { d.params.max_payment_ngn += 1; })).not.toBe(fp);
    expect(changed(d => { d.steps[1].title += "!"; })).not.toBe(fp);
    expect(changed(d => { d.steps[0].next.next = "end"; })).not.toBe(fp);
    expect(changed(d => { d.notes.push("x"); })).not.toBe(fp);
    expect(workflowFingerprint({ ...workflow, version: workflow.version + 1 })).not.toBe(fp);
    expect(workflowFingerprint(structuredClone(workflow))).toBe(fp);
  });
  test("approving a draft records the fingerprint of exactly that version; legacy approvals are left untouched", async () => {
    const { store } = tempStore();
    const legacy = await readyRestaurant(store, { legacy: true });
    const before = (await store.listWorkflows(legacy.businessId))[0];
    expect(before.approval_fingerprint).toBeUndefined();
    // Re-approval process: rebuild as a new draft (M3 action), then approve.
    const draft = await store.createWorkflow({ business_id: legacy.businessId, name: before.name, version: 2, steps: before.steps, validation: before.validation, status: "draft", approved_at: null });
    await approveWorkflow((await store.getBusiness(legacy.businessId))!, draft.id);
    const list = await store.listWorkflows(legacy.businessId);
    const v1 = list.find(w => w.version === 1)!, v2 = list.find(w => w.version === 2)!;
    expect(v1).toMatchObject({ status: "superseded", approved_at: before.approved_at });
    expect(v1.approval_fingerprint).toBeUndefined();                 // never back-filled
    expect(v1.steps).toEqual(before.steps);                         // preserved, not deleted
    expect(v2).toMatchObject({ status: "approved", fingerprint_alg: FINGERPRINT_ALG, approval_fingerprint: workflowFingerprint(v2) });
  });
  test("approving another version while a run is active is refused", async () => {
    const { store } = tempStore();
    const { businessId, workflow } = await readyRestaurant(store);
    await runTransact(businessId, tx => tx.insertRun({ business_id: businessId, workflow_id: workflow.id, workflow_version: 1, approval_fingerprint: workflow.approval_fingerprint!, mode: "test_run", scenario: "standard", status: "waiting_approval",
      trigger: { source: "demo_order", requested_by: "owner" }, idempotency_key: "k", demo_snapshot: {}, records: {}, cursor: "owner_approval", steps_done: 0, exec_ms: 0, lease_expires_at: null,
      control: null, control_at: null, pause_reason: null, started_at: new Date().toISOString(), ended_at: null, elapsed_ms: null, summary: null, expected: { decision: null, end: "completed" }, end_reason: null, error: null }));
    const draft = await store.createWorkflow({ business_id: businessId, name: workflow.name, version: 2, steps: workflow.steps, validation: workflow.validation, status: "draft", approved_at: null });
    await expect(approveWorkflow((await store.getBusiness(businessId))!, draft.id)).rejects.toMatchObject({ code: "RUN_IN_PROGRESS" });
  });
});

describe("§4 · who can run (server-side start checks)", () => {
  const check = async (store: DiscoveryRepository, businessId: string, workflowId: string) => runRead(businessId, tx => checkRunEligibility({
    business: tx.business(businessId)!, agents: tx.agents(businessId), workflows: tx.workflows(businessId), runs: tx.runs(businessId), workflowId,
  }));
  test("a ready restaurant with a fingerprinted approved workflow is eligible", async () => {
    const { store } = tempStore();
    const { businessId, workflow } = await readyRestaurant(store);
    expect(await check(store, businessId, workflow.id)).toMatchObject({ ok: true, fingerprint: workflow.approval_fingerprint });
  });
  test.each([
    ["PREVIEW_ONLY", { industry: "Salon / beauty services" }],
    ["DISCOVERY_INCOMPLETE", { preM35: true }],
    ["REAPPROVAL_REQUIRED", { legacy: true }],
  ])("%s", async (code, opts) => {
    const { store } = tempStore();
    const { businessId, workflow } = await readyRestaurant(store, opts);
    expect(await check(store, businessId, workflow.id)).toMatchObject({ code, status: 409 });
  });
  test("KILL_SWITCH_ACTIVE, WORKFLOW_NOT_APPROVED, APPROVAL_FINGERPRINT_MISMATCH, WORKFLOW_INVALID, RUN_IN_PROGRESS, TEAM_NOT_APPROVED", async () => {
    const { store } = tempStore();
    const { businessId, workflow } = await readyRestaurant(store);
    await runTransact(businessId, tx => tx.setKillSwitch(businessId, true));
    expect(await check(store, businessId, workflow.id)).toMatchObject({ code: "KILL_SWITCH_ACTIVE" });
    await runTransact(businessId, tx => tx.setKillSwitch(businessId, false));
    expect(await check(store, businessId, "not-a-workflow")).toMatchObject({ code: "WORKFLOW_NOT_APPROVED" });
    // Tampering with the stored approved document breaks the fingerprint.
    await store.updateWorkflow(businessId, workflow.id, { steps: { ...workflow.steps, params: { ...workflow.steps.params, max_payment_ngn: 9_999_999 } } });
    expect(await check(store, businessId, workflow.id)).toMatchObject({ code: "APPROVAL_FINGERPRINT_MISMATCH" });
    await store.updateWorkflow(businessId, workflow.id, { steps: workflow.steps });
    // Removing an agent the workflow depends on makes it invalid against the current team.
    await store.updateAgent(businessId, "finance", { status: "removed" });
    expect(await check(store, businessId, workflow.id)).toMatchObject({ code: "WORKFLOW_INVALID" });
    await store.updateAgent(businessId, "finance", { status: "approved" });
    // A paused agent stays a member of the team: the workflow is still eligible.
    await store.updateAgent(businessId, "finance", { status: "paused" });
    expect(await check(store, businessId, workflow.id)).toMatchObject({ ok: true });
    await store.updateAgent(businessId, "finance", { status: "approved" });
    await runTransact(businessId, tx => tx.insertRun({ business_id: businessId, workflow_id: workflow.id, workflow_version: 1, approval_fingerprint: workflow.approval_fingerprint!, mode: "test_run", scenario: "standard", status: "interrupted",
      trigger: { source: "demo_order", requested_by: "owner" }, idempotency_key: "k", demo_snapshot: {}, records: {}, cursor: "x", steps_done: 0, exec_ms: 0, lease_expires_at: null,
      control: null, control_at: null, pause_reason: null, started_at: new Date().toISOString(), ended_at: null, elapsed_ms: null, summary: null, expected: { decision: null, end: "completed" }, end_reason: null, error: null }));
    expect(await check(store, businessId, workflow.id)).toMatchObject({ code: "RUN_IN_PROGRESS" });
    for (const a of await store.listAgents(businessId)) await store.updateAgent(businessId, a.key, { status: "proposed" });
    expect(await check(store, businessId, workflow.id)).toMatchObject({ code: "TEAM_NOT_APPROVED" });
  });
});
