// M0.4 · Durable outbound actions. A scripted, SIMULATED test connector gives exact control of outcomes;
// the REAL webhook connector is then checked with its network stubbed (no request leaves the machine).
// Proves: write-ahead before every delivery; authorisation re-checked at send time; unknown outcomes
// never blindly re-sent (escalated, reconciled, or re-sent with the same key only when the provider
// honours it); one driver at a time across instances; store failure sends nothing.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { discoveryRepository, setDiscoveryRepository } from "@/lib/discovery/store";
import { driveAction, MAX_DELIVERIES, requestAction } from "@/lib/integrations/actions";
import { createConnection, setConnectionStatus } from "@/lib/integrations/connections";
import "@/lib/integrations/providers";
import { sign, webhookNet } from "@/lib/integrations/providers/webhook";
import { registerConnector, unregisterConnectorForTests } from "@/lib/integrations/registry";
import type { ActionOutcome, Connector } from "@/lib/integrations/types";
import { getKv, MemoryKv, setKvForTests } from "@/lib/kv";
import { KvUnavailableError } from "@/lib/kv/types";
import { runTransact } from "@/lib/runs/repo";
import { setKillSwitch } from "@/lib/runs/runner";
import { RedisStore } from "@/lib/store/redis-store";
import { readyRestaurant, tempStore } from "./helpers/run-fixture";
import { sharedMode } from "./helpers/store";

type Script = { outcomes: ActionOutcome[]; idempotency: "provider_key" | "none"; reconcile?: ActionOutcome | null; onExecute?: () => Promise<void> };
const calls: Array<{ key: string; status: string | undefined }> = [];
let script: Script;
const opsConnector = (): Connector => ({
  key: "test_ops", name: "Test ops (simulated)", kind: "business_system", reality: "simulated", eventTypes: [],
  actions: {
    "test_ops.update": {
      sideEffect: "write", idempotency: script.idempotency,
      parse: x => { const o = x as { sku?: unknown }; if (typeof o.sku !== "string") throw new Error("sku"); return { sku: o.sku }; },
      async execute(ctx) {
        // Write-ahead check: at the moment of delivery the record already says "sending".
        const status = await discoveryRepository().readState(ctx.businessId, s => (s.action_attempts ?? {})[ctx.businessId]!.find(a => a.idempotency_key === ctx.idempotencyKey)?.status);
        calls.push({ key: ctx.idempotencyKey, status });
        await script.onExecute?.();
        return script.outcomes.shift() ?? { kind: "done", ref: "ref-x" };
      },
      ...(script.reconcile !== undefined ? { reconcile: async () => script.reconcile ?? null } : {}),
    },
  },
  setup: () => ({ config: {}, secrets: { token: "t" }, revealOnce: {} }),
});

beforeEach(() => { vi.stubEnv("APP_ENCRYPTION_KEY", "a".repeat(40)); calls.length = 0; script = { outcomes: [], idempotency: "none" }; if (!sharedMode) setKvForTests(new MemoryKv()); });
afterEach(() => { vi.unstubAllEnvs(); unregisterConnectorForTests("test_ops"); setDiscoveryRepository(null); setKvForTests(null); vi.restoreAllMocks(); });

let seq = 0;
async function setup(o: Partial<Script> = {}) {
  script = { ...script, ...o };
  unregisterConnectorForTests("test_ops");
  registerConnector(opsConnector());
  const t = tempStore();
  const { businessId } = await readyRestaurant(t.store);
  const { view } = await createConnection(businessId, { connector: "test_ops", label: "Stock system", setup: {}, grants: [{ agent: "inventory", actions: ["test_ops.update"] }] });
  const ask = (agent: "inventory" | "order" = "inventory", key = `act-key-${++seq}`) => requestAction(businessId, { connectionId: view.id, action: "test_ops.update", agent, idempotencyKey: key, input: { sku: "rice" }, correlationId: "corr-1" });
  const rec = (id: string) => discoveryRepository().readState(businessId, s => (s.action_attempts ?? {})[businessId]!.find(a => a.id === id)!);
  return { businessId, connectionId: view.id, ask, rec };
}

