// Fences that every store write in the current async context must pass. withBusinessLock (and the
// payment signer) run their work inside withFence, so a holder whose lock expired or was taken over
// can't write anything more: its commits fail with FenceLostError instead of overwriting newer work.
import { AsyncLocalStorage } from "node:async_hooks";
import type { Fence } from "@/lib/kv/types";

const KEY = Symbol.for("employai.fenceContext");
const g = globalThis as unknown as { [KEY]?: AsyncLocalStorage<Fence[]> };
const als: AsyncLocalStorage<Fence[]> = (g[KEY] ??= new AsyncLocalStorage<Fence[]>());

export function withFence<T>(fence: Fence, fn: () => Promise<T>): Promise<T> {
  return als.run([...(als.getStore() ?? []), fence], fn);
}

export const activeFences = (): Fence[] => als.getStore() ?? [];

/** A lock this work depended on expired or was taken over: nothing was written. */
export class FenceLostError extends Error {
  readonly code = "FENCE_LOST";
  constructor() { super("FENCE_LOST: the lock protecting this work was lost; nothing was written."); this.name = "FenceLostError"; }
}
