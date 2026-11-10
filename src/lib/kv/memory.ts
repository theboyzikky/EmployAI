// In-process twin of the Upstash scripts (local development and tests). Each operation's core runs
// synchronously, so it is atomic exactly like one Redis command or Lua script. `latency` (tests) adds an
// async pause before and after every operation, so several "server instances" sharing one MemoryKv
// interleave the way separate Vercel instances sharing one Redis would.
import { decimalGreater, type CasRequest, type CasResult, type Kv, type SpendReserve, type SpendSettle } from "./types";

type Entry = { v: string | Set<string>; exp: number | null };

export class MemoryKv implements Kv {
  readonly kind = "memory" as const;
  private readonly data = new Map<string, Entry>();
  /** Test hooks: inject a clock, latency, or a failure (to prove callers fail closed). */
  now: () => number;
  latency: (() => Promise<void>) | null;
  failWith: Error | null = null;
  /** Counts of each operation (tests). */
  readonly calls = new Map<string, number>();

  constructor(o: { now?: () => number; latency?: () => Promise<void> } = {}) {
    this.now = o.now ?? (() => Date.now());
    this.latency = o.latency ?? null;
  }

  private live(key: string): Entry | undefined {
    const e = this.data.get(key);
    if (e && e.exp !== null && e.exp <= this.now()) { this.data.delete(key); return undefined; }
    return e;
  }
  private str(key: string): string | null { const e = this.live(key); return e && typeof e.v === "string" ? e.v : null; }
  private put(key: string, v: string, ttlMs: number | null) { this.data.set(key, { v, exp: ttlMs && ttlMs > 0 ? this.now() + ttlMs : null }); }
  private expire(key: string, ttlMs: number) { const e = this.live(key); if (e) e.exp = this.now() + ttlMs; }

  private async op<T>(name: string, fn: () => T): Promise<T> {
    this.calls.set(name, (this.calls.get(name) ?? 0) + 1);
    if (this.latency) await this.latency();
    if (this.failWith) throw this.failWith;
    const out = fn();
    if (this.latency) await this.latency();
    return out;
  }

  get(key: string) { return this.op("get", () => this.str(key)); }
  mget(keys: string[]) { return this.op("mget", () => keys.map(k => this.str(k))); }
  smembers(key: string) { return this.op("smembers", () => { const e = this.live(key); return e && e.v instanceof Set ? [...e.v] : []; }); }
  set(key: string, value: string, ttlMs: number | null = null) { return this.op("set", () => { this.put(key, value, ttlMs); }); }
  del(key: string) { return this.op("del", () => { this.data.delete(key); }); }
  pttl(key: string) { return this.op("pttl", () => { const e = this.live(key); return !e ? -2 : e.exp === null ? -1 : e.exp - this.now(); }); }

  cas(req: CasRequest) { return this.op("cas", () => this.casSync(req)); }

  /** The commit itself (synchronous, atomic). Also used directly by the local file store for fences. */
  casSync(req: CasRequest): CasResult {
    for (const d of req.docs) if (Number(this.str(`${d.key}:v`) ?? "0") !== d.expect) return "conflict";
    for (const f of req.fences ?? []) if (!this.holdsSync(f.key, f.token, f.minTtlMs)) return "fence_lost";
    const side = req.side ?? [];
    for (const s of side) if (s.op === "setnx") { const cur = this.str(s.key); if (cur !== null && cur !== s.value) return "side_conflict"; }
    for (const d of req.docs) {
      if (d.value === null) continue;
      const ttl = d.ttlMs === undefined ? req.ttlMs : d.ttlMs;
      this.put(d.key, d.value, ttl);
      this.put(`${d.key}:v`, String(d.expect + 1), ttl);
    }
    for (const s of side) {
      if (s.op === "setnx") this.put(s.key, s.value, req.ttlMs);
      else if (s.op === "del_if") { if (this.str(s.key) === s.value) this.data.delete(s.key); }
      else if (s.op === "sadd") {
        const e = this.live(s.key);
        const set = e && e.v instanceof Set ? e.v : new Set<string>();
        set.add(s.member);
        this.data.set(s.key, { v: set, exp: req.ttlMs && req.ttlMs > 0 ? this.now() + req.ttlMs : e?.exp ?? null });
      } else if (s.op === "srem") {
        const e = this.live(s.key);
        if (e && e.v instanceof Set) { e.v.delete(s.member); if (e.v.size === 0) this.data.delete(s.key); }
      } else if (s.op === "max") {
        const cur = this.str(s.key);
        if (cur === null || decimalGreater(s.value, cur)) this.put(s.key, s.value, null);
      }
    }
    return "ok";
  }

  lockAcquire(key: string, token: string, ttlMs: number) {
    return this.op("lockAcquire", () => { if (this.live(key)) return false; this.put(key, token, ttlMs); return true; });
  }
  lockRenew(key: string, token: string, ttlMs: number) {
    return this.op("lockRenew", () => { if (this.str(key) !== token) return false; this.expire(key, ttlMs); return true; });
  }
  lockRelease(key: string, token: string) {
    return this.op("lockRelease", () => { if (this.str(key) !== token) return false; this.data.delete(key); return true; });
  }
  /** Synchronous lock check (the local file store's fence). */
  holdsSync(key: string, token: string, minTtlMs: number): boolean {
    const e = this.live(key);
    if (!e || e.v !== token) return false;
    return (e.exp === null ? Infinity : e.exp - this.now()) >= minTtlMs;
  }

  hit(key: string, windowMs: number) {
    return this.op("hit", () => {
      const n = Number(this.str(key) ?? "0") + 1;
      const e = this.live(key);
      this.data.set(key, { v: String(n), exp: e?.exp ?? this.now() + windowMs });
      return n;
    });
  }

  spendReserve(o: SpendReserve) {
    return this.op("spendReserve", (): "ok" | "BUDGET_CAP" | "CALL_LIMIT" => {
      const calls = Number(this.str(o.callsKey) ?? "0");
      if (calls >= o.maxCalls) return "CALL_LIMIT";
      const spent = Number(this.str(o.spentKey) ?? "0"), reserved = Number(this.str(o.reservedKey) ?? "0");
      if (spent + reserved + o.worstNano > o.capNano) return "BUDGET_CAP";
      this.put(o.callsKey, String(calls + 1), null);
      this.put(o.reservedKey, String(reserved + o.worstNano), o.ttlMs);
      if (this.str(o.spentKey) === null) this.put(o.spentKey, "0", o.ttlMs);
      return "ok";
    });
  }
  spendSettle(o: SpendSettle) {
    return this.op("spendSettle", () => {
      const reserved = Math.max(0, Number(this.str(o.reservedKey) ?? "0") - o.worstNano);
      this.put(o.reservedKey, String(reserved), o.ttlMs);
      this.put(o.spentKey, String(Number(this.str(o.spentKey) ?? "0") + o.actualNano), o.ttlMs);
    });
  }

  /** Tests: every key (expired ones dropped). */
  keys(): string[] { return [...this.data.keys()].filter(k => this.live(k)); }
  /** Tests: every live key and value, in a stable order (to prove that reads write nothing). */
  dump(): string {
    return JSON.stringify(this.keys().sort().map(k => { const v = this.data.get(k)!.v; return [k, typeof v === "string" ? v : [...v].sort()]; }));
  }
}
