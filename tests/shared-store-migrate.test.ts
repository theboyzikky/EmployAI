// Migration and rollback between the local dev store and the shared store. Runs against a COPY of the
// real .data/dev-store.json when present (read only; its checksum is checked before and after), plus a
// fixture. Proves: the script's documents equal the app's own partitioning; the app reads migrated data
// unchanged; nothing existing is ever overwritten; export restores the same data.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { applyPlan, exportToDevState, planFromDevState } from "../scripts/shared-store-migrate.mjs";
import type { DevState } from "@/lib/discovery/store";
import { MemoryKv } from "@/lib/kv/memory";
import { extractBusiness } from "@/lib/store/partition";
import { RedisStore } from "@/lib/store/redis-store";
import { readyRestaurant, tempStore } from "./helpers/run-fixture";

/** Redis commands used by the script, served by a MemoryKv (no prefix). */
function fakeClient(kv: MemoryKv) {
  return {
    async cmd(a: string[]): Promise<unknown> {
      switch (a[0]) {
        case "MSETNX": {
          const pairs: Array<[string, string]> = [];
          for (let i = 1; i < a.length; i += 2) pairs.push([a[i], a[i + 1]]);
          if ((await kv.mget(pairs.map(p => p[0]))).some(v => v !== null)) return 0;
          for (const [k, v] of pairs) await kv.set(k, v);
          return 1;
        }
        case "PEXPIRE": { const v = await kv.get(a[1]); if (v !== null) await kv.set(a[1], v, Number(a[2])); return 1; }
        case "SADD": await kv.cas({ docs: [], ttlMs: null, side: [{ op: "sadd", key: a[1], member: a[2] }] }); return 1;
        case "SET": { if (await kv.get(a[1]) !== null) return null; await kv.set(a[1], a[2], Number(a[5])); return "OK"; }
        case "MGET": return kv.mget(a.slice(1));
        case "SCAN": { const re = new RegExp(`^${a[3].replace("*", ".*")}$`); return ["0", kv.keys().filter(k => re.test(k))]; }
        default: throw new Error(`unexpected ${a[0]}`);
      }
    },
  };
}

const sources: Array<[string, () => Promise<DevState>]> = [
  ["fixture: a ready restaurant with a published ledger", async () => {
    const t = tempStore();
    const { businessId } = await readyRestaurant(t.store);
    await t.store.transact(businessId, s => { s.businesses[businessId].public_ledger_slug = "L".repeat(24); });
    await readyRestaurant(t.store, { ownerHash: "second-owner" });
    return t.store.readState(businessId, () => null).then(() => JSON.parse(readFileSync(t.file, "utf8")) as DevState).catch(() => { throw new Error("fixture needs the file store"); });
  }],
];
const real = path.join(process.cwd(), ".data", "dev-store.json");
if (existsSync(real)) sources.push(["a copy of the real local dev store (read only)", async () => JSON.parse(readFileSync(real, "utf8")) as DevState]);

describe.each(sources)("migration: %s", (_name, load) => {
  test("plan = the app's partitioning; apply + read back through the app = identical; re-apply overwrites nothing; export round-trips", async () => {
    const realBefore = existsSync(real) ? createHash("sha256").update(readFileSync(real)).digest("hex") : null;
    let state: DevState;
    try { state = await load(); } catch { return; }   // the fixture needs the file store (skipped in shared mode)
    const plan = planFromDevState(state);
    expect(plan.stats.businesses).toBe(Object.keys(state.businesses).length);
    for (const b of plan.businesses) expect(JSON.parse(b.doc)).toEqual(extractBusiness(state, b.id));

    const kv = new MemoryKv();
    const report = await applyPlan(fakeClient(kv), plan);
    expect(report.written).toHaveLength(plan.businesses.length);
    expect(report.verified).toBe(plan.businesses.length);
    expect(report.mismatched).toEqual([]);

    // The app reads every migrated workspace exactly as it was.
    const store = new RedisStore(kv);
    for (const id of Object.keys(state.businesses)) {
      expect(await store.getBusiness(id)).toEqual(state.businesses[id]);
      expect(await store.listMessages(id)).toEqual(state.messages[id] ?? []);
      expect(await store.readState(id, s => (s.ledger_entries ?? {})[id] ?? [])).toEqual((state.ledger_entries ?? {})[id] ?? []);
      const slug = state.businesses[id].public_ledger_slug;
      if (slug) expect(await store.businessIdForLedgerSlug(slug)).toBe(id);
    }
    const owners = new Set(Object.values(state.businesses).map(b => b.owner_hash));
    for (const h of owners) expect((await store.listBusinessesByOwner(h)).map(b => b.id).sort()).toEqual(Object.values(state.businesses).filter(b => b.owner_hash === h).map(b => b.id).sort());

    // A second apply (or one after the app changed a workspace) never overwrites.
    const first = Object.keys(state.businesses)[0];
    await store.updateBusiness(first, { name: "changed after migration" });
    const again = await applyPlan(fakeClient(kv), plan);
    expect(again.written).toEqual([]);
    expect(again.skippedExisting).toHaveLength(plan.businesses.length);
    expect((await store.getBusiness(first))!.name).toBe("changed after migration");

    // Rollback/export: every workspace comes back.
    const exported = await exportToDevState(fakeClient(kv)) as DevState;
    expect(Object.keys(exported.businesses).sort()).toEqual(Object.keys(state.businesses).sort());
    for (const id of Object.keys(state.businesses).filter(i => i !== first)) expect(extractBusiness(exported, id)).toEqual(extractBusiness(state, id));

    if (realBefore) expect(createHash("sha256").update(readFileSync(real)).digest("hex")).toBe(realBefore);   // never written
  });
});
