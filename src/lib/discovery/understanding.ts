// M3.5: the consultant's reasoning as the owner sees it ("What I understand"). Built from the case
// file; a pre-M3.5 profile is shown through its (in-memory) migration and flagged as such.
import { AGENT_TEMPLATES, AGENT_FOR_CAPABILITY } from "@/lib/catalogue/catalogue";
import { isRunnableIndustry } from "@/lib/workflows/demo-data";
import { MAX_QUESTIONS, isPreM35Discovery, migrateToCaseFile } from "./casefile";
import { causeOf, playbookByKey } from "./playbooks";
import { FIELD_LABELS, type ProfileDoc, type ProfileFieldKey } from "./profile";
import type { ViewCauseStatus, ViewUnderstanding } from "./view-types";

const SLOT_LABELS: Record<string, string> = { ...FIELD_LABELS, team_size: "Team size" };
const GAP_LABELS: Record<string, string> = { channel: "Which platform your customers use", topics: "What your customers ask about", products: "What you sell", suppliers: "Your suppliers" };

export function buildUnderstanding(p: ProfileDoc): ViewUnderstanding {
  const preM35 = isPreM35Discovery(p);
  const cf = (p.case_file ?? migrateToCaseFile(p).case_file)!;
  const asked = new Set(cf.agenda.filter(a => a.asked > 0).map(a => a.key));
  const industry = cf.facts.industry?.value ?? null;

  const problems = cf.problems.map(pr => {
    const pb = playbookByKey(pr.playbook);
    const sym = cf.claims.find(c => c.id === pr.symptom_claim);
    const own = cf.claims.find(c => c.id === pr.cause_claim);
    const causes = pb ? pr.hypotheses
      .filter(h => h.status !== "open" || h.owner_view || asked.has(`hyp:${pr.id}:${h.key}`))
      .map(h => ({ label: causeOf(pb, h.key)!.label, status: (h.status === "open" ? "checking" : h.status) as ViewCauseStatus, ownerView: h.owner_view })) : [];
    return {
      id: pr.id, symptom: sym?.text ?? "", ownerView: own?.text ?? null, ownerViewStatus: own?.status ?? null,
      recognisedAs: pb?.title ?? null, resolution: pr.resolution, causes, uncertainty: pr.uncertainty, fromGoal: !!pr.from_goal,
    };
  });

  const contradictions = cf.contradictions.map(c => ({ label: SLOT_LABELS[c.slot] ?? c.slot, a: c.a.value, b: c.b.value, status: c.status, kind: c.kind, resolution: c.resolution }));

  const item = cf.pending ? cf.agenda.find(a => a.key === cf.pending && a.status === "open") : null;
  let asking: ViewUnderstanding["asking"] = null;
  if (item) {
    const pr = item.problem_id ? cf.problems.find(x => x.id === item.problem_id) : null;
    const pb = playbookByKey(pr?.playbook);
    const label = item.kind === "fact" ? SLOT_LABELS[item.target as ProfileFieldKey] ?? item.target
      : item.kind === "hypothesis" ? `Possible cause: ${pb ? causeOf(pb, item.target)?.label : item.target}`
      : item.kind === "confirm_cause" ? `Confirming the cause: ${pb ? causeOf(pb, item.target)?.label : item.target}`
      : item.kind === "contradiction" ? `Which is right: ${SLOT_LABELS[item.target] ?? item.target}`
      : item.kind === "gap" ? `A detail that changes the solution: ${(GAP_LABELS[item.target.split("|")[0].split(":")[1]] ?? "a detail").toLowerCase()}`
      : item.kind === "opening" ? (pr?.from_goal ? "What's behind your goal" : "Where the time goes")
      : item.kind === "clarify" ? "Something I didn't follow"
      : item.kind === "other_problems" ? "Other problems" : "Describing the problem";
    asking = { kind: item.kind, target: item.target, label };
  }

  const runnable = isRunnableIndustry(industry);
  const solutions = (cf.solutions ?? []).filter(s => s.status === "considering").map(s => ({
    agent: s.agent, for: s.for,
    preview: !runnable || !AGENT_TEMPLATES[AGENT_FOR_CAPABILITY[s.capability]].scenario,
  }));
  return {
    preM35, problems, contradictions, asking, questionsAsked: cf.questions_asked, maxQuestions: MAX_QUESTIONS,
    owner: { name: cf.owner?.name?.value ?? null, business: cf.owner?.business?.phrase ?? null },
    goals: cf.claims.filter(c => c.kind === "goal" && c.status !== "questioned").map(c => c.text),
    needs: (cf.needs ?? []).filter(n => n.status !== "rejected").map(n => ({ label: n.label, status: n.status as "stated" | "implied" })),
    solutions,
    inferences: (cf.inferences ?? []).filter(i => i.status !== "rejected").map(i => ({ kind: i.kind, statement: i.statement, reason: i.reason, status: i.status, settledBy: i.settled_by ?? null,
      ownerWords: i.key === "typical_topics" ? cf.gap_answers?.["customer_messaging:topics"]?.text ?? null : null })),
    unrecognised: (cf.unrecognised ?? []).map(u => ({ text: u.text, clarification: u.clarification })),
  };
}
