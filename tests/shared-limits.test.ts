// Shared AI spending limits and rate limits (hosted demo). "Instances" = separate guards/limiters on ONE
// shared store whose operations interleave at random. Proves: the daily AI cap and the call ceiling can't
// be passed by concurrent calls on separate instances, they survive a restart, an unreachable store or an
// operator pause refuses the call BEFORE anything is spent, and rate limits hold across instances and on
// the real routes (429 with Retry-After; 503 when the store is down).
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({ jar: new Map<string, string>(), headers: new Map<string, string>([["host", "localhost:3101"], ["x-real-ip", "203.0.113.7"]]) }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (n: string) => (h.jar.has(n) ? { name: n, value: h.jar.get(n)! } : undefined),
    set: (n: string, v: string) => { h.jar.set(n, v); },
  }),
  headers: async () => ({ get: (n: string) => h.headers.get(n.toLowerCase()) ?? null }),
}));

import { POST as start } from "@/app/api/start/route";
import { POST as startRunRoute } from "@/app/api/w/[id]/runs/route";
import { KvSpendStore } from "@/lib/ai/kv-spend-store";
import { SpendingGuard } from "@/lib/ai/spending";
import { hashOwnerToken, setDiscoveryRepository } from "@/lib/discovery/store";
import { checkLimits, limits } from "@/lib/hosted/rate-limit";
import { MemoryKv, setKvForTests } from "@/lib/kv";
import { KvUnavailableError } from "@/lib/kv/types";
import { setPaymentChainForTests, type PaymentChain } from "@/lib/runs/payment-port";
import { armTestnetBatch } from "@/lib/runs/runner";
import { RedisStore } from "@/lib/store/redis-store";
import { readyRestaurant } from "./helpers/run-fixture";

const jitter = () => new Promise<void>(r => (Math.random() < 0.6 ? setImmediate(r) : setTimeout(r, Math.random() * 3)));
let kv: MemoryKv;
beforeEach(() => {
  kv = new MemoryKv({ latency: jitter });
  setKvForTests(kv);
  setDiscoveryRepository(new RedisStore(kv));
  h.jar.clear();
  for (const m of ["log", "info", "warn", "error"] as const) vi.spyOn(console, m).mockImplementation(() => {});
});
afterEach(() => { setDiscoveryRepository(null); setKvForTests(null); setPaymentChainForTests(null); vi.unstubAllEnvs(); });

const PRICES = { m: { prompt: 0.000001, completion: 0.000002 } };   // worst case of reserve("m", 1000, 1000) = $0.003
const guard = (o: { cap?: number; maxCalls?: number; preflight?: () => Promise<void> } = {}) =>
  new SpendingGuard({ provider: "nearai", capUsdPerDay: o.cap ?? 0.03, maxCalls: o.maxCalls ?? 10_000, prices: PRICES, store: new KvSpendStore(kv, "nearai"), today: () => "2026-11-12", preflight: o.preflight });

describe("AI spending across instances", () => {
  test("60 concurrent calls on 4 instances against a $0.03 cap: at most 10 run, and the cap is never passed", async () => {
    const instances = Array.from({ length: 4 }, () => guard());
    let ran = 0, refused = 0;
    await Promise.all(Array.from({ length: 60 }, async (_, i) => {
      const g = instances[i % 4];
      try {
        const r = await g.reserve("m", 1000, 1000);
        ran++;
        await jitter();
        await g.settle(r, { prompt_tokens: 1000, completion_tokens: 1000 });   // spends its full worst case
      } catch (e) { expect((e as { code: string }).code).toBe("BUDGET_CAP"); refused++; }
    }));
    expect(ran).toBeLessThanOrEqual(10);
    expect(ran + refused).toBe(60);
    const spent = await guard().spentToday();
    expect(spent).toBeLessThanOrEqual(0.03 + 1e-9);
    expect(spent).toBeCloseTo(ran * 0.003, 9);
  });

  test("the call ceiling holds across instances under concurrency", async () => {
    const instances = Array.from({ length: 3 }, () => guard({ cap: 100, maxCalls: 7 }));
    const results = await Promise.allSettled(Array.from({ length: 25 }, (_, i) => instances[i % 3].reserve("m", 1, 1)));
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(7);
    expect(results.filter(r => r.status === "rejected").every(r => (r as PromiseRejectedResult).reason.code === "CALL_LIMIT")).toBe(true);
  });

  test("the totals survive a restart (a new instance on the same store sees them)", async () => {
    const a = guard();
    await a.settle(await a.reserve("m", 1000, 1000), { prompt_tokens: 500, completion_tokens: 500 });
    const restarted = guard();
    expect(await restarted.spentToday()).toBeCloseTo(0.0015, 9);
    expect(await restarted.callsMade()).toBe(1);
  });

  test("an unreachable ledger or an operator pause refuses the call before anything is reserved", async () => {
    kv.failWith = new KvUnavailableError("down");
    await expect(guard().reserve("m", 1, 1)).rejects.toMatchObject({ code: "CONFIG" });
    kv.failWith = null;
    const paused = guard({ preflight: async () => { throw Object.assign(new Error("Live AI is paused on this demo right now"), { code: "CONFIG" }); } });
    await expect(paused.reserve("m", 1, 1)).rejects.toMatchObject({ code: "CONFIG" });
    expect(await guard().callsMade()).toBe(0);
  });

  test("a call that fails without usage is charged at worst case (never under-counted)", async () => {
    const g = guard();
    await g.fail(await g.reserve("m", 1000, 1000));
    expect(await g.spentToday()).toBeCloseTo(0.003, 9);
  });
});

