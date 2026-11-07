// M4 · Who can run (plan §4). Every check is made by the server at start, on one consistent read of the
// store, in the order below; the first failure is returned. Nothing here writes anything.
import type { BusinessRecord, WorkflowRecord } from "@/lib/discovery/store";
import type { AgentRecord } from "@/lib/discovery/store";
import type { TeamMember } from "@/lib/workflows/generate";
import { isRunnableIndustry } from "@/lib/workflows/demo-data";
import { validateWorkflow } from "@/lib/workflows/validate";
import { workflowFingerprint } from "./fingerprint";
import { ACTIVE_RUN_STATUSES, type RunRecord } from "./types";

export type Refusal = { code: string; status: 409; message: string };
export type Eligible = { ok: true; workflow: WorkflowRecord; fingerprint: string; team: TeamMember[] };

/** The approved team as the validator and runner see it: a paused agent is still a team member. */
export function teamOf(agents: AgentRecord[], runnable: boolean): TeamMember[] {
  return agents.map(a => ({
    key: a.key,
    status: a.status === "paused" ? "approved" : a.status,
    executable: a.executable && runnable,
    tasks: a.definition.tasks.map(t => ({ id: t.id, enabled: t.enabled })),
  }));
}

const refuse = (code: string, message: string): Refusal => ({ code, status: 409, message });

export function checkRunEligibility(input: {
  business: BusinessRecord;
  agents: AgentRecord[];
  workflows: WorkflowRecord[];
  runs: RunRecord[];
  workflowId: string;
}): Eligible | Refusal {
  const { business, agents, workflows, runs, workflowId } = input;
  const runnable = isRunnableIndustry(business.business_type);
  if (!runnable) return refuse("PREVIEW_ONLY", "Test runs are only available for the restaurant demo. Other businesses stay in Preview.");

  // D16: an M3.5 discovery with a confirmed summary.
  const cf = business.profile.case_file;
  if (!cf || cf.origin !== "native" || !business.profile_confirmed_at || business.profile.stage !== "proposal") {
    return refuse("DISCOVERY_INCOMPLETE", "This discovery was captured before the consultant could check causes, or it isn't confirmed yet. Start a new discovery to use test runs.");
  }
  if (!agents.some(a => a.status === "approved" || a.status === "paused")) return refuse("TEAM_NOT_APPROVED", "Approve your AI team before running a test.");
  if (business.kill_switch) return refuse("KILL_SWITCH_ACTIVE", "The kill switch is on. Switch it off to start a test run.");

  const wf = workflows.find(w => w.id === workflowId);
  const current = workflows.filter(w => w.status === "approved").sort((a, b) => b.version - a.version)[0];
  if (!wf || wf.status !== "approved" || !current || current.id !== wf.id) {
    return refuse("WORKFLOW_NOT_APPROVED", "Only the current approved version of a workflow can run. Drafts and replaced versions can't.");
  }
  // D18 / C6: legacy approvals (before M4) have no fingerprint. They are kept as they are and must be
  // re-approved through the documented process (Rebuild as new draft → Approve) before they can run.
  if (!wf.approval_fingerprint) {
    return refuse("REAPPROVAL_REQUIRED", "This version was approved before test runs existed. Rebuild it as a new draft and approve it to run it.");
  }
  const fingerprint = workflowFingerprint(wf);
  if (fingerprint !== wf.approval_fingerprint) {
    return refuse("APPROVAL_FINGERPRINT_MISMATCH", "This workflow has changed since it was approved, so it can't run. Rebuild and approve it again.");
  }
  const team = teamOf(agents, runnable);
  const validation = validateWorkflow(wf.steps, { team, runnable });
  if (!validation.valid) return refuse("WORKFLOW_INVALID", "This workflow no longer passes its checks against your current team, so it can't run.");
  if (runs.some(r => ACTIVE_RUN_STATUSES.includes(r.status))) return refuse("RUN_IN_PROGRESS", "A test run is already in progress for this business.");
  return { ok: true, workflow: wf, fingerprint, team };
}
