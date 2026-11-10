import "server-only";
// Upstash Redis over its REST API (plain fetch: no SDK dependency). Every atomic operation is ONE Lua
// script, the exact twin of the synchronous block in MemoryKv (tests/kv-contract.test.ts runs the same
// cases against both). Errors, timeouts and non-2xx answers throw KvUnavailableError: no fallback.
import { KvUnavailableError, type CasRequest, type CasResult, type Kv, type SpendReserve, type SpendSettle } from "./types";

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

// KEYS: doc_1, doc_1:v, …, doc_n, doc_n:v, fence keys…, side keys…
// ARGV: n, ttlMs, nFences, nSide, (expect, hasValue, value, docTtl) × n, (token, minTtl) × nFences, (op, arg) × nSide
// docTtl: "" = the request's ttlMs, "0" = no expiry, otherwise milliseconds.
const CAS = `
local n = tonumber(ARGV[1]); local ttl = tonumber(ARGV[2]); local nF = tonumber(ARGV[3]); local nSide = tonumber(ARGV[4])
local a = 5
for i = 1, n do
  local cur = tonumber(redis.call("GET", KEYS[2 * i]) or "0")
  if cur ~= tonumber(ARGV[a + (i - 1) * 4]) then return "conflict" end
end
local fa = a + n * 4
for f = 1, nF do
  local fk = KEYS[2 * n + f]
  if redis.call("GET", fk) ~= ARGV[fa + (f - 1) * 2] then return "fence_lost" end
  local left = redis.call("PTTL", fk)
  if left ~= -1 and left < tonumber(ARGV[fa + (f - 1) * 2 + 1]) then return "fence_lost" end
end
local k = 2 * n + nF + 1
local sa = fa + nF * 2
for j = 1, nSide do
  if ARGV[sa + (j - 1) * 2] == "setnx" then
    local cur = redis.call("GET", KEYS[k + j - 1])
    if cur and cur ~= ARGV[sa + (j - 1) * 2 + 1] then return "side_conflict" end
  end
end
local function put(key, val, t)
  if t > 0 then redis.call("SET", key, val, "PX", t) else redis.call("SET", key, val) end
end
for i = 1, n do
  local b = a + (i - 1) * 4
  if ARGV[b + 1] == "1" then
    local t = ttl
    if ARGV[b + 3] ~= "" then t = tonumber(ARGV[b + 3]) end
    put(KEYS[2 * i - 1], ARGV[b + 2], t)
    put(KEYS[2 * i], tostring(tonumber(ARGV[b]) + 1), t)
  end
end
local function greater(x, y)
  x = string.gsub(x, "^0+(%d)", "%1"); y = string.gsub(y, "^0+(%d)", "%1")
  if #x ~= #y then return #x > #y end
  return x > y
end
for j = 1, nSide do
  local op = ARGV[sa + (j - 1) * 2]; local arg = ARGV[sa + (j - 1) * 2 + 1]; local key = KEYS[k + j - 1]
  if op == "setnx" then put(key, arg, ttl)
  elseif op == "del_if" then if redis.call("GET", key) == arg then redis.call("DEL", key) end
  elseif op == "sadd" then redis.call("SADD", key, arg); if ttl > 0 then redis.call("PEXPIRE", key, ttl) end
  elseif op == "max" then
    local cur = redis.call("GET", key)
    if (not cur) or greater(arg, cur) then redis.call("SET", key, arg) end
  end
end
return "ok"`;

const LOCK_ACQUIRE = `if redis.call("SET", KEYS[1], ARGV[1], "NX", "PX", ARGV[2]) then return 1 else return 0 end`;
const LOCK_RENEW = `if redis.call("GET", KEYS[1]) == ARGV[1] then redis.call("PEXPIRE", KEYS[1], ARGV[2]); return 1 else return 0 end`;
const LOCK_RELEASE = `if redis.call("GET", KEYS[1]) == ARGV[1] then redis.call("DEL", KEYS[1]); return 1 else return 0 end`;
const HIT = `local c = redis.call("INCR", KEYS[1]); if c == 1 then redis.call("PEXPIRE", KEYS[1], ARGV[1]) end; return c`;
// KEYS: spent, reserved, calls · ARGV: worst, cap, maxCalls, ttl
const SPEND_RESERVE = `
local calls = tonumber(redis.call("GET", KEYS[3]) or "0")
if calls >= tonumber(ARGV[3]) then return "CALL_LIMIT" end
local spent = tonumber(redis.call("GET", KEYS[1]) or "0"); local reserved = tonumber(redis.call("GET", KEYS[2]) or "0")
if spent + reserved + tonumber(ARGV[1]) > tonumber(ARGV[2]) then return "BUDGET_CAP" end
redis.call("SET", KEYS[3], tostring(calls + 1))
redis.call("SET", KEYS[2], tostring(reserved + tonumber(ARGV[1])), "PX", ARGV[4])
if not redis.call("GET", KEYS[1]) then redis.call("SET", KEYS[1], "0", "PX", ARGV[4]) end
return "ok"`;
// KEYS: spent, reserved · ARGV: worst, actual, ttl
const SPEND_SETTLE = `
local r = tonumber(redis.call("GET", KEYS[2]) or "0") - tonumber(ARGV[1]); if r < 0 then r = 0 end
redis.call("SET", KEYS[2], tostring(r), "PX", ARGV[3])
redis.call("SET", KEYS[1], tostring(tonumber(redis.call("GET", KEYS[1]) or "0") + tonumber(ARGV[2])), "PX", ARGV[3])
return 1`;