describe("rate limits across instances", () => {
  test("a limit of 20 holds exactly under 30 concurrent hits from separate instances", async () => {
    const lim = { name: "t", max: 20, windowMs: 60_000, message: "slow down" };
    const results = await Promise.all(Array.from({ length: 30 }, () => checkLimits([{ limit: lim, subject: "s" }])));
    expect(results.filter(r => r.ok)).toHaveLength(20);
    const refused = results.find(r => !r.ok) as { ok: false; retryAfterS: number };
    expect(refused.retryAfterS).toBeGreaterThan(0);
  });

  test("POST /api/start: refused with 429 + Retry-After past the shared limit; 503 if the store is down", async () => {
    vi.stubEnv("EMPLOYAI_LIMIT_START_PER_IP_10MIN", "2");
    const mk = () => start(new Request("http://localhost:3101/api/start", { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:3101" }, body: JSON.stringify({ message: "I run a small bakery and I want help with orders." }) }));
    expect((await mk()).status).toBe(201);
    expect((await mk()).status).toBe(201);
    const third = await mk();
    expect(third.status).toBe(429);
    expect(Number(third.headers.get("retry-after"))).toBeGreaterThan(0);
    // The hashed IP, never the address itself, is what the store holds.
    expect(kv.keys().some(k => k.includes("203.0.113.7"))).toBe(false);
    kv.failWith = new KvUnavailableError("down");
    expect((await mk()).status).toBe(503);
  });

  test("real testnet runs: a workspace's daily allowance is enforced on the route (simulated runs are unaffected)", async () => {
    vi.stubEnv("EMPLOYAI_LIMIT_TESTNET_RUNS_PER_WORKSPACE_DAY", "2");
    const TOKEN = "q".repeat(43);
    h.jar.set("eai_owner", TOKEN);
    const chain: PaymentChain = {
      target: { network: "testnet", contractId: "treasury.employai-demo.testnet", expectedCodeHash: "x", agent: "finance-agent.employai-demo.testnet" },
      precheck: async () => ({ failures: [], onchainSpentTodayYocto: "0", nearPolicyVersion: "npv", onchainLimits: { maxPerTxYocto: "1", dailyCapYocto: "1" }, checkedAt: new Date().toISOString() }),
      nearPolicyVersion: async () => "npv", sign: async () => ({ ok: false, code: "X", detail: "x", transient: false }), broadcast: async () => ({ outcome: "unknown", reason: "x" }), reconcile: async () => ({ action: "wait", reason: "x" }),
    };
    setPaymentChainForTests(chain);
    const store = new RedisStore(kv);
    const { businessId, workflow } = await readyRestaurant(store, { ownerHash: hashOwnerToken(TOKEN) });
    await armTestnetBatch(businessId, { batchRef: "B3", maxPayments: 2, maxTotalNear: "0.25", expiresInMinutes: 60 });
    const post = (mode: string | undefined, key: string) => startRunRoute(new Request("http://localhost:3101/x", {
      method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:3101", "idempotency-key": key },
      body: JSON.stringify(mode ? { workflow_id: workflow.id, scenario: "standard", mode, confirm_real_transactions: true } : { workflow_id: workflow.id, scenario: "standard" }),
    }), { params: Promise.resolve({ id: businessId }) } as never);
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await post("testnet", `tn-limit-${i}`)).status);
    expect(statuses[2]).toBe(429);
    expect(statuses.slice(0, 2)).not.toContain(429);
    const simulated = await post(undefined, "sim-after-limit");
    expect(simulated.status).not.toBe(429);
    expect(limits().testnetPerWorkspace.max).toBe(2);
  });
});
