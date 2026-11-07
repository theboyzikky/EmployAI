import "server-only";
import { ServiceError } from "@/lib/discovery/service";
import { LockBusyError, withBusinessLock } from "@/lib/locks";
import { FINGERPRINT_ALG, workflowFingerprint } from "@/lib/runs/fingerprint";
import { ACTIVE_RUN_STATUSES } from "@/lib/runs/types";
import { discoveryRepository, type BusinessRecord, type WorkflowRecord } from "@/lib/discovery/store";
import { isRunnableIndustry, restaurantDemoScenario } from "./demo-data";
import { DEFAULT_PARAMS, generateRestaurantWorkflow, type TeamMember } from "./generate";
import { ParamsSchema, type Params } from "./schema";
import { validateWorkflow } from "./validate";

/*
 * M3 workflow lifecycle: draft → approved (by the owner) → superseded (by a newer approved version).
 * Nothing here executes a workflow, contacts anyone or moves money. Execution is M4.
 */

/** M4 · D20: the shared business lock, fail-fast as before (409 BUSY). */
async function withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await withBusinessLock(id, fn, { mode: "try" });
  } catch (e) {
    if (e instanceof LockBusyError) throw new ServiceError("BUSY", 409, "Another change to this business is in progress. Try again in a moment.");
    throw e;
  }
}

export async function workflowContext(business: BusinessRecord) {
  const agents = await discoveryRepository().listAgents(business.id);
  const runnable = isRunnableIndustry(business.business_type);
  const team: TeamMember[] = agents.map(a => ({
    key: a.key,
    // A paused agent (M4) is still part of the approved team; the pause is enforced when a run executes.
    status: a.status === "paused" ? "approved" as const : a.status,
    // Only the restaurant scenario is runnable in this prototype; elsewhere every agent stays Preview.
    executable: a.executable && runnable,
    tasks: a.definition.tasks.map(t => ({ id: t.id, enabled: t.enabled })),
  }));
  const teamApproved = agents.some(a => a.status === "approved" || a.status === "paused");
  return { agents, team, runnable, teamApproved };
}

function assertCanGenerate(ctx: Awaited<ReturnType<typeof workflowContext>>) {
  if (!ctx.teamApproved) throw new ServiceError("TEAM_NOT_APPROVED", 409, "Approve your AI team before workflows are built.");
  if (!ctx.runnable) throw new ServiceError("PREVIEW_ONLY", 409, "Workflows are only supported for the restaurant demo in this prototype. Your team stays in Preview.");
}

function build(ctx: Awaited<ReturnType<typeof workflowContext>>, params: Params) {
  const doc = generateRestaurantWorkflow(ctx.team, params);
  return { doc, validation: validateWorkflow(doc, { team: ctx.team, runnable: ctx.runnable }) };
}

/** Next version number. Drafts are replaced, not kept, so a replaced draft's number is reused. */
const nextVersion = (list: WorkflowRecord[]) => list.filter(w => w.status !== "draft").reduce((m, w) => Math.max(m, w.version), 0) + 1;

/** Generate (or regenerate) the draft. Any existing draft is replaced; approved versions are untouched. */
export async function generateWorkflow(business: BusinessRecord): Promise<void> {
  const repo = discoveryRepository();
  await withLock(business.id, async () => {
    const ctx = await workflowContext(business);
    assertCanGenerate(ctx);
    const fresh = (await repo.getBusiness(business.id))!;
    if (!fresh.scenario_data) await repo.updateBusiness(business.id, { scenario_data: restaurantDemoScenario() });
    const list = await repo.listWorkflows(business.id);
    for (const d of list.filter(w => w.status === "draft")) await repo.deleteWorkflow(business.id, d.id);
    const base = list.filter(w => w.status === "approved").at(-1);
    const { doc, validation } = build(ctx, base ? base.steps.params : DEFAULT_PARAMS);
    await repo.createWorkflow({ business_id: business.id, name: doc.name, version: nextVersion(list), steps: doc, validation, status: "draft", approved_at: null });
  });
}

