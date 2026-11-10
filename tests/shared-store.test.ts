// The hosted demo's shared store (RedisStore). Several "server instances" = several RedisStore objects
// on ONE MemoryKv whose every operation yields at random, so their reads and commits interleave the way
// separate Vercel instances sharing one Redis would.
import { afterEach, describe, expect, test } from "vitest";
import type { DevState } from "@/lib/discovery/store";
import { setDiscoveryRepository } from "@/lib/discovery/store";
import { MemoryKv, setKvForTests } from "@/lib/kv";
import { KvUnavailableError } from "@/lib/kv/types";
import { FenceLostError, withFence } from "@/lib/store/fence-context";
import { ScopeViolation } from "@/lib/store/partition";
import { LedgerSlugTakenError, RedisStore, StoreContentionError, storeKeys } from "@/lib/store/redis-store";

afterEach(() => { setDiscoveryRepository(null); setKvForTests(null); });

const jitter = () => new Promise<void>(r => (Math.random() < 0.5 ? setImmediate(r) : setTimeout(r, Math.random() * 3)));
function cluster(n = 3, o: { now?: () => number } = {}) {
  const kv = new MemoryKv({ latency: jitter, now: o.now });
  setKvForTests(kv);
  return { kv, instances: Array.from({ length: n }, () => new RedisStore(kv, { workspaceTtlDays: 60 })) };
}
const bump = (s: DevState, id: string) => { const b = s.businesses[id]; b.summary = String(Number(b.summary ?? "0") + 1); };

describe("shared store: concurrent instances never lose an update", () => {
  test("3 instances × 15 concurrent read-modify-writes on one business: every increment survives", async () => {
    const { instances: [a, b, c] } = cluster();
    const biz = await a.createBusiness({ ownerHash: "o1", initialMessage: "hello" });
    await Promise.all(Array.from({ length: 15 }, () => [a, b, c].map(s => s.transact(biz.id, v => bump(v, biz.id)))).flat());
    expect((await c.getBusiness(biz.id))!.summary).toBe("45");
  });

  test("concurrent message appends from separate instances are all kept, and a retried send is stored once", async () => {
    const { instances: [a, b] } = cluster(2);
    const biz = await a.createBusiness({ ownerHash: "o1", initialMessage: "first" });
    await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).appendMessage({ business_id: biz.id, role: "user", content: `m${i}`, meta: { kind: "answer", client_message_id: `c${i}` } })));
    await Promise.all([a, b].map(s => s.appendMessage({ business_id: biz.id, role: "user", content: "dup", meta: { kind: "answer", client_message_id: "same" } })));
    const msgs = await a.listMessages(biz.id);
    expect(msgs.filter(m => m.content.startsWith("m"))).toHaveLength(20);
    expect(msgs.filter(m => m.content === "dup")).toHaveLength(1);
  });

  test("the shared blocklist: reports filed concurrently from different businesses on different instances are all kept", async () => {
    const { instances: [a, b] } = cluster(2);
    const x = await a.createBusiness({ ownerHash: "o1", initialMessage: "x" });
    const y = await b.createBusiness({ ownerHash: "o2", initialMessage: "y" });
    const report = (id: string, n: number) => (s: DevState) => { (s.blocklist_reports ??= []).push({ id: `r-${id}-${n}`, account_id: `bad-${n}.testnet`, reported_by_business_id: id } as never); };
    await Promise.all(Array.from({ length: 6 }, (_, n) => [a.transact(x.id, report(x.id, n)), b.transact(y.id, report(y.id, n))]).flat());
    const seen = await a.readState(y.id, s => (s.blocklist_reports ?? []).map(r => r.id).sort());
    expect(seen).toHaveLength(12);
  });

  test("bounded retries: a commit that keeps losing the race writes nothing and says STORE_BUSY", async () => {
    const { instances: [a, b] } = cluster(2);
    const biz = await a.createBusiness({ ownerHash: "o1", initialMessage: "x" });
    a.beforeCommit = () => b.transact(biz.id, v => bump(v, biz.id));   // someone else always commits first
    await expect(a.transact(biz.id, v => { v.businesses[biz.id].name = "lost"; })).rejects.toBeInstanceOf(StoreContentionError);
    a.beforeCommit = null;
    const after = (await b.getBusiness(biz.id))!;
    expect(after.name).toBeNull();
    expect(Number(after.summary)).toBe(12);   // b's writes all landed
  });
});