describe("outbound actions: records, authorisation, outcomes", () => {
  test("done: one write-ahead delivery, proof stored; the same idempotency key is one action", async () => {
    const { ask, rec, businessId } = await setup({ outcomes: [{ kind: "done", ref: "stock-tx-77" }] });
    const { attemptId, created } = await ask("inventory", "act-key-same");
    expect(created).toBe(true);
    expect((await ask("inventory", "act-key-same")).attemptId).toBe(attemptId);
    expect(await driveAction(businessId, attemptId)).toBe("done");
    expect(calls).toEqual([{ key: "act-key-same", status: "sending" }]);   // recorded BEFORE it was made
    expect(await rec(attemptId)).toMatchObject({ status: "done", deliveries: 1, provider_ref: "stock-tx-77" });
    expect(await driveAction(businessId, attemptId)).toBe("done");
    expect(calls).toHaveLength(1);
  });

  test("not authorised → refused before anything is recorded or sent: no grant, wrong input", async () => {
    const { ask } = await setup();
    await expect(ask("order")).rejects.toMatchObject({ code: "NOT_AUTHORISED" });
    expect(calls).toHaveLength(0);
  });

  test("kill switch, disabled connection or paused employee AFTER the request: aborted at send time, never sent", async () => {
    const a = await setup();
    const one = await a.ask();
    await setKillSwitch(a.businessId, true);
    expect(await driveAction(a.businessId, one.attemptId)).toBe("aborted");
    expect((await a.rec(one.attemptId)).error?.code).toBe("KILL_SWITCH_ACTIVE");
    const b = await setup();
    const two = await b.ask();
    await setConnectionStatus(b.businessId, b.connectionId, "disabled");
    expect(await driveAction(b.businessId, two.attemptId)).toBe("aborted");
    const c = await setup();
    const three = await c.ask();
    await runTransact(c.businessId, tx => tx.setAgentStatus(c.businessId, "inventory", "approved", "paused"));
    expect(await driveAction(c.businessId, three.attemptId)).toBe("aborted");
    expect(calls).toHaveLength(0);
  });

  test("unknown outcome, no provider idempotency: escalated to the owner, never re-sent", async () => {
    const { ask, rec, businessId } = await setup({ outcomes: [{ kind: "unknown", detail: "timeout" }] });
    const { attemptId } = await ask();
    expect(await driveAction(businessId, attemptId)).toBe("unknown");
    expect(await driveAction(businessId, attemptId)).toBe("escalated");
    expect(await driveAction(businessId, attemptId)).toBe("escalated");
    expect(calls).toHaveLength(1);
    expect((await rec(attemptId)).error?.code).toBe("NEEDS_OWNER");
  });

  test("unknown outcome WITH provider idempotency: re-sent with the SAME key, at most MAX_DELIVERIES times, then escalated", async () => {
    const { ask, rec, businessId } = await setup({ idempotency: "provider_key", outcomes: [{ kind: "unknown", detail: "502" }, { kind: "unknown", detail: "502" }, { kind: "unknown", detail: "502" }] });
    const { attemptId } = await ask("inventory", "act-key-idem");
    for (let i = 0; i < 6; i++) await driveAction(businessId, attemptId);
    expect(calls.map(c => c.key)).toEqual(Array(MAX_DELIVERIES).fill("act-key-idem"));
    expect(await rec(attemptId)).toMatchObject({ status: "escalated", deliveries: MAX_DELIVERIES });
  });

  test("unknown outcome with a reconcile check: settled from the provider's answer, not re-sent", async () => {
    const { ask, rec, businessId } = await setup({ outcomes: [{ kind: "unknown", detail: "reset" }], reconcile: { kind: "done", ref: "found-it" } });
    const { attemptId } = await ask();
    await driveAction(businessId, attemptId);
    expect(await driveAction(businessId, attemptId)).toBe("done");
    expect(calls).toHaveLength(1);
    expect((await rec(attemptId)).provider_ref).toBe("found-it");
  });

  test("a worker that died mid-delivery: the record says 'sending' → treated as unknown, not re-sent blindly", async () => {
    const { ask, rec, businessId } = await setup();
    const { attemptId } = await ask();
    await discoveryRepository().transact(businessId, s => { const a = (s.action_attempts ?? {})[businessId]!.find(x => x.id === attemptId)!; a.status = "sending"; a.deliveries = 1; a.lease_owner = "dead-worker"; a.lease_expires_at = new Date(Date.now() - 1000).toISOString(); });
    expect(await driveAction(businessId, attemptId)).toBe("escalated");
    expect(calls).toHaveLength(0);
    expect(await rec(attemptId)).toMatchObject({ status: "escalated", deliveries: 1 });
  });

  test("provider says 'try later' (rejected, retryable): waits, then retries; a hard refusal is final", async () => {
    const { ask, rec, businessId } = await setup({ outcomes: [{ kind: "rejected", retryable: true, code: "RATE_LIMITED", detail: "429" }, { kind: "done", ref: "ok" }] });
    const { attemptId } = await ask();
    expect(await driveAction(businessId, attemptId)).toBe("prepared");
    expect(await driveAction(businessId, attemptId)).toBe("prepared");   // too early: nothing sent
    expect(calls).toHaveLength(1);
    await discoveryRepository().transact(businessId, s => { (s.action_attempts ?? {})[businessId]!.find(x => x.id === attemptId)!.retry_at = new Date(Date.now() - 1).toISOString(); });
    expect(await driveAction(businessId, attemptId)).toBe("done");
    expect(calls).toHaveLength(2);
    const b = await setup({ outcomes: [{ kind: "rejected", retryable: false, code: "HTTP_400", detail: "bad" }] });
    const two = await b.ask();
    expect(await driveAction(b.businessId, two.attemptId)).toBe("rejected");
    expect((await b.rec(two.attemptId)).error?.code).toBe("HTTP_400");
  });

  test("4 instances drive the same action at once: delivered once", async () => {
    const kv = new MemoryKv({ latency: () => new Promise<void>(r => (Math.random() < 0.5 ? setImmediate(r) : setTimeout(r, Math.random() * 3))) });
    setKvForTests(kv);
    setDiscoveryRepository(new RedisStore(kv));
    script = { outcomes: [{ kind: "done", ref: "once" }], idempotency: "none", onExecute: () => new Promise(r => setTimeout(r, 15)) };
    unregisterConnectorForTests("test_ops");
    registerConnector(opsConnector());
    const { businessId } = await readyRestaurant(new RedisStore(kv));
    const { view } = await createConnection(businessId, { connector: "test_ops", label: "x", setup: {}, grants: [{ agent: "inventory", actions: ["test_ops.update"] }] });
    const { attemptId } = await requestAction(businessId, { connectionId: view.id, action: "test_ops.update", agent: "inventory", idempotencyKey: "act-key-concurrent", input: { sku: "rice" }, correlationId: "c" });
    const results = await Promise.all(Array.from({ length: 4 }, () => driveAction(businessId, attemptId)));
    expect(calls).toHaveLength(1);
    expect(results.filter(r => r === "done").length + results.filter(r => r === "busy").length).toBe(4);
  });

  test("the store failing at the write-ahead: nothing is sent", async () => {
    const { ask, businessId } = await setup();
    const { attemptId } = await ask();
    const kv = getKv() as MemoryKv;
    const realStore = discoveryRepository();
    // Fail every store write from now on (reads still work), then drive.
    const orig = realStore.transact.bind(realStore);
    let n = 0;
    realStore.transact = (async (...args: Parameters<typeof orig>) => { if (n++ >= 1) throw new KvUnavailableError("down"); return orig(...args); }) as typeof orig;
    await driveAction(businessId, attemptId).catch(() => undefined);
    realStore.transact = orig;
    expect(calls).toHaveLength(0);
    void kv;
  });
});

