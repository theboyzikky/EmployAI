// P0 acceptance · "the owner closes the app": runs started and approved through the real routes are
// driven to the end by the background worker ONLY — the browser's advance route is never called. Every
// existing safeguard stays in the path: the gate, owner approval bound to the exact payment, the kill
// switch, the fenced NEAR signer and the unchanged 0.031 NEAR demo payment. Runs on both stores.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({ jar: new Map<string, string>(), headers: new Map<string, string>([["host", "localhost:3101"]]) }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (n: string) => (h.jar.has(n) ? { name: n, value: h.jar.get(n)! } : undefined), set: (n: string, v: string) => { h.jar.set(n, v); } }),
  headers: async () => ({ get: (n: string) => h.headers.get(n.toLowerCase()) ?? null }),
}));

import { POST as startRunRoute } from "@/app/api/w/[id]/runs/route";
import { POST as decide } from "@/app/api/w/[id]/approvals/[approvalId]/route";
import { sweep } from "@/lib/automation/dispatch";
import "@/lib/automation/handlers";
import "@/lib/automation/run-handlers";
import { runDueTasks } from "@/lib/automation/worker";
import { discoveryRepository, hashOwnerToken, setDiscoveryRepository } from "@/lib/discovery/store";
import { MemoryKv, setKvForTests } from "@/lib/kv";
import { setPaymentChainForTests, type PaymentChain } from "@/lib/runs/payment-port";
import { runRead } from "@/lib/runs/repo";
import { advanceRun, armTestnetBatch, setKillSwitch } from "@/lib/runs/runner";
import { readyRestaurant, tempStore } from "./helpers/run-fixture";
import { sharedMode } from "./helpers/store";

vi.setConfig({ testTimeout: 60_000 });
const TOKEN = "z".repeat(43);
const NEAR_0_031 = "31000000000000000000000";

let signs = 0, broadcasts = 0;
const fakeNear = (): PaymentChain => ({
  target: { network: "testnet", contractId: "treasury.employai-demo.testnet", expectedCodeHash: "HvewFdJa6y2jaJxWn5oU4VckoUDhXo61fKyvd9VFBDJt", agent: "finance-agent.employai-demo.testnet" },
  precheck: async () => ({ failures: [], onchainSpentTodayYocto: "0", nearPolicyVersion: "npv-1", onchainLimits: { maxPerTxYocto: "100000000000000000000000", dailyCapYocto: "250000000000000000000000" }, checkedAt: new Date().toISOString() }),
  nearPolicyVersion: async () => "npv-1",
  sign: async () => { signs++; return { ok: true, signed: { txHash: `tx-${signs}`, signedTxBase64: `bytes-${signs}`, nonce: `${277000000000000 + signs}`, publicKey: "ed25519:fake", blockHash: "bh", signedBlockHeight: 1_000, validityPeriodBlocks: 86_400, expiresAfterHeight: 87_400 } }; },
  broadcast: async () => { broadcasts++; return { outcome: "confirmed", txHash: `tx-${signs}`, gasBurnt: 1, evidence: {} }; },
  reconcile: async () => ({ action: "wait", reason: "pending" }),
});

beforeEach(() => { signs = 0; broadcasts = 0; h.jar.clear(); h.jar.set("eai_owner", TOKEN); if (!sharedMode) setKvForTests(new MemoryKv()); for (const m of ["log", "info", "warn", "error"] as const) vi.spyOn(console, m).mockImplementation(() => {}); });
afterEach(() => { setDiscoveryRepository(null); setKvForTests(null); setPaymentChainForTests(null); vi.unstubAllEnvs(); });

