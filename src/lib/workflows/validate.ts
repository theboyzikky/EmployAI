// Workflow validator. Every rule runs on every save and again at approval time, against the CURRENT
// approved team. Payment safety is checked on EVERY execution path (all outcome combinations), not just
// the "happy" path. A workflow with any failed check can't be approved.
import { AGENT_TEMPLATES, type AgentKey } from "@/lib/catalogue/catalogue";
import type { TeamMember } from "./generate";
import { explainDisconnected, workflowStructure } from "./structure";
import { MAX_STEPS, OUTCOMES, ParamsSchema, WorkflowDocSchema, type Step, type ValidationCheck, type ValidationResult, type WorkflowDoc } from "./schema";

type Ctx = { team: TeamMember[]; runnable: boolean };

export function validateWorkflow(input: unknown, ctx: Ctx, now = new Date().toISOString()): ValidationResult {
  const checks: ValidationCheck[] = [];
  const check = (code: string, label: string, failures: string[]) =>
    checks.push({ code, label, passed: failures.length === 0, detail: failures.length ? failures.slice(0, 4).join(" ") : "OK" });

  // 1 · Shape: only the 8 known step types and fields (anything else is rejected outright).
  const parsed = WorkflowDocSchema.safeParse(input);
  check("SCHEMA", "Only known step types and fields", parsed.success ? [] : parsed.error.issues.slice(0, 3).map(i => `${i.path.join(".")}: ${i.message}.`));
  check("RUNNABLE_SCENARIO", "Business has a supported, runnable scenario (restaurant demo)", ctx.runnable ? [] : ["Only the restaurant demo has runnable workflows in this prototype."]);
  if (!parsed.success) return { valid: false, checks, validated_at: now };
  const wf: WorkflowDoc = parsed.data;
  const byId = new Map(wf.steps.map(s => [s.id, s]));

  // 2 · Structure
  check("STEP_LIMIT", `At most ${MAX_STEPS} steps`, wf.steps.length <= MAX_STEPS ? [] : [`${wf.steps.length} steps.`]);
  check("UNIQUE_IDS", "Step IDs are unique", byId.size === wf.steps.length ? [] : ["Duplicate step IDs."]);
  const start = byId.get(wf.start);
  const triggers = wf.steps.filter(s => s.type === "trigger");
  check("SINGLE_TRIGGER", "Exactly one trigger, and the workflow starts there", start?.type === "trigger" && triggers.length === 1 ? [] : ["The workflow must start at its only trigger."]);
  const edgeProblems: string[] = [];
  for (const s of wf.steps) {
    const want = OUTCOMES[s.type];
    const got = Object.keys(s.next);
    for (const o of want) if (!s.next[o]) edgeProblems.push(`${s.id} has no "${o}" route.`);
    for (const o of got) if (!want.includes(o)) edgeProblems.push(`${s.id} has an unknown route "${o}".`);
    for (const t of Object.values(s.next)) if (!byId.has(t)) edgeProblems.push(`${s.id} points to missing step "${t}".`);
  }
  check("ROUTES_COMPLETE", "Every step routes each of its outcomes to an existing step", edgeProblems);
  if (!start || edgeProblems.length) return finish();

  const cycle = findCycle(wf.steps, byId);
  check("NO_CYCLES", "No loops", cycle ? [`Loop through ${cycle}.`] : []);
  if (cycle) return finish();

  const paths = allPaths(wf.start, byId);
  const reachable = new Set(paths.flatMap(p => p.map(e => e.step)));
  const unreachable = workflowStructure(wf).disconnected.filter(d => !reachable.has(d.step.id));
  check("ALL_REACHABLE", "Every step can be reached from the trigger", unreachable.map(explainDisconnected));
  check("ALL_PATHS_END", "Every path finishes at an end step", paths.filter(p => byId.get(p.at(-1)!.step)!.type !== "end").map(p => `Path stops at ${p.at(-1)!.step}.`));

  // 3 · Agents, tasks and tools come only from the approved team and the catalogue
  const team = new Map(ctx.team.map(a => [a.key, a]));
  const agentProblems: string[] = [], taskProblems: string[] = [], toolProblems: string[] = [];
  for (const s of wf.steps) {
    const agent = "agent" in s ? (s.agent as AgentKey | null) : null;
    if (!agent) continue;
    const m = team.get(agent);
    if (!m || m.status !== "approved") agentProblems.push(`${s.id}: ${AGENT_TEMPLATES[agent].name} isn't on the approved team.`);
    else if (!m.executable) agentProblems.push(`${s.id}: ${AGENT_TEMPLATES[agent].name} is preview-only.`);
    const task = "task" in s ? s.task : null;
    if (m && task && !m.tasks.some(t => t.id === task && t.enabled)) taskProblems.push(`${s.id}: task "${task}" is switched off or unknown.`);
    if (s.type === "agent_task") {
      const allowed = AGENT_TEMPLATES[s.agent].allowed_tools;
      for (const t of s.tools) if (!allowed.includes(t)) toolProblems.push(`${s.id}: tool "${t}" isn't allowed for ${AGENT_TEMPLATES[s.agent].name}.`);
      if (!task) taskProblems.push(`${s.id}: no task.`);
    }
  }
  check("AGENTS_APPROVED", "Every step's agent is approved and runnable", agentProblems);
  check("TASKS_ENABLED", "Every step uses a task you kept switched on", taskProblems);
  check("TOOLS_ALLOWED", "Steps only use tools from the agent's catalogue entry", toolProblems);

  // 4 · Payments: who is paid vs how it's requested
  const payments = wf.steps.filter((s): s is Extract<Step, { type: "payment" }> => s.type === "payment");
  const payShape: string[] = [];
  for (const p of payments) {
    const src = byId.get(p.beneficiary.from_step);
    if (!src || src.type !== "agent_task" || src.agent !== "procurement") payShape.push(`${p.id}: the beneficiary must come from the Procurement Agent's recommendation.`);
    if (!AGENT_TEMPLATES.finance.allowed_tools.includes("request_payment")) payShape.push(`${p.id}: the Finance Agent can't request payments.`);
    if (p.mode !== "test_run") payShape.push(`${p.id}: payments are test runs until M5.`);
  }
  check("PAYMENT_BENEFICIARY_AND_CHANNEL", "Payments go to an approved supplier, requested by the Finance Agent through the treasury contract", payShape);

  // 5 · Every path to a payment: supplier chosen → security check (allow/warn) → approval (approved) → payment
  const pathProblems: string[] = [];
  for (const path of paths) {
    path.forEach((edge, i) => {
      const step = byId.get(edge.step)!;
      if (step.type !== "payment") return;
      const before = path.slice(0, i);
      const route = before.map(e => `${e.step}${e.outcome ? `[${e.outcome}]` : ""}`).join(" → ");
      const secIdx = findLast(before, e => { const s = byId.get(e.step)!; return s.type === "security_check" && s.subject === step.id; });
      if (secIdx < 0) { pathProblems.push(`Path ${route} reaches ${step.id} without its security check.`); return; }
      if (!["allow", "warn"].includes(before[secIdx].outcome!)) pathProblems.push(`Path ${route} reaches ${step.id} after a BLOCK.`);
      const apprIdx = findLast(before, e => { const s = byId.get(e.step)!; return s.type === "approval" && s.subject === step.id; });
      if (apprIdx < secIdx) pathProblems.push(`Path ${route} reaches ${step.id} without the approval check after its security check.`);
      else if (before[apprIdx].outcome !== "approved") pathProblems.push(`Path ${route} reaches ${step.id} after you declined.`);
      if (!before.some(e => e.step === step.beneficiary.from_step)) pathProblems.push(`Path ${route} reaches ${step.id} before a supplier is chosen.`);
    });
  }
  check("PAYMENT_PATHS_GUARDED", "On every possible path, a payment request comes after its security check and your approval check", pathProblems);

  // 6 · Settings
  const pr = ParamsSchema.safeParse(wf.params);
  const paramProblems = pr.success ? [] : pr.error.issues.map(i => `${i.path.join(".")}: ${i.message}.`);
  if (pr.success && pr.data.approval_threshold_ngn > pr.data.max_payment_ngn) paramProblems.push("The approval threshold can't be higher than the maximum payment.");
  check("SETTINGS_VALID", "Settings are within their allowed ranges", paramProblems);

  return finish();

  function finish(): ValidationResult {
    return { valid: checks.every(c => c.passed), checks, validated_at: now };
  }
}