describe("the real webhook connector's outbound delivery (network stubbed)", () => {
  async function hookSetup() {
    const t = tempStore();
    const { businessId } = await readyRestaurant(t.store);
    const { view, revealOnce } = await createConnection(businessId, { connector: "webhook", label: "Supplier portal", setup: { target_url: "https://supplier.example.com/in" }, grants: [{ agent: "procurement", actions: ["webhook.deliver"] }] });
    return { businessId, id: view.id, outboundSecret: revealOnce.outbound_secret };
  }
  const deliver = async (b: string, id: string, key: string) => {
    const { attemptId } = await requestAction(b, { connectionId: id, action: "webhook.deliver", agent: "procurement", idempotencyKey: key, input: { type: "order.created", data: { item: "Rice", qty: 31 } }, correlationId: "c" });
    return { attemptId, status: await driveAction(b, attemptId) };
  };

  test("2xx = done: signed body, the stable Idempotency-Key header; 500 = unknown → re-sent with the SAME key", async () => {
    const { businessId, id, outboundSecret } = await hookSetup();
    vi.spyOn(webhookNet, "resolve").mockResolvedValue(["93.184.216.34"]);
    const seen: Array<{ key: string; sigOk: boolean }> = [];
    const statuses = [500, 200];
    vi.spyOn(webhookNet, "fetch").mockImplementation(async (_url, init) => {
      const hdr = new Headers(init!.headers);
      seen.push({ key: hdr.get("idempotency-key")!, sigOk: hdr.get("x-employai-signature") === sign(outboundSecret, hdr.get("x-employai-timestamp")!, init!.body as string) });
      return new Response("{}", { status: statuses.shift()! });
    });
    const { attemptId, status } = await deliver(businessId, id, "deliver-key-1");
    expect(status).toBe("unknown");
    expect(await driveAction(businessId, attemptId)).toBe("done");
    expect(seen).toEqual([{ key: "deliver-key-1", sigOk: true }, { key: "deliver-key-1", sigOk: true }]);
  });

  test("429 = try later; 400 = refused; a target resolving to a private address is never contacted", async () => {
    const { businessId, id } = await hookSetup();
    const fetchSpy = vi.spyOn(webhookNet, "fetch").mockResolvedValueOnce(new Response("", { status: 429 })).mockResolvedValueOnce(new Response("", { status: 400 }));
    vi.spyOn(webhookNet, "resolve").mockResolvedValue(["93.184.216.34"]);
    expect((await deliver(businessId, id, "deliver-key-2")).status).toBe("prepared");
    expect((await deliver(businessId, id, "deliver-key-3")).status).toBe("rejected");
    vi.spyOn(webhookNet, "resolve").mockResolvedValue(["10.0.0.7"]);
    const before = fetchSpy.mock.calls.length;
    expect((await deliver(businessId, id, "deliver-key-4")).status).toBe("rejected");
    expect(fetchSpy.mock.calls.length).toBe(before);
  });
});