/** Edit settings. On a draft, the draft is rebuilt; on an approved version, a NEW draft version is created. */
export async function updateWorkflowSettings(business: BusinessRecord, workflowId: string, patch: Partial<Params>): Promise<void> {
  const repo = discoveryRepository();
  await withLock(business.id, async () => {
    const ctx = await workflowContext(business);
    assertCanGenerate(ctx);
    const list = await repo.listWorkflows(business.id);
    const wf = list.find(w => w.id === workflowId);
    if (!wf) throw new ServiceError("NOT_FOUND", 404, "That workflow doesn't exist.");
    if (wf.status === "superseded") throw new ServiceError("STATE_CONFLICT", 409, "This version has been replaced. Edit the current version instead.");
    const merged = ParamsSchema.safeParse({ ...wf.steps.params, ...patch });
    if (!merged.success) throw new ServiceError("VALIDATION_FAILED", 400, merged.error.issues[0]?.message ?? "Invalid settings.");
    if (merged.data.approval_threshold_ngn > merged.data.max_payment_ngn) {
      throw new ServiceError("VALIDATION_FAILED", 400, "The approval threshold can't be higher than the maximum payment.");
    }
    const { doc, validation } = build(ctx, merged.data);
    if (wf.status === "draft") {
      await repo.updateWorkflow(business.id, wf.id, { steps: doc, validation });
    } else {
      // Approved versions are locked: changes become a new draft version.
      for (const d of list.filter(w => w.status === "draft")) await repo.deleteWorkflow(business.id, d.id);
      await repo.createWorkflow({ business_id: business.id, name: doc.name, version: nextVersion(list), steps: doc, validation, status: "draft", approved_at: null });
    }
  });
}

/** The owner approves a draft. It is re-validated first, against the CURRENT team; invalid → refused. */
export async function approveWorkflow(business: BusinessRecord, workflowId: string): Promise<void> {
  const repo = discoveryRepository();
  await withLock(business.id, async () => {
    const ctx = await workflowContext(business);
    const list = await repo.listWorkflows(business.id);
    const wf = list.find(w => w.id === workflowId);
    if (!wf) throw new ServiceError("NOT_FOUND", 404, "That workflow doesn't exist.");
    if (wf.status !== "draft") throw new ServiceError("STATE_CONFLICT", 409, "Only a draft can be approved.");
    const validation = validateWorkflow(wf.steps, { team: ctx.team, runnable: ctx.runnable });
    if (!validation.valid) {
      await repo.updateWorkflow(business.id, wf.id, { validation });
      throw new ServiceError("WORKFLOW_INVALID", 409, "This workflow has failed checks, so it can't be approved.");
    }
    // M4 · D18: never change which version is approved while a test run is using one.
    const active = await repo.readState(s => ((s.runs ?? {})[business.id] ?? []).some(r => ACTIVE_RUN_STATUSES.includes(r.status)));
    if (active) throw new ServiceError("RUN_IN_PROGRESS", 409, "A test run is in progress. Wait for it to finish, or stop it, before approving another version.");
    const now = new Date().toISOString();
    for (const old of list.filter(w => w.status === "approved")) await repo.updateWorkflow(business.id, old.id, { status: "superseded" });
    // M4 · D18: the approval fingerprint binds this approval to the exact version being approved.
    await repo.updateWorkflow(business.id, wf.id, {
      status: "approved", approved_at: now, validation,
      approval_fingerprint: workflowFingerprint({ id: wf.id, version: wf.version, steps: wf.steps }), fingerprint_alg: FINGERPRINT_ALG,
    });
  });
}

export async function discardDraft(business: BusinessRecord, workflowId: string): Promise<void> {
  const repo = discoveryRepository();
  await withLock(business.id, async () => {
    const wf = (await repo.listWorkflows(business.id)).find(w => w.id === workflowId);
    if (!wf) throw new ServiceError("NOT_FOUND", 404, "That workflow doesn't exist.");
    if (wf.status !== "draft") throw new ServiceError("STATE_CONFLICT", 409, "Only a draft can be discarded. Approved versions stay on record.");
    await repo.deleteWorkflow(business.id, wf.id);
  });
}