type Edge = { step: string; outcome: string | null };

/** All paths from `start`, following every outcome of every step. The graph is small and acyclic. */
export function allPaths(start: string, byId: Map<string, Step>, limit = 500): Edge[][] {
  const out: Edge[][] = [];
  const walk = (id: string, acc: Edge[]) => {
    if (out.length >= limit) return;
    const s = byId.get(id)!;
    const outs = Object.entries(s.next);
    if (outs.length === 0) { out.push([...acc, { step: id, outcome: null }]); return; }
    for (const [o, to] of outs) walk(to, [...acc, { step: id, outcome: o }]);
  };
  walk(start, []);
  return out;
}

function findCycle(steps: Step[], byId: Map<string, Step>): string | null {
  const state = new Map<string, 1 | 2>();
  let found: string | null = null;
  const visit = (id: string, trail: string[]) => {
    if (found) return;
    if (state.get(id) === 1) { found = [...trail.slice(trail.indexOf(id)), id].join(" → "); return; }
    if (state.get(id) === 2) return;
    state.set(id, 1);
    for (const t of Object.values(byId.get(id)?.next ?? {})) if (byId.has(t)) visit(t, [...trail, id]);
    state.set(id, 2);
  };
  for (const s of steps) visit(s.id, []);
  return found;
}

function findLast<T>(a: T[], f: (x: T) => boolean): number {
  for (let i = a.length - 1; i >= 0; i--) if (f(a[i])) return i;
  return -1;
}