const req = (body: unknown, extra: Record<string, string> = {}) => new Request("http://localhost:3101/x", { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:3101", ...extra }, body: JSON.stringify(body) });
let key = 0;
async function env() {
  const t = tempStore();
  return readyRestaurant(t.store, { ownerHash: hashOwnerToken(TOKEN) });
}
async function start(b: string, workflowId: string, scenario: string, mode?: "testnet") {
  const res = await startRunRoute(req(mode ? { workflow_id: workflowId, scenario, mode, confirm_real_transactions: true } : { workflow_id: workflowId, scenario }, { "idempotency-key": `p0-acc-${++key}` }), { params: Promise.resolve({ id: b }) } as never);
  expect(res.status).toBe(200);
  return ((await res.json()) as { run: { run: { id: string } } }).run.run.id;
}
const run = (b: string, id: string) => runRead(b, tx => ({ run: tx.run(b, id)!, approvals: tx.approvals(b).filter(a => a.run_id === id), attempts: tx.attempts(b).filter(a => a.run_id === id), ledger: tx.ledger(b).filter(l => l.run_id === id) }));
/** The background worker only — what happens after the owner closes the page. */
async function worker(b: string, rounds = 12) {
  for (let i = 0; i < rounds; i++) {
    await discoveryRepository().transact(b, s => { for (const t of (s.tasks ?? {})[b] ?? []) if (t.status === "queued") t.next_at = new Date(0).toISOString(); });   // skip waits
    const r = await runDueTasks(b);
    if (r.processed === 0) break;
  }
}

describe("P0 acceptance: runs continue without the browser", () => {
  test("a simulated test run started by the owner completes in the background (no advance calls)", async () => {
    const { businessId, workflow } = await env();
    const id = await start(businessId, workflow.id, "standard");
    expect((await run(businessId, id)).run.status).toBe("running");
    await worker(businessId);
    expect((await run(businessId, id)).run.status).toBe("completed");
  });

  test("approval: the worker stops at the owner's decision; after the owner approves, it finishes in the background", async () => {
    const { businessId, workflow } = await env();
    const id = await start(businessId, workflow.id, "large_catering");
    await worker(businessId);
    const waiting = await run(businessId, id);
    expect(waiting.run.status).toBe("waiting_approval");
    const res = await decide(req({ decision: "approve" }), { params: Promise.resolve({ id: businessId, approvalId: waiting.approvals[0].id }) } as never);
    expect(res.status).toBe(200);
    await worker(businessId);
    expect((await run(businessId, id)).run.status).toBe("completed");
  });

  test("a REAL-mode testnet run (fake chain here): background worker → owner approval → signed once, 0.031 NEAR unchanged, verified ledger row", async () => {
    setPaymentChainForTests(fakeNear());
    const { businessId, workflow } = await env();
    await armTestnetBatch(businessId, { batchRef: "B-P0", maxPayments: 1, maxTotalNear: "0.1", expiresInMinutes: 60 });
    const id = await start(businessId, workflow.id, "standard", "testnet");
    await worker(businessId);
    const waiting = await run(businessId, id);
    expect(waiting.run.status).toBe("waiting_approval");
    expect(signs).toBe(0);                                                 // nothing signed before the owner approves
    expect(waiting.approvals[0]).toMatchObject({ mode: "testnet", amount_yocto: NEAR_0_031 });
    await decide(req({ decision: "approve" }), { params: Promise.resolve({ id: businessId, approvalId: waiting.approvals[0].id }) } as never);
    await worker(businessId);
    const done = await run(businessId, id);
    expect(done.run.status).toBe("completed");
    expect(done.attempts.map(a => [a.status, a.amount_yocto])).toEqual([["confirmed", NEAR_0_031]]);
    expect(done.ledger.filter(l => l.mode === "testnet" && l.tx_status === "confirmed")).toHaveLength(1);
    expect([signs, broadcasts]).toEqual([1, 1]);
  });

  test("the UI and the background worker driving the same approved testnet run at once: still one signature, one payout", async () => {
    setPaymentChainForTests(fakeNear());
    const { businessId, workflow } = await env();
    await armTestnetBatch(businessId, { batchRef: "B-P0c", maxPayments: 1, maxTotalNear: "0.1", expiresInMinutes: 60 });
    const id = await start(businessId, workflow.id, "standard", "testnet");
    await worker(businessId);
    const ap = (await run(businessId, id)).approvals[0];
    await decide(req({ decision: "approve" }), { params: Promise.resolve({ id: businessId, approvalId: ap.id }) } as never);
    await Promise.all([worker(businessId), (async () => { for (let i = 0; i < 8; i++) await advanceRun(businessId, id).catch(() => undefined); })()]);
    await worker(businessId);
    expect((await run(businessId, id)).attempts.map(a => a.status)).toEqual(["confirmed"]);
    expect([signs, broadcasts]).toEqual([1, 1]);
  });

  test("kill switch before the worker runs: the run is cancelled, nothing is signed, the task ends", async () => {
    setPaymentChainForTests(fakeNear());
    const { businessId, workflow } = await env();
    await armTestnetBatch(businessId, { batchRef: "B-P0k", maxPayments: 1, maxTotalNear: "0.1", expiresInMinutes: 60 });
    const id = await start(businessId, workflow.id, "standard", "testnet");
    await setKillSwitch(businessId, true);
    await worker(businessId);
    expect((await run(businessId, id)).run.status).toBe("cancelled");
    expect(signs).toBe(0);
    expect((await discoveryRepository().readState(businessId, s => (s.tasks ?? {})[businessId] ?? [])).every(t => t.status !== "queued" && t.status !== "running")).toBe(true);
  });

  test("with QStash unavailable, the recovery sweep alone finishes the run", async () => {
    vi.stubEnv("QSTASH_TOKEN", "");
    const { businessId, workflow } = await env();
    const id = await start(businessId, workflow.id, "standard");
    for (let i = 0; i < 5; i++) await sweep();
    expect((await run(businessId, id)).run.status).toBe("completed");
  });
});
