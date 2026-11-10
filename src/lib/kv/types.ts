// Shared key-value layer for the hosted demo (Upstash Redis) and its in-process twin (local development
// and tests). Every operation that must be atomic is ONE call here: one Redis Lua script in production,
// one synchronous block in MemoryKv. Nothing in this module has a fallback: an unreachable or
// unconfigured store throws KvUnavailableError, and callers fail closed.

export class KvUnavailableError extends Error {
  readonly code = "KV_UNAVAILABLE";
  constructor(message: string) { super(message); this.name = "KvUnavailableError"; }
}

/** A versioned document in a compare-and-set commit. `value: null` = read-validate only (no write). */
export type CasDoc = { key: string; expect: number; value: string | null };

/**
 * Extra writes applied in the same atomic step, only if every document version and the fence match.
 *  - setnx:  claim `key` for `value` (fails the whole commit if it holds a different value)
 *  - del_if: delete `key` only if it holds `value`
 *  - sadd:   add `member` to the set at `key`
 *  - max:    keep the larger of the stored and given non-negative integer (decimal string); no expiry
 */
export type SideOp =
  | { op: "setnx"; key: string; value: string }
  | { op: "del_if"; key: string; value: string }
  | { op: "sadd"; key: string; member: string }
  | { op: "max"; key: string; value: string };

/** The commit applies only while `key` still holds `token` with at least `minTtlMs` left (fencing). */
export type Fence = { key: string; token: string; minTtlMs: number };

export type CasRequest = { docs: CasDoc[]; ttlMs: number | null; fence?: Fence | null; side?: SideOp[] };
export type CasResult = "ok" | "conflict" | "fence_lost" | "side_conflict";

export type SpendReserve = { spentKey: string; reservedKey: string; callsKey: string; worstNano: number; capNano: number; maxCalls: number; ttlMs: number };
export type SpendSettle = { spentKey: string; reservedKey: string; worstNano: number; actualNano: number; ttlMs: number };

export interface Kv {
  readonly kind: "memory" | "upstash";
  get(key: string): Promise<string | null>;
  mget(keys: string[]): Promise<Array<string | null>>;
  smembers(key: string): Promise<string[]>;
  /** Plain write, for operator flags and tests only (never for documents: use cas). */
  set(key: string, value: string, ttlMs?: number | null): Promise<void>;
  del(key: string): Promise<void>;
  /** Milliseconds left on a key (-2 missing, -1 no expiry). */
  pttl(key: string): Promise<number>;
  cas(req: CasRequest): Promise<CasResult>;
  lockAcquire(key: string, token: string, ttlMs: number): Promise<boolean>;
  lockRenew(key: string, token: string, ttlMs: number): Promise<boolean>;
  lockRelease(key: string, token: string): Promise<boolean>;
  /** Fixed-window counter: +1 and the count so far in this window (the key names the window). */
  hit(key: string, windowMs: number): Promise<number>;
  spendReserve(o: SpendReserve): Promise<"ok" | "BUDGET_CAP" | "CALL_LIMIT">;
  spendSettle(o: SpendSettle): Promise<void>;
}

/** Decimal non-negative integer strings compared without precision loss. */
export function decimalGreater(a: string, b: string): boolean {
  const x = a.replace(/^0+(?=\d)/, ""), y = b.replace(/^0+(?=\d)/, "");
  return x.length !== y.length ? x.length > y.length : x > y;
}
