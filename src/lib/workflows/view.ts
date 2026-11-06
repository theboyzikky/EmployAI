import "server-only";
import { discoveryRepository, type BusinessRecord } from "@/lib/discovery/store";
import { PARAM_LIMITS } from "./schema";
import { workflowContext } from "./service";
import type { WorkspaceView } from "./view-types";

export type { WorkspaceView } from "./view-types";

/** The owner's workspace view. Demo data is returned separately from any business information. */
export async function buildWorkspaceView(b: BusinessRecord): Promise<WorkspaceView> {
  const repo = discoveryRepository();
  const business = (await repo.getBusiness(b.id))!;
  const ctx = await workflowContext(business);
  const workflows = (await repo.listWorkflows(b.id)).slice().sort((x, y) => y.version - x.version);
  return {
    businessId: business.id,
    businessName: business.name,
    industry: business.business_type,
    runnable: ctx.runnable,
    teamApproved: ctx.teamApproved,
    teamApprovedAt: ctx.agents.find(a => a.approved_at)?.approved_at ?? null,
    agents: ctx.agents.map(a => ({
      key: a.key, name: a.name, role: a.definition.role, purpose: a.definition.purpose,
      status: a.status, runnable: a.executable && ctx.runnable,
      tasks: a.definition.tasks, tools: a.definition.allowed_tools,
      financialPermissions: a.definition.financial_permissions, prohibited: a.definition.prohibited_actions,
    })),
    demoData: ctx.runnable ? business.scenario_data ?? null : null,
    workflows: workflows.map(w => ({ id: w.id, version: w.version, status: w.status, approvedAt: w.approved_at, createdAt: w.created_at, doc: w.steps, validation: w.validation })),
    paramLimits: PARAM_LIMITS,
  };
}
