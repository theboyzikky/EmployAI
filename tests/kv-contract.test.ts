// The shared-store contract. The SAME cases run against MemoryKv (always) and against a real Upstash
// database when KV_CONTRACT_UPSTASH_URL and KV_CONTRACT_UPSTASH_TOKEN are set (a separate, disposable
// test database: keys use a random prefix and short expiries). This is what ties the Lua scripts in
// src/lib/kv/upstash.ts to their in-process twin.
import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import { MemoryKv } from "@/lib/kv/memory";
import { KvUnavailableError, decimalGreater, type Kv } from "@/lib/kv/types";
import { UpstashKv } from "@/lib/kv/upstash";

type Harness = { kv: Kv; advance(ms: number): Promise<void> };

function memoryHarness(): Harness {
  let t = 1_000_000;
  const kv = new MemoryKv({ now: () => t });
  return { kv, advance: async ms => { t += ms; } };
}

const upstashUrl = process.env.KV_CONTRACT_UPSTASH_URL, upstashToken = process.env.KV_CONTRACT_UPSTASH_TOKEN;
const harnesses: Array<[string, () => Harness]> = [["MemoryKv", memoryHarness]];
if (upstashUrl && upstashToken) {
  harnesses.push(["UpstashKv (live test database)", () => ({
    kv: new UpstashKv({ url: upstashUrl, token: upstashToken, prefix: `eai-contract:${randomUUID()}:` }),
    advance: ms => new Promise(r => setTimeout(r, ms)),
  })]);
}

