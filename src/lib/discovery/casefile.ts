// M3.5 · Discovery intelligence. The consultant's CASE FILE: what the business is (facts), what the
// owner believes or reports (claims), the problems being investigated with their possible causes,
// the question agenda and any contradictions. It is the source of truth for discovery; the ten M2
// profile fields are DERIVED from it (fieldsView) so every downstream consumer keeps working.
//
// Rules enforced by code, not by any model:
// - a possible cause becomes "confirmed" only from the owner's own words (reasoning.ts);
// - a conflicting value never silently overwrites a fact: it opens a contradiction (or is recorded
//   as an explicit correction);
// - migration only ADDS a case file; it never upgrades an assumption to a confirmed fact.
import { z } from "zod";
import type { CapabilityKey } from "@/lib/catalogue/catalogue";
import { GAPS, type GapDef } from "./needs";
import { PROFILE_FIELDS, ProfileFieldKeySchema, emptyField, isKnown, readiness, type ProfileDoc, type ProfileField, type ProfileFieldKey } from "./profile";

export const MAX_PROBES_PER_PROBLEM = 3;
export const MAX_QUESTIONS = 12;

/** Typed fact slots: the ten profile fields plus a numeric team size (used to detect contradictions). */
export type FactSlot = ProfileFieldKey | "team_size";

export type Fact = ProfileField & {
  /** Earlier values replaced by an explicit owner correction ("Actually…"), newest last. */
  history?: Array<{ value: string; sources: string[]; replaced_at: string }>;
  contradicted?: boolean;
};

export type ClaimKind = "symptom" | "cause" | "goal" | "constraint";
export type Claim = {
  id: string;
  kind: ClaimKind;
  text: string;
  /** stated = the owner's view, not verified · confirmed = owner confirmed when asked · questioned = owner doubted it. */
  status: "stated" | "confirmed" | "questioned";
  sources: string[];
  problem_id: string | null;
};

export type HypothesisStatus = "open" | "supported" | "ruled_out" | "confirmed";
export type Hypothesis = {
  key: string;                // playbook cause key
  status: HypothesisStatus;
  evidence: string[];         // owner message IDs that support or rule it out
  /** True when this is the cause the owner themself suggested (their view, still to be checked). */
  owner_view: boolean;
};

export type ProblemResolution = "open" | "cause_confirmed" | "cause_supported" | "unknown";
export type Problem = {
  id: string;
  playbook: string | null;    // null → no playbook recognised (honest fallback)
  symptom_claim: string;      // claim id
  cause_claim: string | null; // the owner's own explanation, if they gave one
  hypotheses: Hypothesis[];
  resolution: ProblemResolution;
  probes: number;             // questions asked about this problem
  /** Plain-language note on what remains uncertain (set when the problem is closed as unknown or supported). */
  uncertainty: string | null;
  /** P6: investigated because of a goal the owner stated (the problem behind the goal), not a symptom. */
  from_goal?: boolean;
};

// ---- P6 · understanding first ----------------------------------------------------------------------

/** What the owner's goal or problem asks for. stated = the owner asked for it; implied = follows from a problem they described. */
export type Need = { id: string; capability: CapabilityKey; label: string; from: string[]; sources: string[]; status: "stated" | "implied" | "rejected" };

/**
 * Something the consultant believes but the owner hasn't said. Two kinds, never mixed (S10):
 *   implied – follows from the owner's own words; may fill a profile field, always as "assumed";
 *   typical – general industry knowledge; never fills a field and is never presented as a fact.
 */
export type Inference = {
  id: string;
  kind: "implied" | "typical";
  key: string;
  statement: string;
  slot: ProfileFieldKey | null;
  value: string | null;
  reason: string;
  sources: string[];
  status: "inferred" | "confirmed" | "rejected";
  /**
   * How it was settled (it stays an inference either way, never an owner-stated fact):
   * owner_words = the owner's own answer confirmed or rejected it; summary_review = the owner approved
   * (or corrected) it when reviewing the summary.
   */
  settled_by?: "owner_words" | "summary_review";
};

/** An agent being considered for a need or a cause. Never committed before the analysis. */
export type PossibleSolution = { capability: CapabilityKey; agent: string; for: string; status: "considering" | "dropped" };

/** A statement the offline reader didn't recognise: kept verbatim, never discarded (S9). */
export type Unrecognised = { id: string; text: string; source: string; status: "open" | "clarified"; clarification: string | null };

