// Business locks across server instances: shared leases with unique tokens, renewal, and fencing.
// "Another instance" = a second lease holder on the same shared Kv (its own token), which is exactly
// what a separate Vercel instance is to Redis.
import { afterEach, describe, expect, test } from "vitest";
import { setDiscoveryRepository } from "@/lib/discovery/store";
import { MemoryKv, setKvForTests } from "@/lib/kv";
import { KvUnavailableError } from "@/lib/kv/types";
import { businessLockKey, isBusinessLockHeld, LockBusyError, withBusinessLock } from "@/lib/locks";
import { FenceLostError, withFence } from "@/lib/store/fence-context";
import { acquireLease } from "@/lib/store/lease";
import { RedisStore } from "@/lib/store/redis-store";

afterEach(() => { setDiscoveryRepository(null); setKvForTests(null); });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function shared(clock?: { t: number }) {
  const kv = new MemoryKv(clock ? { now: () => clock.t } : {});
  setKvForTests(kv);
  const store = new RedisStore(kv);
  setDiscoveryRepository(store);
  return { kv, store };
}

describe("leases", () => {
  test("exclusive: a second instance can't take a held lease, and gets it after release", async () => {
    const { kv } = shared();
    const a = await acquireLease(kv, "lock:x", { ttlMs: 5_000, waitMs: 0, fenceMinTtlMs: 0 });
    expect(a).not.toBeNull();
    expect(await acquireLease(kv, "lock:x", { ttlMs: 5_000, waitMs: 50, fenceMinTtlMs: 0 })).toBeNull();
    await a!.release();
    const b = await acquireLease(kv, "lock:x", { ttlMs: 5_000, waitMs: 0, fenceMinTtlMs: 0 });
    expect(b).not.toBeNull();
    expect(b!.token).not.toBe(a!.token);
    await b!.release();
  });

  test("renewal keeps a working holder's lease alive well past its TTL", async () => {
    const { kv } = shared();
    const a = (await acquireLease(kv, "lock:r", { ttlMs: 150, waitMs: 0, fenceMinTtlMs: 0, renewEveryMs: 40 }))!;
    await sleep(450);
    expect(a.lost()).toBe(false);
    expect(await acquireLease(kv, "lock:r", { ttlMs: 150, waitMs: 0, fenceMinTtlMs: 0 })).toBeNull();
    await a.release();
  });

  test("a stalled holder whose lease expired and was taken over can't write; the new holder's work stands", async () => {
    const clock = { t: Date.parse("2026-11-10T12:00:00Z") };
    const { kv, store } = shared(clock);
    const biz = await store.createBusiness({ ownerHash: "o", initialMessage: "x" });
    const a = (await acquireLease(kv, businessLockKey(biz.id), { ttlMs: 30_000, waitMs: 0, fenceMinTtlMs: 2_000, renewEveryMs: 1e9 }))!;   // A will stall: no renewal
    await withFence(a.fence, () => store.updateBusiness(biz.id, { name: "A before stalling" }));
    clock.t += 31_000;                                                    // A stalls past its TTL…
    const b = (await acquireLease(kv, businessLockKey(biz.id), { ttlMs: 30_000, waitMs: 0, fenceMinTtlMs: 2_000, renewEveryMs: 1e9 }))!;   // …and B takes over
    await withFence(b.fence, () => store.updateBusiness(biz.id, { name: "B" }));
    await expect(withFence(a.fence, () => store.updateBusiness(biz.id, { name: "A after waking up" }))).rejects.toBeInstanceOf(FenceLostError);
    await expect(withFence(a.fence, () => store.transact(biz.id, s => { s.businesses[biz.id].summary = "late"; }))).rejects.toBeInstanceOf(FenceLostError);
    expect(await store.getBusiness(biz.id)).toMatchObject({ name: "B", summary: null });
    await a.release();                                                    // A's release can't free B's lock
    expect(await acquireLease(kv, businessLockKey(biz.id), { ttlMs: 30_000, waitMs: 0, fenceMinTtlMs: 0 })).toBeNull();
    await b.release();
  });

  test("a holder near the end of its lease can't start a write (minimum time left)", async () => {
    const clock = { t: 1_000_000 };
    const { kv, store } = shared(clock);
    const biz = await store.createBusiness({ ownerHash: "o", initialMessage: "x" });
    const a = (await acquireLease(kv, businessLockKey(biz.id), { ttlMs: 30_000, waitMs: 0, fenceMinTtlMs: 2_000, renewEveryMs: 1e9 }))!;
    clock.t += 28_500;   // 1.5 s left < 2 s minimum
    await expect(withFence(a.fence, () => store.updateBusiness(biz.id, { name: "too late" }))).rejects.toBeInstanceOf(FenceLostError);
    await a.release();
  });
});

describe("withBusinessLock across instances", () => {
  test("try: busy while another instance holds the business; wait: proceeds once it releases", async () => {
    const { kv, store } = shared();
    const biz = await store.createBusiness({ ownerHash: "o", initialMessage: "x" });
    const other = (await acquireLease(kv, businessLockKey(biz.id), { ttlMs: 30_000, waitMs: 0, fenceMinTtlMs: 0 }))!;
    await expect(withBusinessLock(biz.id, async () => "ran", { mode: "try" })).rejects.toBeInstanceOf(LockBusyError);
    expect(isBusinessLockHeld(biz.id)).toBe(false);                     // the local lock was handed back
    setTimeout(() => { void other.release(); }, 120);
    expect(await withBusinessLock(biz.id, async () => "ran", { mode: "wait", timeoutMs: 3_000 })).toBe("ran");
    await expect(withBusinessLock(biz.id, async () => {
      await kv.del(businessLockKey(biz.id));                           // the lease is lost mid-work…
      await kv.lockAcquire(businessLockKey(biz.id), "intruder", 30_000); // …and someone else holds it now
      await store.updateBusiness(biz.id, { name: "must not land" });
    }, { mode: "wait" })).rejects.toBeInstanceOf(FenceLostError);
    expect((await store.getBusiness(biz.id))!.name).toBeNull();
  });

  test("the shared store is down: the lock can't be taken (fail closed) and the local lock isn't left held", async () => {
    const { kv } = shared();
    kv.failWith = new KvUnavailableError("down");
    await expect(withBusinessLock("b-down", async () => "ran", { mode: "wait" })).rejects.toBeInstanceOf(KvUnavailableError);
    expect(isBusinessLockHeld("b-down")).toBe(false);
  });
});