describe.each(harnesses)("Kv contract: %s", (_name, make) => {
  test("compare-and-set: new doc, version bump, stale version refused, nothing written on conflict", async () => {
    const { kv } = make();
    expect(await kv.cas({ docs: [{ key: "d", expect: 0, value: "v1" }], ttlMs: 60_000 })).toBe("ok");
    expect(await kv.mget(["d", "d:v"])).toEqual(["v1", "1"]);
    expect(await kv.cas({ docs: [{ key: "d", expect: 0, value: "lost-update" }], ttlMs: 60_000 })).toBe("conflict");
    expect(await kv.get("d")).toBe("v1");
    expect(await kv.cas({ docs: [{ key: "d", expect: 1, value: "v2" }], ttlMs: 60_000 })).toBe("ok");
    expect(await kv.mget(["d", "d:v"])).toEqual(["v2", "2"]);
  });

  test("multi-document commit is all-or-nothing, including read-only validation", async () => {
    const { kv } = make();
    await kv.cas({ docs: [{ key: "a", expect: 0, value: "a1" }, { key: "s", expect: 0, value: "s1" }], ttlMs: 60_000 });
    // s changed by someone else: a commit that only READ s must not apply its write to a.
    await kv.cas({ docs: [{ key: "s", expect: 1, value: "s2" }], ttlMs: 60_000 });
    expect(await kv.cas({ docs: [{ key: "a", expect: 1, value: "a2" }, { key: "s", expect: 1, value: null }], ttlMs: 60_000 })).toBe("conflict");
    expect(await kv.get("a")).toBe("a1");
    expect(await kv.cas({ docs: [{ key: "a", expect: 1, value: "a2" }, { key: "s", expect: 2, value: null }], ttlMs: 60_000 })).toBe("ok");
    expect(await kv.mget(["a", "s", "s:v"])).toEqual(["a2", "s2", "2"]);
  });

  test("fencing: only the current lock holder with enough time left can commit", async () => {
    const { kv, advance } = make();
    expect(await kv.lockAcquire("L", "tok-A", 1_500)).toBe(true);
    const fence = { key: "L", token: "tok-A", minTtlMs: 200 };
    expect(await kv.cas({ docs: [{ key: "f", expect: 0, value: "1" }], ttlMs: 60_000, fences: [fence] })).toBe("ok");
    expect(await kv.cas({ docs: [{ key: "f", expect: 1, value: "x" }], ttlMs: 60_000, fences: [{ ...fence, token: "tok-B" }] })).toBe("fence_lost");
    expect(await kv.cas({ docs: [{ key: "f", expect: 1, value: "x" }], ttlMs: 60_000, fences: [{ ...fence, minTtlMs: 10_000 }] })).toBe("fence_lost");
    await advance(1_700);  // A's lock expired; B takes it
    expect(await kv.cas({ docs: [{ key: "f", expect: 1, value: "late" }], ttlMs: 60_000, fences: [fence] })).toBe("fence_lost");
    expect(await kv.lockAcquire("L", "tok-B", 5_000)).toBe(true);
    expect(await kv.cas({ docs: [{ key: "f", expect: 1, value: "late" }], ttlMs: 60_000, fences: [fence] })).toBe("fence_lost");
    expect(await kv.get("f")).toBe("1");
    // Two fences: both must hold.
    expect(await kv.lockAcquire("L2", "tok-C", 5_000)).toBe(true);
    const fB = { key: "L", token: "tok-B", minTtlMs: 0 }, fC = { key: "L2", token: "tok-C", minTtlMs: 0 };
    expect(await kv.cas({ docs: [{ key: "f", expect: 1, value: "two" }], ttlMs: 60_000, fences: [fB, { ...fC, token: "nope" }] })).toBe("fence_lost");
    expect(await kv.cas({ docs: [{ key: "f", expect: 1, value: "two" }], ttlMs: 60_000, fences: [fB, fC] })).toBe("ok");
  });

  test("side writes: setnx claims or blocks the whole commit; del_if; sadd; max keeps the larger integer", async () => {
    const { kv } = make();
    expect(await kv.cas({ docs: [{ key: "b1", expect: 0, value: "x" }], ttlMs: 60_000, side: [{ op: "setnx", key: "slug:s", value: "b1" }, { op: "sadd", key: "own:h", member: "b1" }] })).toBe("ok");
    expect(await kv.cas({ docs: [{ key: "b2", expect: 0, value: "y" }], ttlMs: 60_000, side: [{ op: "setnx", key: "slug:s", value: "b2" }] })).toBe("side_conflict");
    expect(await kv.get("b2")).toBeNull();   // nothing applied
    expect(await kv.cas({ docs: [{ key: "b1", expect: 1, value: "x2" }], ttlMs: 60_000, side: [{ op: "setnx", key: "slug:s", value: "b1" }] })).toBe("ok"); // same value: fine
    await kv.cas({ docs: [], ttlMs: 60_000, side: [{ op: "del_if", key: "slug:s", value: "someone-else" }] });
    expect(await kv.get("slug:s")).toBe("b1");
    await kv.cas({ docs: [], ttlMs: 60_000, side: [{ op: "del_if", key: "slug:s", value: "b1" }, { op: "sadd", key: "own:h", member: "b3" }] });
    expect(await kv.get("slug:s")).toBeNull();
    expect((await kv.smembers("own:h")).sort()).toEqual(["b1", "b3"]);
    await kv.cas({ docs: [], ttlMs: null, side: [{ op: "srem", key: "own:h", member: "b1" }, { op: "srem", key: "own:h", member: "never-there" }] });
    expect(await kv.smembers("own:h")).toEqual(["b3"]);
    await kv.cas({ docs: [], ttlMs: null, side: [{ op: "max", key: "nonce", value: "277000000000005" }] });
    await kv.cas({ docs: [], ttlMs: null, side: [{ op: "max", key: "nonce", value: "99999999999999" }] });
    expect(await kv.get("nonce")).toBe("277000000000005");
    await kv.cas({ docs: [], ttlMs: null, side: [{ op: "max", key: "nonce", value: "277000000000006" }] });
    expect(await kv.get("nonce")).toBe("277000000000006");
  });

  test("documents expire with their TTL (workspace expiry)", async () => {
    const { kv, advance } = make();
    await kv.cas({ docs: [{ key: "e", expect: 0, value: "v" }], ttlMs: 1_000 });
    expect(await kv.pttl("e")).toBeGreaterThan(0);
    await advance(1_300);
    expect(await kv.mget(["e", "e:v"])).toEqual([null, null]);
    // A per-document ttl overrides the request's (null = never expires).
    await kv.cas({ docs: [{ key: "keep", expect: 0, value: "k", ttlMs: null }, { key: "short", expect: 0, value: "s" }], ttlMs: 500 });
    await advance(700);
    expect(await kv.mget(["keep", "short"])).toEqual(["k", null]);
    expect(await kv.pttl("keep")).toBe(-1);
    // An expired doc starts again from version 0.
    expect(await kv.cas({ docs: [{ key: "e", expect: 0, value: "again" }], ttlMs: 1_000 })).toBe("ok");
  });

  test("locks: exclusive, renewed and released only by their holder, re-taken after expiry", async () => {
    const { kv, advance } = make();
    expect(await kv.lockAcquire("lk", "A", 1_000)).toBe(true);
    expect(await kv.lockAcquire("lk", "B", 1_000)).toBe(false);
    expect(await kv.lockRenew("lk", "B", 5_000)).toBe(false);
    expect(await kv.lockRelease("lk", "B")).toBe(false);
    expect(await kv.lockRenew("lk", "A", 3_000)).toBe(true);
    await advance(1_500);
    expect(await kv.lockAcquire("lk", "B", 1_000)).toBe(false);   // renewal extended A
    await advance(2_000);
    expect(await kv.lockAcquire("lk", "B", 1_000)).toBe(true);    // A expired
    expect(await kv.lockRelease("lk", "A")).toBe(false);          // A can't release B's lock
    expect(await kv.lockRelease("lk", "B")).toBe(true);
  });

  test("fixed-window counter", async () => {
    const { kv, advance } = make();
    expect(await kv.hit("rl", 1_000)).toBe(1);
    expect(await kv.hit("rl", 1_000)).toBe(2);
    await advance(1_300);
    expect(await kv.hit("rl", 1_000)).toBe(1);
  });

  test("AI spend: reserve worst case atomically, call ceiling, settle releases the reservation", async () => {
    const { kv } = make();
    const keys = { spentKey: "sp", reservedKey: "rs", callsKey: "calls", ttlMs: 60_000 };
    expect(await kv.spendReserve({ ...keys, worstNano: 600, capNano: 1_000, maxCalls: 10 })).toBe("ok");
    expect(await kv.spendReserve({ ...keys, worstNano: 600, capNano: 1_000, maxCalls: 10 })).toBe("BUDGET_CAP"); // 600 reserved + 600 > 1000
    await kv.spendSettle({ ...keys, worstNano: 600, actualNano: 100 });
    expect(await kv.mget(["sp", "rs", "calls"])).toEqual(["100", "0", "1"]);
    expect(await kv.spendReserve({ ...keys, worstNano: 600, capNano: 1_000, maxCalls: 10 })).toBe("ok");
    expect(await kv.spendReserve({ ...keys, worstNano: 300, capNano: 1_000, maxCalls: 10 })).toBe("ok");   // 100 + 600 + 300 = 1000
    expect(await kv.spendReserve({ ...keys, worstNano: 1, capNano: 1_000, maxCalls: 10 })).toBe("BUDGET_CAP");
    expect(await kv.spendReserve({ ...keys, worstNano: 0, capNano: 1_000, maxCalls: 3 })).toBe("CALL_LIMIT");
  });
});

