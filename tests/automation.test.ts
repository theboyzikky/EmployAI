// M0.5 · Durable tasks, the worker, QStash and recovery. QStash is never a single point of failure:
// tasks live in the shared store; when QStash is unreachable, out of quota or unconfigured, the inline and
// sweep paths still process the work; a dead worker's task is reclaimed when its lease expires; when the
// store is down nothing runs and nothing is lost. No network: QStash calls go to an injected fetch.
import { createHash, createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { POST as workerPost, GET as workerGet } from "@/app/api/worker/route";
import { POST as hook } from "@/app/api/hooks/[connectionId]/route";
import { discoveryRepository, setDiscoveryRepository } from "@/lib/discovery/store";
import { sweep, wake } from "@/lib/automation/dispatch";
import "@/lib/automation/handlers";
import { qstashPublish, qstashVerify } from "@/lib/automation/qstash";
import { claimDueTaskIn, enqueueTaskIn, settleTaskIn } from "@/lib/automation/tasks";
import { runDueTasks } from "@/lib/automation/worker";
import { requestAction } from "@/lib/integrations/actions";
import { createConnection } from "@/lib/integrations/connections";
import "@/lib/integrations/providers";
import { sign } from "@/lib/integrations/providers/webhook";
import { registerConnector, unregisterConnectorForTests } from "@/lib/integrations/registry";
import type { Connector } from "@/lib/integrations/types";
import { getKv, MemoryKv, setKvForTests } from "@/lib/kv";
import { KvUnavailableError } from "@/lib/kv/types";
import { RedisStore } from "@/lib/store/redis-store";
import { readyRestaurant, tempStore } from "./helpers/run-fixture";
import { sharedMode } from "./helpers/store";

let sends = 0;
const ops: Connector = {
  key: "test_ops", name: "Test ops (simulated)", kind: "business_system", reality: "simulated", eventTypes: [],
  actions: { "test_ops.update": { sideEffect: "write", idempotency: "none", parse: x => x as Record<string, unknown>, execute: async () => { sends++; await new Promise(r => setTimeout(r, 5)); return { kind: "done", ref: `r${sends}` }; } } },
  setup: () => ({ config: {}, secrets: {}, revealOnce: {} }),
};

beforeEach(() => { vi.stubEnv("APP_ENCRYPTION_KEY", "w".repeat(40)); sends = 0; registerConnector(ops); if (!sharedMode) setKvForTests(new MemoryKv()); });
afterEach(() => { vi.unstubAllEnvs(); unregisterConnectorForTests("test_ops"); setDiscoveryRepository(null); setKvForTests(null); vi.restoreAllMocks(); });

async function withAction(key = "auto-key-1") {
  const t = tempStore();
  const { businessId } = await readyRestaurant(t.store);
  const { view } = await createConnection(businessId, { connector: "test_ops", label: "x", setup: {}, grants: [{ agent: "inventory", actions: ["test_ops.update"] }] });
  const { attemptId } = await requestAction(businessId, { connectionId: view.id, action: "test_ops.update", agent: "inventory", idempotencyKey: key, input: { sku: "rice" }, correlationId: "c" });
  return { businessId, attemptId };
}
const tasks = (b: string) => discoveryRepository().readState(b, s => (s.tasks ?? {})[b] ?? []);
const action = (b: string, id: string) => discoveryRepository().readState(b, s => (s.action_attempts ?? {})[b]!.find(a => a.id === id)!);

describe("task queue rules", () => {
  test("dedupe while live; claim takes a lease; failures back off; dead after max attempts; waiting isn't failing", () => {
    const s = { version: 2, businesses: {}, messages: {}, agents: {} } as Parameters<typeof enqueueTaskIn>[0];
    const t0 = "2026-11-11T10:00:00.000Z";
    const a = enqueueTaskIn(s, "b", { kind: "drive_action", ref: "x", dedupeKey: "k", maxAttempts: 2 }, t0);
    expect(enqueueTaskIn(s, "b", { kind: "drive_action", ref: "x", dedupeKey: "k" }, t0).id).toBe(a.id);
    const c1 = claimDueTaskIn(s, "b", "w1", t0)!;
    expect(claimDueTaskIn(s, "b", "w2", t0)).toBeNull();                          // leased
    expect(settleTaskIn(s, "b", c1.id, "w2", { kind: "done" }, t0)).toBeNull();  // not the holder
    const later = settleTaskIn(s, "b", c1.id, "w1", { kind: "later", atIso: "2026-11-11T10:05:00.000Z" }, t0)!;
    expect(later).toMatchObject({ status: "queued", attempts: 0 });
    expect(claimDueTaskIn(s, "b", "w1", t0)).toBeNull();                          // not due yet
    const c2 = claimDueTaskIn(s, "b", "w1", "2026-11-11T10:06:00.000Z")!;
    expect(settleTaskIn(s, "b", c2.id, "w1", { kind: "failed", error: "boom" }, "2026-11-11T10:06:00.000Z")).toMatchObject({ status: "queued", attempts: 1 });
    const c3 = claimDueTaskIn(s, "b", "w1", "2026-11-11T11:00:00.000Z")!;
    expect(settleTaskIn(s, "b", c3.id, "w1", { kind: "failed", error: "boom" }, "2026-11-11T11:00:00.000Z")).toMatchObject({ status: "dead", attempts: 2 });
    // A dead worker's lease expires: the task is reclaimable.
    const b2 = enqueueTaskIn(s, "b", { kind: "drive_action", ref: "y", dedupeKey: "k2" }, t0);
    claimDueTaskIn(s, "b", "dead-worker", t0);
    expect(claimDueTaskIn(s, "b", "w9", "2026-11-11T10:01:00.000Z")).toBeNull();
    expect(claimDueTaskIn(s, "b", "w9", "2026-11-11T10:02:00.000Z")?.id).toBe(b2.id);
  });
});

describe("worker and recovery", () => {
  test("recording an action enqueues its task in the same commit; the worker delivers it; the due index empties", async () => {
    const { businessId, attemptId } = await withAction();
    expect((await tasks(businessId)).map(t => [t.kind, t.status])).toEqual([["drive_action", "queued"]]);
    expect(await discoveryRepository().businessesWithDueWork()).toContain(businessId);
    await runDueTasks(businessId);
    expect((await action(businessId, attemptId)).status).toBe("done");
    expect((await tasks(businessId))[0].status).toBe("done");
    expect(await discoveryRepository().businessesWithDueWork()).not.toContain(businessId);
  });

  test("QStash unreachable / out of quota / not configured: wake reports it, the work is still done by the sweep", async () => {
    const { businessId, attemptId } = await withAction("auto-key-qs");
    vi.stubEnv("QSTASH_TOKEN", "tok"); vi.stubEnv("EMPLOYAI_PUBLIC_URL", "https://demo.example");
    const down = vi.fn(async () => { throw new Error("ECONNREFUSED"); });
    expect(await qstashPublish("https://demo.example/api/worker", {}, {}, process.env, down as never)).toEqual({ ok: false, reason: "QSTASH_UNREACHABLE" });
    const quota = vi.fn(async () => new Response("quota", { status: 429 }));
    expect(await qstashPublish("https://demo.example/api/worker", {}, {}, process.env, quota as never)).toEqual({ ok: false, reason: "QSTASH_RATE_OR_QUOTA_LIMIT" });
    vi.stubEnv("QSTASH_TOKEN", "");
    const w = await wake(businessId);                     // outside a request: no after(); QStash not configured
    expect(w).toEqual({ inline: false, qstash: { ok: false, reason: "QSTASH_NOT_CONFIGURED" } });
    expect((await action(businessId, attemptId)).status).toBe("prepared");   // still waiting, safely
    expect(await sweep()).toMatchObject({ businesses: 1 });
    expect((await action(businessId, attemptId)).status).toBe("done");
    expect(sends).toBe(1);
  });

  test("a worker that dies mid-task: its lease expires, another worker finishes it, the action isn't duplicated", async () => {
    const { businessId, attemptId } = await withAction("auto-key-crash");
    await discoveryRepository().transact(businessId, s => { claimDueTaskIn(s, businessId, "dead-worker", new Date(Date.now() - 120_000).toISOString()); });
    expect((await runDueTasks(businessId)).processed).toBe(1);          // reclaimed (lease expired)
    expect((await action(businessId, attemptId)).status).toBe("done");
    expect(sends).toBe(1);
  });

  test("3 workers on separate instances run the same business's queue at once: each action delivered once", async () => {
    const kv = new MemoryKv({ latency: () => new Promise<void>(r => (Math.random() < 0.5 ? setImmediate(r) : setTimeout(r, Math.random() * 3))) });
    setKvForTests(kv);
    const store = new RedisStore(kv);
    setDiscoveryRepository(store);
    const { businessId } = await readyRestaurant(store);
    const { view } = await createConnection(businessId, { connector: "test_ops", label: "x", setup: {}, grants: [{ agent: "inventory", actions: ["test_ops.update"] }] });
    for (let i = 0; i < 5; i++) await requestAction(businessId, { connectionId: view.id, action: "test_ops.update", agent: "inventory", idempotencyKey: `auto-conc-${i}`, input: { sku: `s${i}` }, correlationId: "c" });
    await Promise.all([runDueTasks(businessId), runDueTasks(businessId), runDueTasks(businessId)]);
    await runDueTasks(businessId);
    expect(sends).toBe(5);
    expect((await tasks(businessId)).every(t => t.status === "done")).toBe(true);
  });

  test("the shared store down: the worker stops at once, changes nothing; after recovery the work completes", async () => {
    const { businessId, attemptId } = await withAction("auto-key-redis");
    const kv = getKv() as MemoryKv;
    if (sharedMode) {
      kv.failWith = new KvUnavailableError("down");
      await expect(runDueTasks(businessId)).rejects.toBeInstanceOf(KvUnavailableError);
      kv.failWith = null;
    }
    expect(sends).toBe(0);
    await runDueTasks(businessId);
    expect((await action(businessId, attemptId)).status).toBe("done");
  });
});

describe("worker endpoint and QStash signatures", () => {
  const KEY_CUR = "sig_current_0123456789abcdef", KEY_NEXT = "sig_next_0123456789abcdef";
  const URL_ = "https://demo.example/api/worker";
  const jwt = (key: string, claims: Record<string, unknown>, alg = "HS256") => {
    const h = Buffer.from(JSON.stringify({ alg, typ: "JWT" })).toString("base64url");
    const p = Buffer.from(JSON.stringify(claims)).toString("base64url");
    return `${h}.${p}.${createHmac("sha256", key).update(`${h}.${p}`).digest("base64url")}`;
  };
  const claims = (body: string, o: Record<string, unknown> = {}) => ({ iss: "Upstash", sub: URL_, exp: Math.floor(Date.now() / 1000) + 300, nbf: Math.floor(Date.now() / 1000) - 5, body: createHash("sha256").update(body).digest("base64url"), ...o });
  beforeEach(() => { vi.stubEnv("QSTASH_CURRENT_SIGNING_KEY", KEY_CUR); vi.stubEnv("QSTASH_NEXT_SIGNING_KEY", KEY_NEXT); vi.stubEnv("EMPLOYAI_PUBLIC_URL", "https://demo.example"); });

  test("signature checks: current or next key; wrong key, wrong URL, expired, tampered body, alg none — all refused", () => {
    const body = JSON.stringify({ business_id: "x" });
    expect(qstashVerify({ signature: jwt(KEY_CUR, claims(body)), rawBody: body, url: URL_ })).toBe(true);
    expect(qstashVerify({ signature: jwt(KEY_NEXT, claims(body)), rawBody: body, url: URL_ })).toBe(true);
    expect(qstashVerify({ signature: jwt("someone-elses-key-0000000", claims(body)), rawBody: body, url: URL_ })).toBe(false);
    expect(qstashVerify({ signature: jwt(KEY_CUR, claims(body, { sub: "https://evil.example/api/worker" })), rawBody: body, url: URL_ })).toBe(false);
    expect(qstashVerify({ signature: jwt(KEY_CUR, claims(body, { exp: 1 })), rawBody: body, url: URL_ })).toBe(false);
    expect(qstashVerify({ signature: jwt(KEY_CUR, claims(body)), rawBody: body + " ", url: URL_ })).toBe(false);
    expect(qstashVerify({ signature: jwt(KEY_CUR, claims(body), "none"), rawBody: body, url: URL_ })).toBe(false);
    expect(qstashVerify({ signature: null, rawBody: body, url: URL_ })).toBe(false);
  });

  test("POST /api/worker: 401 without a valid signature or secret; runs the business's tasks when signed; 503 when the store is down", async () => {
    const { businessId, attemptId } = await withAction("auto-key-route");
    const body = JSON.stringify({ business_id: businessId });
    const req = (sig?: string, auth?: string) => new Request(URL_, { method: "POST", headers: { "content-type": "application/json", ...(sig ? { "upstash-signature": sig } : {}), ...(auth ? { authorization: auth } : {}) }, body });
    expect((await workerPost(req())).status).toBe(401);
    expect((await workerPost(req(jwt("wrong-key-0000000000000", claims(body))))).status).toBe(401);
    expect((await workerPost(req(undefined, "Bearer short"))).status).toBe(401);
    const ok = await workerPost(req(jwt(KEY_CUR, claims(body))));
    expect(ok.status).toBe(200);
    expect((await action(businessId, attemptId)).status).toBe("done");
    vi.stubEnv("EMPLOYAI_WORKER_SECRET", "s".repeat(40));
    expect((await workerPost(req(undefined, `Bearer ${"s".repeat(40)}`))).status).toBe(200);
    if (sharedMode) {
      (getKv() as MemoryKv).failWith = new KvUnavailableError("down");
      expect((await workerPost(req(undefined, `Bearer ${"s".repeat(40)}`))).status).toBe(503);
      (getKv() as MemoryKv).failWith = null;
    }
  });

  test("GET /api/worker (daily cron): only with CRON_SECRET", async () => {
    vi.stubEnv("CRON_SECRET", "c".repeat(32));
    expect((await workerGet(new Request(URL_))).status).toBe(401);
    expect((await workerGet(new Request(URL_, { headers: { authorization: `Bearer ${"c".repeat(32)}` } }))).status).toBe(200);
  });
});

describe("inbound events become durable tasks", () => {
  test("a stored webhook event gets its process_event task in the same commit; processing keeps it for the owner (no P0 automation)", async () => {
    const t = tempStore();
    const { businessId } = await readyRestaurant(t.store);
    const { view, revealOnce } = await createConnection(businessId, { connector: "webhook", label: "POS", setup: {}, routes: [{ event_type: "order.created", agent: "order" }] });
    const raw = JSON.stringify({ id: "evt_t1", type: "order.created", data: { items: [] } });
    const ts = String(Math.floor(Date.now() / 1000));
    const res = await hook(new Request(`https://demo.example/api/hooks/${view.id}`, { method: "POST", headers: { "x-employai-timestamp": ts, "x-employai-signature": sign(revealOnce.inbound_secret, ts, raw) }, body: raw }), { params: Promise.resolve({ connectionId: view.id }) } as never);
    expect(res.status).toBe(200);
    expect((await tasks(businessId)).map(x => [x.kind, x.status])).toEqual([["process_event", "queued"]]);
    await runDueTasks(businessId);
    const ev = await discoveryRepository().readState(businessId, s => (s.inbound_events ?? {})[businessId]![0]);
    expect(ev.note).toMatch(/No automation for "order.created" events is active yet/);
    expect((await tasks(businessId))[0].status).toBe("done");
  });
});