export type AgendaKind = "fact" | "hypothesis" | "confirm_cause" | "contradiction" | "other_problems" | "describe_problem" | "gap" | "opening" | "clarify";
export type AgendaItem = {
  key: string;                // purpose fingerprint: never asked again once answered
  kind: AgendaKind;
  target: string;             // field, hypothesis key, slot…
  problem_id: string | null;
  asked: number;              // 0, 1 or 2 (one rephrase at most)
  status: "open" | "answered" | "partly" | "declined" | "dropped";
};

export type Contradiction = {
  id: string;
  slot: FactSlot;
  a: { value: string; source: string };
  b: { value: string; source: string };
  status: "open" | "resolved";
  /** "correction" = the owner corrected themself explicitly; resolved immediately but still shown. */
  kind: "contradiction" | "correction";
  resolution: string | null;
};

export type ReasoningNote = { text: string; evidence: string[] };

export type CaseFile = {
  version: 1;
  /** native = created by the M3.5 consultant · migrated = built from a pre-M3.5 profile. */
  origin: "native" | "migrated";
  facts: Partial<Record<FactSlot, Fact>>;
  claims: Claim[];
  problems: Problem[];
  agenda: AgendaItem[];
  pending: string | null;     // agenda key of the question waiting for an answer
  contradictions: Contradiction[];
  notes: ReasoningNote[];
  unclassified: string[];     // owner message IDs not understood yet (clarified, never misfiled)
  questions_asked: number;
  seq: number;                // id counter
  // P6 sections (optional: P1–P4 and migrated case files stay valid without them)
  owner?: { name: Fact | null; business: { verb: "in" | "run"; phrase: string; source: string } | null; audience: "clients" | "customers" | null };
  needs?: Need[];
  inferences?: Inference[];
  solutions?: PossibleSolution[];
  /** The owner's answers to gap questions that have no profile field, keyed `capability:gap`. */
  gap_answers?: Record<string, { text: string; sources: string[] }>;
  unrecognised?: Unrecognised[];
};

export function emptyCaseFile(origin: CaseFile["origin"] = "native"): CaseFile {
  return { version: 1, origin, facts: {}, claims: [], problems: [], agenda: [], pending: null, contradictions: [], notes: [], unclassified: [], questions_asked: 0, seq: 0,
    owner: { name: null, business: null, audience: null }, needs: [], inferences: [], solutions: [], gap_answers: {}, unrecognised: [] };
}

/** The P6 sections, created when missing (a P1–P4 or migrated case file). Mutates and returns `cf`. */
export function withP6(cf: CaseFile): Required<Pick<CaseFile, "owner" | "needs" | "inferences" | "solutions" | "gap_answers" | "unrecognised">> & CaseFile {
  cf.owner ??= { name: null, business: null, audience: null };
  cf.needs ??= []; cf.inferences ??= []; cf.solutions ??= []; cf.gap_answers ??= {}; cf.unrecognised ??= [];
  return cf as ReturnType<typeof withP6>;
}

export const nextId = (cf: CaseFile, prefix: string) => `${prefix}${++cf.seq}`;

// ---- migration (pre-M3.5 profiles) ------------------------------------------------------------

/**
 * Build a case file for a profile created before M3.5. ADDITIVE ONLY: the profile's fields, their
 * statuses and the messages are not changed, so removing `case_file` restores the original
 * document exactly (revertCaseFileMigration). Assumed facts stay assumed; challenges become a
 * STATED symptom (the owner's report), never a confirmed cause.
 */
export function migrateToCaseFile(p: ProfileDoc): ProfileDoc {
  if (p.case_file) return p;
  const cf = emptyCaseFile("migrated");
  for (const k of PROFILE_FIELDS) {
    const f = p.fields[k];
    if (!isKnown(f)) continue;
    cf.facts[k] = { ...f };
  }
  const ch = p.fields.challenges;
  if (isKnown(ch)) cf.claims.push({ id: nextId(cf, "c"), kind: "symptom", text: ch.value!, status: "stated", sources: [...ch.sources], problem_id: null });
  const goal = p.fields.goals;
  if (isKnown(goal)) cf.claims.push({ id: nextId(cf, "c"), kind: "goal", text: goal.value!, status: "stated", sources: [...goal.sources], problem_id: null });
  // Questions already asked in M2 stay asked: the consultant never repeats them.
  for (const k of p.asked) cf.agenda.push({ key: `fact:${k}`, kind: "fact", target: k, problem_id: null, asked: 1, status: isKnown(p.fields[k]) ? "answered" : p.skipped.includes(k) ? "declined" : k === p.last_question_field ? "open" : "dropped" });
  if (p.last_question_field) cf.pending = `fact:${p.last_question_field}`;
  cf.questions_asked = p.asked.length;
  return { ...p, case_file: cf };
}

