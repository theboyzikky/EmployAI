// M4 · D20: ONE shared business lock for discovery, workflows and runs.
//
// Two layers:
//  1. In this process: a FIFO queue per business (on `globalThis`, so every route module shares it).
//  2. Across server instances: a lease on the shared store (`lock:biz:<id>`), with a unique token,
//     renewed while the work runs. The work runs inside the lease's fence, so if the lease is ever lost
//     (the instance stalled past the TTL, or the store expired it), every later write by this holder
//     fails (FenceLostError) instead of overwriting the new holder's work.
// Locally the "shared store" is the in-process MemoryKv; on the hosted demo it is Upstash Redis, and if
// it can't be reached the lock can't be taken (fail closed).
//
// Two ways to take it:
//  - "try":  fail fast if held (discovery turns and workflow edits keep their existing 409 behaviour);
//  - "wait": FIFO queue with a bounded wait (run operations: advance, start, approval decisions,
//            finalising control requests). Across instances the wait polls the lease (no FIFO order).
// Control requests (kill switch, pause, stop) never need this lock to be recorded: they persist through
// the store's own atomic commits (M4 plan §5.6). This lock is never bypassed or weakened.
import { getKv } from "@/lib/kv";
import { withFence } from "@/lib/store/fence-context";
import { acquireLease } from "@/lib/store/lease";

type Entry = { held: boolean; queue: Array<{ grant: () => void }> };

const REGISTRY = Symbol.for("employai.businessLocks");
const g = globalThis as unknown as { [REGISTRY]?: Map<string, Entry> };
const registry: Map<string, Entry> = (g[REGISTRY] ??= new Map());

/** The lock is held and the caller chose not to wait, or the bounded wait ran out. */
export class LockBusyError extends Error {
  constructor(readonly businessId: string, readonly waited: boolean) { super("BUSINESS_LOCK_BUSY"); }
}

export const DEFAULT_LOCK_WAIT_MS = 5_000;
/** The shared lease: renewed every 10 s while held; writes need at least 2 s of it left. */
export const BUSINESS_LEASE_TTL_MS = 30_000;
const FENCE_MIN_TTL_MS = 2_000;

export const businessLockKey = (businessId: string) => `lock:biz:${businessId}`;

export async function withBusinessLock<T>(businessId: string, fn: () => Promise<T>, opts: { mode: "try" | "wait"; timeoutMs?: number }): Promise<T> {
  const started = Date.now();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_LOCK_WAIT_MS;
  const entry = registry.get(businessId) ?? { held: false, queue: [] };
  registry.set(businessId, entry);
  if (entry.held) {
    if (opts.mode === "try") throw new LockBusyError(businessId, false);
    await new Promise<void>((resolve, reject) => {
      const waiter = { grant: () => { clearTimeout(timer); resolve(); } };
      const timer = setTimeout(() => {
        const i = entry.queue.indexOf(waiter);
        if (i >= 0) entry.queue.splice(i, 1);
        reject(new LockBusyError(businessId, true));
      }, timeoutMs);
      entry.queue.push(waiter);
    });
    // Ownership was handed over by the releasing holder (entry.held stayed true).
  } else {
    entry.held = true;
  }
  const releaseLocal = () => {
    const next = entry.queue.shift();
    if (next) next.grant();                 // hand over directly, FIFO, without releasing in between
    else { entry.held = false; registry.delete(businessId); }
  };
  let lease;
  try {
    lease = await acquireLease(getKv(), businessLockKey(businessId), {
      ttlMs: BUSINESS_LEASE_TTL_MS, fenceMinTtlMs: FENCE_MIN_TTL_MS,
      waitMs: opts.mode === "try" ? 0 : Math.max(0, timeoutMs - (Date.now() - started)),
    });
  } catch (e) { releaseLocal(); throw e; }
  if (!lease) { releaseLocal(); throw new LockBusyError(businessId, opts.mode === "wait"); }
  try {
    return await withFence(lease.fence, fn);
  } finally {
    await lease.release();
    releaseLocal();
  }
}

/** For tests and diagnostics only. */
export const isBusinessLockHeld = (businessId: string) => registry.get(businessId)?.held ?? false;
