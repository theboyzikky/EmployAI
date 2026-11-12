import "server-only";
// advance_run: keep a workflow run moving in the background, through the SAME runner the UI uses
// (advanceRun → leases, the business lock, the security gate, owner approvals, the fenced NEAR signer).
// Nothing here can skip a step: it just calls advanceRun until the run stops for a reason only the owner
// or the chain can resolve (approval, pause, a payment outcome still settling) or ends.
//   - waiting for the owner (approval / pause): the task completes; the owner's decision enqueues a new one
//   - a payment outcome still settling: look again in 20 s (reconciliation is the payment executor's job)
//   - the business lock is busy (the UI is driving it right now): look again shortly
//   - the testnet chain isn't available in this process: retry later (bounded; then visible to the owner)
import { LockBusyError } from "@/lib/locks";
import { ServiceError } from "@/lib/discovery/service";
import { runRead } from "@/lib/runs/repo";
import { advanceRun } from "@/lib/runs/runner";
import type { TaskRecord } from "./records";
import { registerTaskHandler, type TaskResult } from "./worker";

const soon = (ms: number) => new Date(Date.now() + ms).toISOString();

registerTaskHandler("advance_run", async (task: TaskRecord): Promise<TaskResult> => {
  const b = task.business_id, runId = task.ref;
  const deadline = Date.now() + 40_000;
  for (let i = 0; i < 25 && Date.now() < deadline; i++) {
    const run = await runRead(b, tx => tx.run(b, runId));
    if (!run) return { kind: "cancelled", reason: "The run no longer exists." };
    if (run.status !== "running") return { kind: "done" };          // ended, or waiting for the owner
    let r;
    try { r = await advanceRun(b, runId); }
    catch (e) {
      if (e instanceof LockBusyError) return { kind: "later", atIso: soon(5_000) };
      if (e instanceof ServiceError) return { kind: "failed", error: `${e.code}: ${e.message}` };
      throw e;
    }
    if (r.settling) return { kind: "later", atIso: soon(20_000) };
    if (!r.more) {
      const now = await runRead(b, tx => tx.run(b, runId));
      return now?.status === "running" ? { kind: "later", atIso: soon(10_000) } : { kind: "done" };
    }
  }
  return { kind: "later", atIso: soon(1_000) };                    // budget used: continue on the next wake-up
});

export const RUN_HANDLERS_REGISTERED = true;