/** Undo the migration: the exact pre-M3.5 document (tested deep-equal). */
export function revertCaseFileMigration(p: ProfileDoc): ProfileDoc {
  const { case_file: _drop, ...rest } = p;
  void _drop;
  return rest as ProfileDoc;
}

/** True for discoveries captured before the M3.5 consultant could investigate causes. */
export const isPreM35Discovery = (p: ProfileDoc) => !p.case_file || p.case_file.origin === "migrated";

// ---- the ten-field compatibility view -----------------------------------------------------------

const join = (xs: string[]) => [...new Set(xs.map(x => x.trim()).filter(Boolean))].join("; ").slice(0, 600);

/**
 * The ten M2 profile fields, derived from the case file. Facts map 1:1; challenges and goals come
 * from the owner's claims unless the owner edited them in the summary. A contradicted fact shows its
 * latest value as unconfirmed. Status meanings are unchanged for downstream code.
 */
export function fieldsView(cf: CaseFile, previous: Record<ProfileFieldKey, ProfileField>): Record<ProfileFieldKey, ProfileField> {
  const out = {} as Record<ProfileFieldKey, ProfileField>;
  for (const k of PROFILE_FIELDS) {
    const f = cf.facts[k];
    out[k] = f ? { value: f.value, status: f.contradicted && f.status === "confirmed" ? "assumed" : f.status, sources: [...f.sources], updated_by: f.updated_by, updated_at: f.updated_at } : emptyField();
  }
  const fromClaims = (kind: ClaimKind, key: ProfileFieldKey) => {
    if (cf.facts[key]?.updated_by === "owner") return;   // the owner's own summary wording wins
    const cs = cf.claims.filter(c => c.kind === kind && c.status !== "questioned");
    if (!cs.length) return;
    out[key] = { value: join(cs.map(c => c.text)), status: "confirmed", sources: [...new Set(cs.flatMap(c => c.sources))].slice(-30), updated_by: "consultant", updated_at: previous[key]?.updated_at ?? null };
  };
  fromClaims("symptom", "challenges");
  fromClaims("goal", "goals");
  // A team size stated on its own still fills "Team & structure".
  const size = cf.facts.team_size;
  if (!isKnown(out.team_structure) && size && size.value) out.team_structure = { value: size.value, status: size.status, sources: [...size.sources], updated_by: size.updated_by, updated_at: size.updated_at };
  // P6: an inference IMPLIED by the owner's words may fill an empty field, always as "assumed" (shown as
  // unconfirmed). Typical industry knowledge never fills a field (S10).
  for (const i of cf.inferences ?? []) {
    if (i.kind !== "implied" || !i.slot || !i.value || i.status === "rejected" || isKnown(out[i.slot])) continue;
    out[i.slot] = { value: i.value, status: i.status === "confirmed" ? "confirmed" : "assumed", sources: [...i.sources], updated_by: "consultant", updated_at: previous[i.slot]?.updated_at ?? null };
  }
  return out;
}

// ---- readiness ------------------------------------------------------------------------------------

export type CaseReadiness = { ready: boolean; byBudget: boolean; unknowns: string[] };

const resolvedFact = (cf: CaseFile, k: ProfileFieldKey, fields: Record<ProfileFieldKey, ProfileField>) => {
  if (isKnown(fields[k])) return true;
  const item = cf.agenda.find(a => a.key === `fact:${k}`);
  return !!item && item.status !== "open";
};

/** P6: only the industry is always needed. Everything else is asked only when it matters (gaps). */
export const ESSENTIAL_FIELDS: ProfileFieldKey[] = ["industry"];

/** The capabilities being considered (from needs and from supported or confirmed causes). */
export const consideredCapabilities = (cf: CaseFile) => [...new Set((cf.solutions ?? []).filter(s => s.status === "considering").map(s => s.capability))];