export class UpstashKv implements Kv {
  readonly kind = "upstash" as const;
  private readonly url: string;
  private readonly token: string;
  private readonly prefix: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(o: { url: string; token: string; prefix?: string; timeoutMs?: number; fetchImpl?: FetchLike }) {
    let u: URL;
    try { u = new URL(o.url); } catch { throw new KvUnavailableError("The Upstash REST URL is malformed."); }
    if (u.protocol !== "https:") throw new KvUnavailableError("The Upstash REST URL must use https.");
    if (!o.token) throw new KvUnavailableError("The Upstash REST token is missing.");
    this.url = u.toString().replace(/\/$/, ""); this.token = o.token; this.prefix = o.prefix ?? "eai:";
    this.timeoutMs = o.timeoutMs ?? 5_000;
    this.fetchImpl = o.fetchImpl ?? (fetch as unknown as FetchLike);
  }

  private k = (key: string) => this.prefix + key;

  private async cmd(args: Array<string | number>): Promise<unknown> {
    let res;
    try {
      res = await this.fetchImpl(this.url, {
        method: "POST", headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
        body: JSON.stringify(args.map(String)), signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch { throw new KvUnavailableError("The shared store (Upstash) couldn't be reached."); }
    let body: { result?: unknown; error?: string };
    try { body = await res.json() as { result?: unknown; error?: string }; }
    catch { throw new KvUnavailableError(`The shared store answered ${res.status} without a readable body.`); }
    if (!res.ok || body.error !== undefined) throw new KvUnavailableError(`The shared store refused the request (${res.status}).`); // never echo the body: it could hold data
    return body.result;
  }
  private evalScript(script: string, keys: string[], args: Array<string | number>) {
    return this.cmd(["EVAL", script, keys.length, ...keys.map(this.k), ...args]);
  }

  async get(key: string) { const r = await this.cmd(["GET", this.k(key)]); return typeof r === "string" ? r : null; }
  async mget(keys: string[]) {
    if (keys.length === 0) return [];
    const r = await this.cmd(["MGET", ...keys.map(this.k)]);
    if (!Array.isArray(r)) throw new KvUnavailableError("Unexpected MGET answer.");
    return r.map(x => (typeof x === "string" ? x : null));
  }
  async smembers(key: string) { const r = await this.cmd(["SMEMBERS", this.k(key)]); return Array.isArray(r) ? r.filter((x): x is string => typeof x === "string") : []; }
  async set(key: string, value: string, ttlMs: number | null = null) { await this.cmd(ttlMs && ttlMs > 0 ? ["SET", this.k(key), value, "PX", ttlMs] : ["SET", this.k(key), value]); }
  async del(key: string) { await this.cmd(["DEL", this.k(key)]); }
  async pttl(key: string) { return Number(await this.cmd(["PTTL", this.k(key)])); }

  async cas(req: CasRequest): Promise<CasResult> {
    const keys: string[] = [];
    for (const d of req.docs) keys.push(d.key, `${d.key}:v`);
    const fences = req.fences ?? [];
    for (const f of fences) keys.push(f.key);
    const side = req.side ?? [];
    for (const s of side) keys.push(s.key);
    const args: Array<string | number> = [req.docs.length, req.ttlMs ?? 0, fences.length, side.length];
    for (const d of req.docs) args.push(d.expect, d.value === null ? 0 : 1, d.value ?? "", d.ttlMs === undefined ? "" : d.ttlMs ?? 0);
    for (const f of fences) args.push(f.token, f.minTtlMs);
    for (const s of side) args.push(s.op, s.op === "sadd" ? s.member : s.value);
    const r = await this.evalScript(CAS, keys, args);
    if (r === "ok" || r === "conflict" || r === "fence_lost" || r === "side_conflict") return r;
    throw new KvUnavailableError("Unexpected commit answer.");
  }

  async lockAcquire(key: string, token: string, ttlMs: number) { return Number(await this.evalScript(LOCK_ACQUIRE, [key], [token, ttlMs])) === 1; }
  async lockRenew(key: string, token: string, ttlMs: number) { return Number(await this.evalScript(LOCK_RENEW, [key], [token, ttlMs])) === 1; }
  async lockRelease(key: string, token: string) { return Number(await this.evalScript(LOCK_RELEASE, [key], [token])) === 1; }
  async hit(key: string, windowMs: number) { return Number(await this.evalScript(HIT, [key], [windowMs])); }

  async spendReserve(o: SpendReserve) {
    const r = await this.evalScript(SPEND_RESERVE, [o.spentKey, o.reservedKey, o.callsKey], [o.worstNano, o.capNano, o.maxCalls, o.ttlMs]);
    if (r === "ok" || r === "BUDGET_CAP" || r === "CALL_LIMIT") return r;
    throw new KvUnavailableError("Unexpected spend answer.");
  }
  async spendSettle(o: SpendSettle) { await this.evalScript(SPEND_SETTLE, [o.spentKey, o.reservedKey], [o.worstNano, o.actualNano, o.ttlMs]); }
}
