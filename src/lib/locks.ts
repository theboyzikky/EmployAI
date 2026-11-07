// M4 · D20: ONE shared business lock for discovery, workflows and runs.
//
// SINGLE-PROCESS ONLY. The registry lives on `globalThis` so every route module in this server process
// shares it, but it gives no protection across processes or server instances (like the local dev store,
// see FileDevStore). The Supabase version keeps the same contract with row-level compare-and-set.
//
// Two ways to take it:
//  - "try":  fail fast if held (discovery turns and workflow edits keep their existing 409 behaviour);
//  - "wait": FIFO queue with a bounded wait (run operations: advance, start, approval decisions,
//            finalising control requests).
// Control requests (kill switch, pause, stop) never need this lock to be recorded: they persist through
// the store's own serialised write queue (M4 plan §5.6). This lock is never bypassed or weakened.

type Entry = { held: boolean; queue: Array<{ grant: () => void }> };

const REGISTRY = Symbol.for("employai.businessLocks");
const g = globalThis as unknown as { [REGISTRY]?: Map<string, Entry> };
const registry: Map<string, Entry> = (g[REGISTRY] ??= new Map());

/** The lock is held and the caller chose not to wait, or the bounded wait ran out. */
export class LockBusyError extends Error {
  constructor(readonly businessId: string, readonly waited: boolean) { super("BUSINESS_LOCK_BUSY"); }
}

export const DEFAULT_LOCK_WAIT_MS = 5_000;

export async function withBusinessLock<T>(businessId: string, fn: () => Promise<T>, opts: { mode: "try" | "wait"; timeoutMs?: number }): Promise<T> {
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
      }, opts.timeoutMs ?? DEFAULT_LOCK_WAIT_MS);
      entry.queue.push(waiter);
    });
    // Ownership was handed over by the releasing holder (entry.held stayed true).
  } else {
    entry.held = true;
  }
  try {
    return await fn();
  } finally {
    const next = entry.queue.shift();
    if (next) next.grant();                 // hand over directly, FIFO, without releasing in between
    else { entry.held = false; registry.delete(businessId); }
  }
}

/** For tests and diagnostics only. */
export const isBusinessLockHeld = (businessId: string) => registry.get(businessId)?.held ?? false;