describe("shared store: isolation between workspaces", () => {
  test("a transaction can't touch another business: ScopeViolation, nothing written", async () => {
    const { kv, instances: [a] } = cluster(1);
    const mine = await a.createBusiness({ ownerHash: "me", initialMessage: "mine" });
    const theirs = await a.createBusiness({ ownerHash: "them", initialMessage: "theirs" });
    const before = kv.dump();
    await expect(a.transact(mine.id, s => { s.businesses[theirs.id] = { ...s.businesses[mine.id], id: theirs.id, name: "hijacked" }; })).rejects.toBeInstanceOf(ScopeViolation);
    await expect(a.transact(mine.id, s => { (s.messages[theirs.id] ??= []).push({ id: "x", business_id: theirs.id, role: "user", content: "injected", meta: { kind: "answer" }, created_at: "" }); })).rejects.toBeInstanceOf(ScopeViolation);
    await expect(a.transact(mine.id, s => { (s.run_steps ??= {})["not-my-run"] = []; })).rejects.toBeInstanceOf(ScopeViolation);
    expect(kv.dump()).toBe(before);
    // A view of one business never contains another's records.
    const view = await a.readState(mine.id, s => s);
    expect(Object.keys(view.businesses)).toEqual([mine.id]);
    expect(Object.keys(view.messages)).toEqual([mine.id]);
  });

  test("owner listing shows only the owner's workspaces, even if the index were tampered with", async () => {
    const { kv, instances: [a] } = cluster(1);
    const m1 = await a.createBusiness({ ownerHash: "me", initialMessage: "1" });
    const m2 = await a.createBusiness({ ownerHash: "me", initialMessage: "2" });
    const other = await a.createBusiness({ ownerHash: "them", initialMessage: "3" });
    await kv.cas({ docs: [], ttlMs: null, side: [{ op: "sadd", key: storeKeys.owner("me"), member: other.id }] });   // a poisoned index entry
    expect((await a.listBusinessesByOwner("me")).map(b => b.id).sort()).toEqual([m1.id, m2.id].sort());
    expect((await a.listBusinessesByOwner("them")).map(b => b.id)).toEqual([other.id]);
    expect(await a.listBusinessesByOwner("nobody")).toEqual([]);
    expect(await a.getBusiness("not-a-uuid")).toBeNull();
  });

  test("public ledger slugs: one business per slug, unpublishing removes it, the index is re-checked", async () => {
    const { instances: [a, b] } = cluster(2);
    const x = await a.createBusiness({ ownerHash: "o1", initialMessage: "x" });
    const y = await b.createBusiness({ ownerHash: "o2", initialMessage: "y" });
    const slug = "S".repeat(24);
    await a.transact(x.id, s => { s.businesses[x.id].public_ledger_slug = slug; });
    expect(await b.businessIdForLedgerSlug(slug)).toBe(x.id);
    await expect(b.transact(y.id, s => { s.businesses[y.id].public_ledger_slug = slug; })).rejects.toBeInstanceOf(LedgerSlugTakenError);
    expect((await b.getBusiness(y.id))!.public_ledger_slug ?? null).toBeNull();
    await a.transact(x.id, s => { s.businesses[x.id].public_ledger_slug = null; });
    expect(await b.businessIdForLedgerSlug(slug)).toBeNull();
  });
});

describe("shared store: workspace expiry, fences and failures", () => {
  test("a workspace expires 60 days after its last change; any change resets the clock", async () => {
    let t = Date.parse("2026-11-10T00:00:00Z");
    const { instances: [a] } = cluster(1, { now: () => t });
    const biz = await a.createBusiness({ ownerHash: "o1", initialMessage: "x" });
    t += 59 * 86_400_000;
    await a.updateBusiness(biz.id, { name: "still here" });
    t += 59 * 86_400_000;
    expect((await a.getBusiness(biz.id))?.name).toBe("still here");
    expect((await a.listBusinessesByOwner("o1")).map(b => b.id)).toEqual([biz.id]);
    t += 2 * 86_400_000;
    expect(await a.getBusiness(biz.id)).toBeNull();
    expect(await a.listBusinessesByOwner("o1")).toEqual([]);
  });

  test("a write under a lock that was lost fails with FENCE_LOST and changes nothing", async () => {
    const { kv, instances: [a] } = cluster(1);
    const biz = await a.createBusiness({ ownerHash: "o1", initialMessage: "x" });
    await kv.lockAcquire("lock:biz:x", "me", 60_000);
    await withFence({ key: "lock:biz:x", token: "me", minTtlMs: 0 }, () => a.updateBusiness(biz.id, { name: "ok" }));
    await kv.lockRelease("lock:biz:x", "me");
    await kv.lockAcquire("lock:biz:x", "someone-else", 60_000);
    await expect(withFence({ key: "lock:biz:x", token: "me", minTtlMs: 0 }, () => a.updateBusiness(biz.id, { name: "late" }))).rejects.toBeInstanceOf(FenceLostError);
    expect((await a.getBusiness(biz.id))!.name).toBe("ok");
  });

  test("when the shared store is unreachable every operation fails closed (no fallback, nothing invented)", async () => {
    const { kv, instances: [a] } = cluster(1);
    const biz = await a.createBusiness({ ownerHash: "o1", initialMessage: "x" });
    kv.failWith = new KvUnavailableError("down");
    await expect(a.getBusiness(biz.id)).rejects.toBeInstanceOf(KvUnavailableError);
    await expect(a.transact(biz.id, v => bump(v, biz.id))).rejects.toBeInstanceOf(KvUnavailableError);
    await expect(a.createBusiness({ ownerHash: "o1", initialMessage: "y" })).rejects.toBeInstanceOf(KvUnavailableError);
    kv.failWith = null;
    expect((await a.getBusiness(biz.id))!.summary).toBeNull();
  });
});
