// A lease on a shared lock: a unique token, a TTL, automatic renewal while the work runs, and a fence.
// Writes made under the fence commit only while this lease still holds the lock (src/lib/kv: the same
// atomic step checks the token and the time left), so a holder that stalled past its TTL, or lost the
// lock to another instance, can never write again — it gets FenceLostError instead.
import { randomUUID } from "node:crypto";
import type { Fence, Kv } from "@/lib/kv/types";

export type Lease = {
  readonly key: string;
  readonly token: string;
  readonly fence: Fence;
  /** True once a renewal failed (the lock may already belong to someone else). */
  lost(): boolean;
  release(): Promise<void>;
};

export async function acquireLease(kv: Kv, key: string, o: { ttlMs: number; waitMs: number; fenceMinTtlMs: number; renewEveryMs?: number }): Promise<Lease | null> {
  const token = randomUUID();
  const deadline = Date.now() + o.waitMs;
  for (let i = 0; ; i++) {
    if (await kv.lockAcquire(key, token, o.ttlMs)) break;   // KvUnavailableError propagates: fail closed
    if (Date.now() >= deadline) return null;
    await new Promise(r => setTimeout(r, Math.min(250, 20 * 2 ** Math.min(i, 4)) * (0.5 + Math.random())));
  }
  let lost = false, released = false;
  const timer = setInterval(() => {
    kv.lockRenew(key, token, o.ttlMs).then(ok => { if (!ok) { lost = true; clearInterval(timer); } }, () => { lost = true; clearInterval(timer); });
  }, o.renewEveryMs ?? Math.floor(o.ttlMs / 3));
  (timer as { unref?: () => void }).unref?.();
  return {
    key, token, fence: { key, token, minTtlMs: o.fenceMinTtlMs },
    lost: () => lost,
    async release() {
      if (released) return;
      released = true;
      clearInterval(timer);
      await kv.lockRelease(key, token).catch(() => undefined);   // if this fails, the TTL frees it
    },
  };
}
