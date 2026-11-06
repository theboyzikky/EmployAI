// Reading order for a workflow, shared by the validator, the diagram and the step list. Pure and
// client-safe. The MAIN sequence follows each step's primary outcome (next / yes / allow / approved);
// every other outcome is a BRANCH that leaves a main step and either ends or rejoins the main sequence.
// Steps nothing leads to are DISCONNECTED (only possible in an invalid workflow).
import { OUTCOME_LABELS, PRIMARY_OUTCOMES } from "./layout";
import type { Step, WorkflowDoc } from "./schema";

export type Branch = {
  /** Outcomes of the main step that lead into this branch (e.g. ["block"]). */
  outcomes: string[];
  /** Steps on the branch, in order. */
  chain: Step[];
  /** Main-sequence step the branch continues into, or null if it ends. */
  rejoins: string | null;
};

export type Disconnected = {
  step: Step;
  /** The outcome that normally leads here in the template, if known, and where it goes now. */
  expected: { from: Step; outcome: string; nowTo: Step | null } | null;
};

export type WorkflowStructure = {
  main: Step[];
  /** How each main step is entered from the previous one (e.g. ["allow", "warn"]); empty for the first. */
  enteredBy: Map<string, string[]>;
  branches: Map<string, Branch[]>;
  disconnected: Disconnected[];
};

/** Which step and outcome normally lead to an end step of each kind, in the restaurant template. */
const EXPECTED_SOURCE: Partial<Record<string, { type: Step["type"]; outcome: string }>> = {
  blocked: { type: "security_check", outcome: "block" },
  rejected: { type: "approval", outcome: "rejected" },
  no_reorder: { type: "condition", outcome: "no" },
};

const primaryNext = (s: Step | undefined) => (s ? Object.entries(s.next).find(([o]) => PRIMARY_OUTCOMES.has(o))?.[1] : undefined);

export function workflowStructure(doc: WorkflowDoc): WorkflowStructure {
  const byId = new Map(doc.steps.map(s => [s.id, s]));

  // Main sequence
  const main: Step[] = [];
  const onMain = new Set<string>();
  for (let id: string | undefined = doc.start; id && byId.has(id) && !onMain.has(id); id = primaryNext(byId.get(id))) {
    main.push(byId.get(id)!);
    onMain.add(id);
  }
  const enteredBy = new Map<string, string[]>();
  main.forEach((s, i) => {
    const prev = main[i - 1];
    enteredBy.set(s.id, prev ? Object.entries(prev.next).filter(([, to]) => to === s.id).map(([o]) => o) : []);
  });

  // Branches leave a main step through a non-primary outcome to a step that isn't the next main step.
  const branches = new Map<string, Branch[]>();
  const seen = new Set(onMain);
  main.forEach((s, i) => {
    const groups = new Map<string, string[]>();
    for (const [o, to] of Object.entries(s.next)) {
      if (PRIMARY_OUTCOMES.has(o) || to === main[i + 1]?.id) continue;
      groups.set(to, [...(groups.get(to) ?? []), o]);
    }
    const list: Branch[] = [];
    for (const [to, outcomes] of groups) {
      const chain: Step[] = [];
      let rejoins: string | null = null;
      for (let id: string | undefined = to; id && byId.has(id); id = primaryNext(byId.get(id))) {
        if (onMain.has(id)) { rejoins = id; break; }
        if (seen.has(id)) break;
        seen.add(id);
        chain.push(byId.get(id)!);
      }
      list.push({ outcomes, chain, rejoins });
    }
    if (list.length) branches.set(s.id, list);
  });

  // Disconnected: not reachable from the start along any outcome.
  const reachable = new Set<string>();
  const stack = byId.has(doc.start) ? [doc.start] : [];
  while (stack.length) {
    const id = stack.pop()!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    for (const to of Object.values(byId.get(id)?.next ?? {})) if (byId.has(to)) stack.push(to);
  }
  const disconnected: Disconnected[] = doc.steps.filter(s => !reachable.has(s.id)).map(step => {
    const want = step.type === "end" ? EXPECTED_SOURCE[step.result] : undefined;
    const from = want ? doc.steps.find(s => s.type === want.type && reachable.has(s.id)) : undefined;
    return { step, expected: from && want ? { from, outcome: want.outcome, nowTo: byId.get(from.next[want.outcome] ?? "") ?? null } : null };
  });

  return { main, enteredBy, branches, disconnected };
}

export const outcomeText = (outcomes: string[]) => outcomes.map(o => OUTCOME_LABELS[o] ?? o).join(" / ");

/** Plain-language reason a step is disconnected, naming the missing connection when it is known. */
export function explainDisconnected(d: Disconnected): string {
  const name = `“${d.step.title}”`;
  if (!d.expected) return `Nothing leads to ${name}, so it can never run.`;
  const { from, outcome, nowTo } = d.expected;
  const label = OUTCOME_LABELS[outcome] ?? outcome;
  return `Nothing leads to ${name}. It normally follows the ${label} outcome of “${from.title}”, which now goes to ${nowTo ? `“${nowTo.title}”` : "no step"}.`;
}
