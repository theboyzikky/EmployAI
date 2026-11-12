import "server-only";
// The automation worker (layer C). Processes one business's due tasks within a time budget:
//   claim (lease, compare-and-set) → run the handler for its kind → settle (done / later / retry / dead).
// Every handler is idempotent and re-checks state, because a task can run again after a worker dies
// (expired lease) or a settle fails. Any store failure stops the worker at once (fail closed); the task's
// lease then expires and the next wake-up picks it up. Handlers are registered by kind, so the engine
// knows nothing about specific connectors, employees or workflows.
import { randomUUID } from "node:crypto";
import { discoveryRepository } from "@/lib/discovery/store";
import { KvUnavailableError } from "@/lib/kv/types";
import { audit } from "@/lib/integrations/connections";
import { FenceLostError } from "@/lib/store/fence-context";
import type { TaskKind, TaskRecord } from "./records";
import { claimDueTaskIn, nextDueIn, settleTaskIn } from "./tasks";

export type TaskResult = { kind: "done" } | { kind: "later"; atIso: string } | { kind: "failed"; error: string } | { kind: "cancelled"; reason: string };
export type TaskHandler = (task: TaskRecord) => Promise<TaskResult>;

const HANDLERS = Symbol.for("employai.taskHandlers");
const g = globalThis as unknown as { [HANDLERS]?: Map<TaskKind, TaskHandler> };
const handlers: Map<TaskKind, TaskHandler> = (g[HANDLERS] ??= new Map());
export function registerTaskHandler(kind: TaskKind, h: TaskHandler) { handlers.set(kind, h); }

const INSTANCE = randomUUID();
const isInfra = (e: unknown) => e instanceof KvUnavailableError || e instanceof FenceLostError;

export type WorkerReport = { processed: number; failed: number; nextDueAt: string | null };

export async function runDueTasks(businessId: string, o: { deadlineMs?: number; maxTasks?: number } = {}): Promise<WorkerReport> {
  const repo = discoveryRepository();
  const deadline = Date.now() + (o.deadlineMs ?? 25_000);
  const report: WorkerReport = { processed: 0, failed: 0, nextDueAt: null };
  for (let i = 0; i < (o.maxTasks ?? 10) && Date.now() < deadline; i++) {
    const owner = `${INSTANCE}:${randomUUID()}`;
    const task = await repo.transact(businessId, s => (s.businesses[businessId] ? claimDueTaskIn(s, businessId, owner) : null));   // store errors propagate
    if (!task) break;
    let result: TaskResult;
    const h = handlers.get(task.kind);
    if (!h) result = { kind: "failed", error: `No handler for ${task.kind} on this server.` };
    else {
      try { result = await h(task); }
      catch (e) {
        if (isInfra(e)) throw e;                   // stop now; the lease expires and a later wake-up retries
        result = { kind: "failed", error: e instanceof Error ? e.message.slice(0, 200) : "handler error" };
      }
    }
    const settled = await repo.transact(businessId, s => {
      const t = settleTaskIn(s, businessId, task.id, owner, result);
      if (t?.status === "dead") audit(s, businessId, "system", "task.dead", `task:${t.id}`, "dead", t.ref, { kind: t.kind, attempts: t.attempts, error: t.last_error });
      return t;
    });
    report.processed++;
    if (settled && (settled.status === "queued" && result.kind === "failed")) report.failed++;
  }
  report.nextDueAt = await repo.readState(businessId, s => nextDueIn(s, businessId));
  return report;
}