describe("UpstashKv request handling (no network)", () => {
  test("sends Bearer-authenticated JSON commands with the key prefix; errors fail closed without echoing the answer", async () => {
    const seen: Array<{ url: string; auth: string; body: string[] }> = [];
    const ok = (result: unknown) => ({ ok: true, status: 200, json: async () => ({ result }) });
    const kv = new UpstashKv({ url: "https://example.upstash.io", token: "tkn", prefix: "p:", fetchImpl: async (url, init) => { seen.push({ url, auth: init.headers.Authorization, body: JSON.parse(init.body) }); return ok("v"); } });
    expect(await kv.get("x")).toBe("v");
    expect(seen[0]).toEqual({ url: "https://example.upstash.io", auth: "Bearer tkn", body: ["GET", "p:x"] });

    const failing = new UpstashKv({ url: "https://example.upstash.io", token: "tkn", fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ error: "WRONGPASS secret-ish detail" }) }) });
    const err = await failing.get("x").catch(e => e);
    expect(err).toBeInstanceOf(KvUnavailableError);
    expect(String(err.message)).not.toContain("secret-ish");
    const down = new UpstashKv({ url: "https://example.upstash.io", token: "tkn", fetchImpl: async () => { throw new Error("ECONNRESET"); } });
    await expect(down.cas({ docs: [], ttlMs: null })).rejects.toBeInstanceOf(KvUnavailableError);
  });

  test("refuses a non-https URL or a missing token", () => {
    expect(() => new UpstashKv({ url: "http://example.upstash.io", token: "t" })).toThrow(KvUnavailableError);
    expect(() => new UpstashKv({ url: "https://example.upstash.io", token: "" })).toThrow(KvUnavailableError);
  });

  test("decimalGreater compares big decimal strings exactly", () => {
    expect(decimalGreater("277000000000006", "277000000000005")).toBe(true);
    expect(decimalGreater("99", "100")).toBe(false);
    expect(decimalGreater("0010", "9")).toBe(true);
  });
});
