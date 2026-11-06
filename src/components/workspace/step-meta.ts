import type { Icon as PhosphorIcon } from "@phosphor-icons/react/dist/lib/types";
import {
  BellIcon, FlagIcon, GitBranchIcon, LightningIcon, RobotIcon, ShieldCheckIcon, UserCheckIcon, WalletIcon,
} from "@/components/icons";
import type { Step, StepType } from "@/lib/workflows/schema";
import type { WorkspaceAgent } from "@/lib/workflows/view-types";

export const STEP_META: Record<StepType, { label: string; icon: PhosphorIcon }> = {
  trigger: { label: "Trigger", icon: LightningIcon },
  agent_task: { label: "Agent task", icon: RobotIcon },
  condition: { label: "Decision", icon: GitBranchIcon },
  security_check: { label: "Security check", icon: ShieldCheckIcon },
  approval: { label: "Your approval", icon: UserCheckIcon },
  payment: { label: "Payment request", icon: WalletIcon },
  notify: { label: "Notification", icon: BellIcon },
  end: { label: "End", icon: FlagIcon },
};

/** Who does the step, in plain words. */
export function stepActor(step: Step, agents: WorkspaceAgent[]): string {
  const name = (k: string | null) => agents.find(a => a.key === k)?.name ?? null;
  switch (step.type) {
    case "agent_task": return name(step.agent) ?? step.agent;
    case "payment": return name("finance") ?? "Finance Agent";
    case "notify": return name(step.agent) ?? "EmployAI";
    case "security_check": return "Security gate";
    case "approval": return "You";
    default: return "EmployAI";
  }
}

export function taskLabel(agents: WorkspaceAgent[], agent: string | null, task: string | null): string | null {
  if (!agent || !task) return null;
  return agents.find(a => a.key === agent)?.tasks.find(t => t.id === task)?.label ?? task;
}

/** Short line above a step title: the agent for agent work, otherwise the step type. */
export function stepKicker(step: Step, agents: WorkspaceAgent[]): string {
  if (step.type === "agent_task") return stepActor(step, agents);
  if (step.type === "notify") return `${STEP_META.notify.label} · ${step.audience === "customer" ? "customer" : "you"}`;
  return STEP_META[step.type].label;
}