/** High and medium gaps of every possible solution that are neither satisfied nor asked and settled. */
export function openGaps(cf: CaseFile): Array<{ capability: CapabilityKey; gap: GapDef; agendaKey: string }> {
  const out: Array<{ capability: CapabilityKey; gap: GapDef; agendaKey: string }> = [];
  for (const capability of consideredCapabilities(cf)) {
    for (const gap of GAPS[capability] ?? []) {
      const agendaKey = `gap:${capability}:${gap.key}`;
      const item = cf.agenda.find(a => a.key === agendaKey);
      // The same field may matter to two solutions (orders and messages both need the channel): one question.
      const sameSlot = gap.slot ? cf.agenda.find(a => a.kind === "gap" && a.target.endsWith(`|${gap.slot}`) && a.status !== "open") : null;
      if (gap.satisfied(cf) || (item && item.status !== "open") || sameSlot) continue;
      out.push({ capability, gap, agendaKey });
    }
  }
  return out;
}

/**
 * Enough to move forward, decided by code, BY NEED rather than by coverage (P6): the industry is
 * known, there is at least one goal or problem, every problem is resolved (cause confirmed, supported,
 * or explicitly unknown), the high and medium gaps of every possible solution are resolved, and no
 * contradiction is open. Or the question budget is spent, in which case the unknowns are listed.
 */
export function caseReadiness(cf: CaseFile, fields: Record<ProfileFieldKey, ProfileField>): CaseReadiness {
  const unknowns: string[] = [];
  for (const p of cf.problems) if (p.resolution === "unknown" && p.uncertainty) unknowns.push(p.uncertainty);
  for (const k of PROFILE_FIELDS) if (!isKnown(fields[k])) unknowns.push(k);
  if (cf.pending) {
    const item = cf.agenda.find(a => a.key === cf.pending);
    // A question waiting for an answer is always answered (or declined) first, even at the budget.
    if (item?.status === "open") return { ready: false, byBudget: false, unknowns };
  }
  const industry = resolvedFact(cf, "industry", fields);
  const purpose = cf.problems.length > 0 || cf.claims.some(c => c.kind === "goal") || resolvedFact(cf, "challenges", fields);
  const problemsDone = cf.problems.every(p => p.resolution !== "open");
  const noContradiction = cf.contradictions.every(c => c.status === "resolved" || (cf.agenda.find(a => a.key === `contra:${c.id}`)?.status ?? "open") !== "open");
  const gaps = openGaps(cf).length === 0;
  const reported = cf.problems.filter(p => !p.from_goal);
  const otherAsked = reported.length === 0 || cf.problems.length >= 3 || cf.agenda.some(a => a.kind === "other_problems" && a.status !== "open");
  const ready = industry && purpose && problemsDone && noContradiction && gaps && otherAsked;
  const byBudget = !ready && cf.questions_asked >= MAX_QUESTIONS;
  return { ready: ready || byBudget, byBudget, unknowns };
}

/** Readiness for any profile: the case file when present, the M2 rule for an unmigrated one. */
export function discoveryReadiness(p: ProfileDoc): CaseReadiness {
  if (!p.case_file) { const r = readiness(p); return { ready: r.ready, byBudget: false, unknowns: r.missing }; }
  return caseReadiness(p.case_file, p.fields);
}

/**
 * Mirror owner edits (summary corrections) and summary confirmation into the case file, so the
 * view and the source of truth agree. Owner edits are locked against consultant changes.
 */
export function syncOwnerFields(p: ProfileDoc, keys: ProfileFieldKey[], confirmAssumed = false): ProfileDoc {
  if (!p.case_file) return p;
  const cf = structuredClone(p.case_file);
  for (const k of keys) {
    cf.facts[k] = { ...p.fields[k] };
    // The owner corrected a field that showed an inference: that inference was wrong.
    for (const i of cf.inferences ?? []) if (i.kind === "implied" && i.slot === k && i.status === "inferred" && p.fields[k].value !== i.value) { i.status = "rejected"; i.settled_by = "summary_review"; }
  }
  if (confirmAssumed) {
    for (const f of Object.values(cf.facts)) if (f && f.status === "assumed") f.status = "confirmed";
    // Inferences the owner saw in the summary and approved: recorded as approved, still labelled inferences.
    // Typical industry knowledge is never shown as a field, so it is never confirmed here.
    for (const i of cf.inferences ?? []) {
      if (i.kind !== "implied" || i.status !== "inferred" || !i.slot || p.fields[i.slot]?.value !== i.value) continue;
      i.status = "confirmed"; i.settled_by = "summary_review";
    }
  }
  return { ...p, case_file: cf };
}

// Re-exported for the interpretation schema.
export { ProfileFieldKeySchema };
export const FactSlotSchema = z.union([ProfileFieldKeySchema, z.literal("team_size")]);
