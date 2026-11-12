import "server-only";
// Which shared store this server uses (one per process, on globalThis):
//  - Upstash Redis when its REST URL and token are set (the hosted demo; Vercel's Upstash integration
//    sets KV_REST_API_URL / KV_REST_API_TOKEN or UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN);
//  - on Vercel WITHOUT them: "missing", and every operation fails closed (no silent fallback to /tmp
//    or to memory, which would reset spend limits and split state between instances);
//  - otherwise (local development): an in-process MemoryKv. Single process only, like the file store.
import { MemoryKv } from "./memory";
import { KvUnavailableError, type Kv } from "./types";
import { UpstashKv } from "./upstash";

export type KvMode = "upstash" | "memory" | "missing";
type Env = Record<string, string | undefined>;

export function kvMode(env: Env = process.env): KvMode {
  const url = env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN;
  if (url && token) return "upstash";
  if (env.VERCEL || env.EMPLOYAI_REQUIRE_SHARED_STORE === "true") return "missing";
  return "memory";
}

/** True when this server must behave as the shared, multi-instance hosted demo. */
export const isSharedStore = (env: Env = process.env) => kvMode(env) !== "memory";

const KEY = Symbol.for("employai.kv");
const g = globalThis as unknown as { [KEY]?: Kv | null };

class MissingKv implements Kv {
  readonly kind = "upstash" as const;
  private fail(): never { throw new KvUnavailableError("The shared store (Upstash Redis) isn't configured on this server."); }
  get() { return Promise.reject(this.err()); }
  mget() { return Promise.reject(this.err()); }
  smembers() { return Promise.reject(this.err()); }
  set() { return Promise.reject(this.err()); }
  del() { return Promise.reject(this.err()); }
  pttl() { return Promise.reject(this.err()); }
  cas() { return Promise.reject(this.err()); }
  lockAcquire() { return Promise.reject(this.err()); }
  lockRenew() { return Promise.reject(this.err()); }
  lockRelease() { return Promise.reject(this.err()); }
  hit() { return Promise.reject(this.err()); }
  spendReserve() { return Promise.reject(this.err()); }
  spendSettle() { return Promise.reject(this.err()); }
  private err() { try { this.fail(); } catch (e) { return e; } }
}

export function getKv(env: Env = process.env): Kv {
  if (g[KEY]) return g[KEY]!;
  const mode = kvMode(env);
  const kv: Kv = mode === "upstash"
    ? new UpstashKv({ url: (env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL)!, token: (env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN)!, prefix: env.EMPLOYAI_KV_PREFIX || "eai:" })
    : mode === "missing" ? new MissingKv() : new MemoryKv();
  g[KEY] = kv;
  return kv;
}

/** Tests: use this Kv (null forgets it). */
export function setKvForTests(kv: Kv | null) { g[KEY] = kv; }

export { KvUnavailableError, type Kv } from "./types";
export { MemoryKv } from "./memory";
