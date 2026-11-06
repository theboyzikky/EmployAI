// M3.5 · The code-owned part of each consultant turn:
//   apply   – update the case file from an interpretation, under fixed rules;
//   derive  – P6: needs → possible solutions, the problem behind a stated goal, inferences (two kinds);
//   plan    – choose the ONE next question by materiality (or decide there's enough to move on);
//   compose – write the reply from what was actually recorded: what I understood, what might help,
//             then the question that matters. A reasoning framework, not a template (S11).
// No model decides what is true, what to ask next or when to stop.
import { lowerFirst, upperFirst } from "@/lib/text";
import type { CapabilityKey } from "@/lib/catalogue/catalogue";
import {
  ESSENTIAL_FIELDS, MAX_PROBES_PER_PROBLEM, MAX_QUESTIONS, caseReadiness, fieldsView, nextId, openGaps, withP6,
  type AgendaItem, type CaseFile, type Fact, type FactSlot, type Hypothesis, type Inference, type Problem,
} from "./casefile";
import type { Interpretation } from "./interpretation";
import { GAPS, INDUSTRY_OFFER, MESSAGE_WORDS, TYPICAL_TOPICS, agentFor, industryWords, offerFromPhrase, type GapContext } from "./needs";
import { causeOf, enquiryCapabilities, matchPlaybook, playbookByKey, PLAYBOOKS, type Playbook } from "./playbooks";
import { FIELD_LABELS, LIST_FIELDS, MAX_FIELD_LENGTH, isKnown, type ProfileDoc, type ProfileFieldKey } from "./profile";
import { normalizeBrands } from "@/lib/text";
import { questionFor } from "@/lib/rules/questions";

const MAX_PROBLEMS = 3;
const MAX_CLARIFY = 2;
/** Slots that hold one value: a different value is a contradiction (or an explicit correction). */
const SINGLE: FactSlot[] = ["business_name", "industry", "team_size"];
const SLOT_LABEL: Record<FactSlot, string> = { ...FIELD_LABELS, team_size: "team size" };

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
/** Lower-case the first letter for use mid-sentence, but keep "I" and names. */
const mid = (s: string) => (/^(?:I\b|I'|[A-Z][a-z]+'s\b)/.test(s) ? s : lowerFirst(s)).replace(/[.!?]+$/, "");
/** The owner's words in the consultant's voice: "we buy too much" → "you buy too much". */
const SWAP: Record<string, string> = { i: "you", "i'm": "you're", "i've": "you've", "i'd": "you'd", "i'll": "you'll", me: "you", my: "your", mine: "yours", myself: "yourself", we: "you", "we're": "you're", "we've": "you've", "we'd": "you'd", "we'll": "you'll", us: "you", our: "your", ours: "yours", ourselves: "yourselves" };
const voice = (s: string) => mid(s.replace(/\b(?:I(?:'m|'ve|'d|'ll)?|me|my|mine|myself|we(?:'re|'ve|'d|'ll)?|us|our|ours|ourselves)\b/gi, w => {
  const r = SWAP[w.toLowerCase()] ?? w;
  return w[0] === w[0].toUpperCase() && w.toLowerCase() !== "i" ? r[0].toUpperCase() + r.slice(1) : r;
}));
const quote = (s: string, n = 90) => `“${(s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s).replace(/[.!?]+$/, "")}”`;
/** "an inventory agent and a procurement agent" */
const agentList = (caps: CapabilityKey[]) => {
  const names = [...new Set(caps.map(c => agentFor(c).name.toLowerCase()))].map(n => `${/^[aeiou]/.test(n) ? "an" : "a"} ${n}`);
  return names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
};
/** What an agent for this capability would do, in one clause. */
const DUTY: Record<CapabilityKey, string> = {
  customer_messaging: "answers the questions your {audience} ask most and passes anything unusual to you",
  order_intake: "takes and confirms orders as they come in, so they don't depend on someone being free",
  bookings: "takes bookings and sends reminders",
  inventory_tracking: "keeps track of stock and warns you before things run out",
  procurement: "prepares reorders for your approved suppliers",
  finance_payments: "records payments and costs so you can see where the money goes",
  orchestration: "coordinates the other agents",
};

export type TurnEvent =
  | { type: "problem"; problem: string; symptom: string; cause: string | null; recognised: boolean }
  | { type: "fact"; slot: FactSlot; value: string }
  | { type: "goal"; text: string }
  | { type: "goal_changed"; text: string }
  | { type: "correction"; slot: FactSlot; from: string; to: string }
  | { type: "contradiction"; id: string }
  | { type: "contradiction_resolved"; slot: FactSlot; value: string }
  | { type: "supported" | "ruled_out" | "confirmed" | "denied"; problem: string; cause: string }
  | { type: "closed"; problem: string }
  | { type: "need"; capability: CapabilityKey; status: "stated" | "implied" }
  | { type: "need_rejected"; capability: CapabilityKey }
  | { type: "owner_name"; name: string }
  | { type: "topics"; verdict: boolean | null }
  | { type: "unrecognised"; text: string }
  | { type: "declined" }
  | { type: "elsewhere" }
  | { type: "unclassified" };

// ---- apply ---------------------------------------------------------------------------------------

export function applyInterpretation(cf0: CaseFile, it: Interpretation, ownerIds: ReadonlySet<string>, now = new Date().toISOString()): { caseFile: CaseFile; events: TurnEvent[] } {
  const cf = withP6(structuredClone(cf0));
  const events: TurnEvent[] = [];
  const grounded = (ids: string[]) => ids.filter(i => ownerIds.has(i));
  const pending = cf.pending ? cf.agenda.find(a => a.key === cf.pending) ?? null : null;

  // Who the owner is, and the business in their own words (kept once; the owner can correct the summary).
  if (it.owner_name && grounded(it.owner_name.sources).length && !cf.owner.name) {
    cf.owner.name = { value: it.owner_name.value, status: "confirmed", sources: grounded(it.owner_name.sources), updated_by: "consultant", updated_at: now };
    events.push({ type: "owner_name", name: it.owner_name.value });
  }
  if (it.business && grounded(it.business.sources).length && !cf.owner.business) cf.owner.business = { verb: it.business.verb, phrase: it.business.phrase, source: it.business.sources[0] };
  if (it.audience && !cf.owner.audience) cf.owner.audience = it.audience;

  // Facts
  for (const f of it.facts) {
    const sources = grounded(f.sources);
    if (!sources.length) continue;
    const slot = f.slot;
    const value = normalizeBrands(f.value.trim()).slice(0, MAX_FIELD_LENGTH);
    const cur = cf.facts[slot];
    const fresh: Fact = { value, status: f.status, sources, updated_by: "consultant", updated_at: now };
    if (!cur || !cur.value) { cf.facts[slot] = fresh; events.push({ type: "fact", slot, value }); continue; }
    if (cur.updated_by === "owner") continue;                                   // owner edits win
    if (norm(cur.value) === norm(value)) { cur.sources = [...new Set([...cur.sources, ...sources])].slice(-30); continue; }
    if (f.status === "assumed" && cur.status === "confirmed") continue;          // a guess never replaces an answer
    if (LIST_FIELDS.includes(slot as ProfileFieldKey)) {
      const list = [...new Set([...cur.value.split(/\s*,\s*/), ...value.split(/\s*,\s*/)].filter(Boolean))].join(", ").slice(0, MAX_FIELD_LENGTH);
      if (list !== cur.value) events.push({ type: "fact", slot, value });
      cf.facts[slot] = { ...cur, value: list, sources: [...new Set([...cur.sources, ...sources])].slice(-30), updated_at: now };
      continue;
    }
    const open = cf.contradictions.find(c => c.slot === slot && c.status === "open");
    if (SINGLE.includes(slot)) {
      if (f.correction || (pending?.kind === "contradiction" && open && pending.target === slot)) {
        // An explicit correction, or the owner's answer to the contradiction question: resolved, but kept visible.
        cf.facts[slot] = { ...fresh, status: "confirmed", history: [...(cur.history ?? []), { value: cur.value, sources: cur.sources, replaced_at: now }], contradicted: false };
        if (open) { open.status = "resolved"; open.resolution = value; events.push({ type: "contradiction_resolved", slot, value }); }
        else {
          cf.contradictions.push({ id: nextId(cf, "x"), slot, a: { value: cur.value, source: cur.sources.at(-1) ?? "" }, b: { value, source: sources[0] }, status: "resolved", kind: "correction", resolution: value });
          events.push({ type: "correction", slot, from: cur.value, to: value });
        }
        if (slot === "team_size") delete cf.facts.team_structure;               // its text described the old team
      } else if (!open) {
        const id = nextId(cf, "x");
        cf.contradictions.push({ id, slot, a: { value: cur.value, source: cur.sources.at(-1) ?? "" }, b: { value, source: sources[0] }, status: "open", kind: "contradiction", resolution: null });
        cur.contradicted = true;
        events.push({ type: "contradiction", id });
      }
      continue;
    }
    // Free-text facts: a direct answer or an explicit correction replaces; a side mention never does.
    if (f.direct || f.correction) cf.facts[slot] = { ...fresh, history: [...(cur.history ?? []), { value: cur.value, sources: cur.sources, replaced_at: now }] };
  }
  // A team-size contradiction also makes the free-text team description unreliable.
  if (cf.contradictions.some(c => c.slot === "team_size" && c.status === "open") && cf.facts.team_structure) cf.facts.team_structure.contradicted = true;

  // Claims, and the problems they describe
  const refToId = new Map<string, string>();
  for (const c of it.claims) {
    const sources = grounded(c.sources);
    if (!sources.length) continue;
    const dup = cf.claims.find(x => x.kind === c.kind && norm(x.text) === norm(c.text));
    if (dup) { refToId.set(c.ref, dup.id); continue; }
    // "Actually, what I really want is…": the earlier goals stay on record but no longer count.
    if (c.kind === "goal" && c.correction) for (const g of cf.claims.filter(x => x.kind === "goal" && x.status !== "questioned")) g.status = "questioned";
    const id = nextId(cf, "c");
    refToId.set(c.ref, id);
    cf.claims.push({ id, kind: c.kind, text: c.text, status: "stated", sources, problem_id: null });
    if (c.kind === "goal") events.push(c.correction ? { type: "goal_changed", text: c.text } : { type: "goal", text: c.text });
  }
  const industry = cf.facts.industry?.value ?? null;
  for (const c of it.claims) {
    if (c.kind !== "symptom") continue;
    const sid = refToId.get(c.ref);
    const sym = cf.claims.find(x => x.id === sid);
    if (!sym || sym.problem_id) continue;
    const causeIn = it.claims.find(x => x.kind === "cause" && x.cause_of === c.ref);
    const cause = causeIn ? cf.claims.find(x => x.id === refToId.get(causeIn.ref)) ?? null : null;
    // While asking the owner to describe an unrecognised problem, their answer belongs to that problem.
    if (pending?.kind === "describe_problem" && pending.problem_id) { sym.problem_id = pending.problem_id; continue; }
    // If the owner's explanation is itself a recognised problem ("losing money because we buy too much
    // stock"), that is what gets investigated; otherwise the symptom's playbook, with their view as one cause.
    const pbFromCause = cause ? matchPlaybook(cause.text, industry) : null;
    const pb = pbFromCause ?? matchPlaybook(sym.text, industry);
    const existing = pb ? cf.problems.find(p => p.playbook === pb.key) : null;
    if (existing) {
      // A goal-led problem gains the owner's own description of what goes wrong.
      if (existing.from_goal) { existing.from_goal = false; existing.symptom_claim = sym.id; }
      sym.problem_id = existing.id; if (cause) cause.problem_id = existing.id; continue;
    }
    if (cf.problems.length >= MAX_PROBLEMS) continue;
    const problem = newProblem(cf, pb, sym.id, cause?.id ?? null);
    if (pb && cause && !pbFromCause) {
      const view = pb.causes.find(k => (k.ownerView ?? k.supports).test(cause.text));
      const h = problem.hypotheses.find(x => x.key === view?.key);
      if (h) h.owner_view = true;
    }
    sym.problem_id = problem.id;
    if (cause) cause.problem_id = problem.id;
    events.push({ type: "problem", problem: problem.id, symptom: sym.text, cause: cause?.text ?? null, recognised: !!pb });
  }

  // Needs: what a goal asks for (stated) or a problem calls for (implied); or a need the owner rejects.
  for (const n of it.needs) {
    const sources = grounded(n.sources);
    if (!sources.length) continue;
    const from = n.from_ref ? refToId.get(n.from_ref) : undefined;
    const existing = cf.needs.find(x => x.capability === n.capability);
    if (n.status === "rejected") {
      if (existing) existing.status = "rejected";
      else cf.needs.push({ id: nextId(cf, "n"), capability: n.capability, label: n.label, from: [], sources, status: "rejected" });
      events.push({ type: "need_rejected", capability: n.capability });
      continue;
    }
    if (existing) {
      if (existing.status === "rejected") continue;                             // the owner said no; only they can reopen it
      if (n.status === "stated" && existing.status === "implied") { existing.status = "stated"; events.push({ type: "need", capability: n.capability, status: "stated" }); }
      existing.from = [...new Set([...existing.from, ...(from ? [from] : [])])];
      existing.sources = [...new Set([...existing.sources, ...sources])];
      continue;
    }
    cf.needs.push({ id: nextId(cf, "n"), capability: n.capability, label: n.label, from: from ? [from] : [], sources, status: n.status });
    events.push({ type: "need", capability: n.capability, status: n.status });
  }

  // Evidence about possible causes
  for (const s of it.signals) {
    const sources = grounded(s.sources);
    if (!sources.length) continue;
    const problem = cf.problems.find(p => p.playbook === s.playbook && p.resolution === "open");
    const h = problem?.hypotheses.find(x => x.key === s.cause);
    if (!problem || !h) continue;
    h.evidence = [...new Set([...h.evidence, ...sources])];
    if (s.effect === "supports" && h.status === "open") { h.status = "supported"; events.push({ type: "supported", problem: problem.id, cause: h.key }); }
    if (s.effect === "refutes" && h.status !== "confirmed") { h.status = "ruled_out"; events.push({ type: "ruled_out", problem: problem.id, cause: h.key }); }
    // Only the owner's answer to a confirmation question can confirm a cause.
    if (s.effect === "confirms" && pending?.kind === "confirm_cause" && pending.target === h.key) {
      h.status = "confirmed"; problem.resolution = "cause_confirmed"; problem.uncertainty = null;
      const own = cf.claims.find(c => c.id === problem.cause_claim);
      if (own && h.owner_view) own.status = "confirmed";
      events.push({ type: "confirmed", problem: problem.id, cause: h.key });
    }
    if (s.effect === "denies" && pending?.kind === "confirm_cause" && pending.target === h.key) {
      h.status = "ruled_out";
      const own = cf.claims.find(c => c.id === problem.cause_claim);
      if (own && h.owner_view) own.status = "questioned";
      events.push({ type: "denied", problem: problem.id, cause: h.key });
    }
  }

  // Answers that have no profile field: gap details, clarifications, the typical-topics check.
  if (it.gap_answer && grounded(it.gap_answer.sources).length) {
    const g = it.gap_answer;
    if (g.key.startsWith("clarify:")) {
      const u = cf.unrecognised.find(x => x.id === g.key.slice(8));
      if (u) { u.status = "clarified"; u.clarification = g.text; }
    } else cf.gap_answers[g.key] = { text: g.text, sources: grounded(g.sources) };
  }
  if (it.topics_verdict !== null) {
    const typical = cf.inferences.find(i => i.key === "typical_topics");
    if (typical) { typical.status = it.topics_verdict ? "confirmed" : "rejected"; typical.settled_by = "owner_words"; }
    events.push({ type: "topics", verdict: it.topics_verdict });
  } else if (it.gap_answer?.key === "customer_messaging:topics" && pending?.target.startsWith("customer_messaging:topics")) events.push({ type: "topics", verdict: null });

  // S9: what wasn't understood is kept verbatim.
  for (const u of it.unrecognised) {
    const sources = grounded(u.sources);
    if (!sources.length || cf.unrecognised.some(x => norm(x.text) === norm(u.text))) continue;
    cf.unrecognised.push({ id: nextId(cf, "u"), text: u.text, source: sources[0], status: "open", clarification: null });
    events.push({ type: "unrecognised", text: u.text });
  }

  // The pending question
  if (pending && it.answer) {
    // A fact question answered with something else stays open (asked once more); other kinds may be partly answered.
    if (it.answer === "answered" || (it.answer === "partly" && pending.kind !== "fact" && pending.kind !== "gap")) pending.status = it.answer;
    if (it.answer === "declined") { pending.status = "declined"; events.push({ type: "declined" }); }
    if (it.answer === "partly" && (pending.kind === "fact" || pending.kind === "gap") && !events.length) events.push({ type: "elsewhere" });
    if (it.answer === "answered" && pending.kind === "describe_problem" && pending.problem_id) closeProblem(cf, pending.problem_id, events);
  }
  if (it.unclassified.length && !events.length) events.push({ type: "unclassified" });
  cf.unclassified = [...new Set([...cf.unclassified, ...grounded(it.unclassified)])].slice(-20);

  derive(cf, now);
  return { caseFile: cf, events };
}

function newProblem(cf: CaseFile, pb: Playbook | null, symptomClaim: string, causeClaim: string | null, fromGoal = false): Problem {
  const problem: Problem = {
    id: nextId(cf, "p"), playbook: pb?.key ?? null, symptom_claim: symptomClaim, cause_claim: causeClaim,
    hypotheses: (pb?.causes ?? []).map(k => ({ key: k.key, status: "open", evidence: [], owner_view: false } as Hypothesis)),
    resolution: "open", probes: 0, uncertainty: null, ...(fromGoal ? { from_goal: true } : {}),
  };
  cf.problems.push(problem);
  return problem;
}

/** The capabilities a cause would use (the enquiries playbook depends on whether the messages are orders). */
function causeCapabilities(cf: CaseFile, p: Problem, key: string): CapabilityKey[] {
  const pb = playbookByKey(p.playbook);
  if (!pb) return [];
  if (pb.key === "enquiries") return enquiryCapabilities(cf.claims.find(c => c.id === p.symptom_claim)?.text ?? "");
  return causeOf(pb, key)?.capabilities ?? [];
}

/**
 * P6 · derived understanding, recomputed after every message:
 * - the problem BEHIND a stated goal ("automate my chat replies") is investigated with the enquiries set;
 * - possible solutions from needs and from supported or confirmed causes (considering, never committed);
 * - inferences: implied by the owner's words, or typical for the industry (S10), never mixed.
 */
function derive(cf: ReturnType<typeof withP6>, now: string) {
  void now;
  const enquiries = PLAYBOOKS.find(p => p.key === "enquiries")!;
  for (const n of cf.needs) {
    if (n.status !== "stated" || !["customer_messaging", "order_intake"].includes(n.capability)) continue;
    if (cf.problems.some(p => p.playbook === "enquiries") || cf.problems.length >= MAX_PROBLEMS || !n.from[0]) continue;
    // A problem the owner already described covers it ("we keep missing WhatsApp orders" + "automate order taking").
    if (cf.problems.some(p => !p.from_goal && playbookByKey(p.playbook)?.causes.some(k => k.capabilities.includes(n.capability)))) continue;
    const p = newProblem(cf, enquiries, n.from[0], null, true);
    const goal = cf.claims.find(c => c.id === n.from[0]);
    if (goal) goal.problem_id = p.id;
  }

  const solutions = new Map<CapabilityKey, { for: string; status: "considering" | "dropped" }>();
  for (const n of cf.needs) solutions.set(n.capability, { for: n.label, status: n.status === "rejected" ? "dropped" : "considering" });
  for (const p of cf.problems) {
    const sym = cf.claims.find(c => c.id === p.symptom_claim)?.text ?? "";
    for (const h of p.hypotheses.filter(x => x.status === "supported" || x.status === "confirmed"))
      for (const c of causeCapabilities(cf, p, h.key)) if (!solutions.has(c)) solutions.set(c, { for: sym, status: "considering" });
  }
  cf.solutions = [...solutions.entries()].map(([capability, s]) => ({ capability, agent: agentFor(capability).name, for: s.for, status: s.status }));

  const industry = cf.facts.industry?.value ?? null;
  const add = (i: Omit<Inference, "id" | "status">) => { if (!cf.inferences.some(x => x.key === i.key)) cf.inferences.push({ ...i, id: nextId(cf, "i"), status: "inferred" }); };
  // Implied: clients contact you by message (from your words), platform unknown. Never a platform name.
  const msgClaim = cf.claims.find(c => (c.kind === "goal" || c.kind === "symptom") && MESSAGE_WORDS.test(c.text));
  if (msgClaim && !cf.facts.customers_channels?.value)
    add({ kind: "implied", key: "channel_messages", statement: "Your clients contact you by message or chat (which platform isn't known yet)", slot: "customers_channels", value: "Messages / chat (platform not stated)", reason: `You mentioned ${quote(msgClaim.text, 60)}`, sources: msgClaim.sources });
  const chan = cf.inferences.find(i => i.key === "channel_messages");
  if (chan && chan.status === "inferred" && /WhatsApp|Instagram|Facebook|TikTok|Email/.test(cf.facts.customers_channels?.value ?? "")) { chan.status = "confirmed"; chan.settled_by = "owner_words"; }
  // Implied by the industry you named: what the business deals in (definitional, still "unconfirmed").
  const offer = industry ? INDUSTRY_OFFER[industry] ?? offerFromPhrase(industry, cf.owner.business?.phrase ?? null) : null;
  if (industry && offer && !cf.facts.products_services?.value && cf.facts.industry)
    add({ kind: "implied", key: "offer", statement: `The business offers ${lowerFirst(offer)}`, slot: "products_services", value: offer,
      reason: INDUSTRY_OFFER[industry] ? `You said you're in ${industryWords(industry)}` : `You described the business as ${quote(cf.owner.business!.phrase, 60)}`, sources: cf.facts.industry.sources });
  // Typical for the industry: what clients usually ask. Never a fact about this business.
  const talks = cf.solutions.some(s => s.status === "considering" && ["customer_messaging", "order_intake", "bookings"].includes(s.capability));
  if (industry && TYPICAL_TOPICS[industry] && talks && cf.facts.industry)
    add({ kind: "typical", key: "typical_topics", statement: `In ${industryWords(industry)}, ${cf.owner.audience ?? "customers"} usually ask about ${TYPICAL_TOPICS[industry]}`, slot: null, value: null, reason: `General knowledge about ${industryWords(industry)}, not something you told me`, sources: cf.facts.industry.sources });
}

/** Close a problem honestly: confirmed, supported (not confirmed), or unknown — with what remains uncertain. */
function closeProblem(cf: CaseFile, pid: string, events: TurnEvent[]) {
  const p = cf.problems.find(x => x.id === pid);
  if (!p || p.resolution !== "open") return;
  const pb = playbookByKey(p.playbook);
  const symptom = cf.claims.find(c => c.id === p.symptom_claim)?.text ?? "this problem";
  const what = p.from_goal ? `what's behind ${quote(symptom, 70)}` : quote(symptom, 70);
  const confirmed = p.hypotheses.find(h => h.status === "confirmed");
  const supported = p.hypotheses.filter(h => h.status === "supported");
  if (confirmed) { p.resolution = "cause_confirmed"; p.uncertainty = null; }
  else if (supported.length && pb) {
    p.resolution = "cause_supported";
    p.uncertainty = `Not confirmed by you yet: the likely reason for ${what} is that ${supported.map(h => causeOf(pb, h.key)!.label).join(", and that ")}.`;
  } else {
    p.resolution = "unknown";
    const checked = pb ? p.hypotheses.filter(h => h.status === "ruled_out").map(h => causeOf(pb, h.key)!.label) : [];
    p.uncertainty = `The cause of ${what} is still unknown${checked.length ? ` (ruled out: ${checked.join("; ")})` : ""}.${pb ? ` ${pb.measure.title}.` : ""}`;
  }
  events.push({ type: "closed", problem: p.id });
}

// ---- plan --------------------------------------------------------------------------------------------

export type Plan =
  | { kind: "ask"; item: AgendaItem; text: string; reason: string | null; rephrase: boolean }
  | { kind: "ready"; byBudget: boolean };

const gapContext = (cf: CaseFile): GapContext => {
  const industry = cf.facts.industry?.value ?? null;
  const typical = (cf.inferences ?? []).find(i => i.key === "typical_topics" && i.status === "inferred");
  return { audience: cf.owner?.audience ?? "customers", industry: industryWords(industry), topics: typical && industry ? TYPICAL_TOPICS[industry] ?? null : null };
};

/**
 * Choose the next question by MATERIALITY (P6), never something already stated or reasonably
 * inferable. Mutates `cf` (agenda, pending, counters, closures).
 *   contradictions → high gaps of what the owner asked for → problems (causes) → industry → purpose →
 *   high gaps of other possible solutions → clarify what wasn't understood → other problems →
 *   medium gaps → ready.
 */
export function planNext(cf: CaseFile, profile: ProfileDoc, events: TurnEvent[]): Plan {
  const fields = fieldsView(cf, profile.fields);
  const get = (key: string) => cf.agenda.find(a => a.key === key);
  const ask = (key: string, kind: AgendaItem["kind"], target: string, problem: Problem | null, text: string, reason: string | null): Plan => {
    let item = get(key);
    if (!item) { item = { key, kind, target, problem_id: problem?.id ?? null, asked: 0, status: "open" }; cf.agenda.push(item); }
    const rephrase = item.asked > 0;
    item.asked += 1; item.status = "open";
    cf.pending = key; cf.questions_asked += 1;
    if (problem) problem.probes += 1;
    return { kind: "ask", item, text, reason, rephrase };
  };

  // The question still waiting: rephrase it once, then drop it (never asked a third time).
  const waiting = cf.pending ? get(cf.pending) : null;
  cf.pending = null;
  if (waiting && waiting.status === "open") {
    const stillOpen = waiting.kind !== "gap" || openGaps(cf).some(g => g.agendaKey === waiting.key);
    if (stillOpen && waiting.asked < 2 && cf.questions_asked < MAX_QUESTIONS) {
      const problem = waiting.problem_id ? cf.problems.find(p => p.id === waiting.problem_id) ?? null : null;
      if (!problem || (problem.resolution === "open" && problem.probes < MAX_PROBES_PER_PROBLEM)) {
        return ask(waiting.key, waiting.kind, waiting.target, problem, rephraseFor(waiting, cf, profile), null);
      }
    }
    waiting.status = stillOpen ? "dropped" : "answered";
  }

  if (cf.questions_asked >= MAX_QUESTIONS) { for (const p of cf.problems) closeProblem(cf, p.id, events); return { kind: "ready", byBudget: true }; }

  // 1 · contradictions
  for (const c of cf.contradictions.filter(x => x.status === "open")) {
    const key = `contra:${c.id}`;
    if (get(key)) continue;
    return ask(key, "contradiction", c.slot, null, `Earlier you mentioned ${quote(c.a.value, 60)}, and now ${quote(c.b.value, 60)}. Which is right?`,
      c.slot === "team_size" ? "I want to get this right, because it changes how much an AI team should take on." : "I want the summary to be right before we go further.");
  }

  const gapAsk = (filter: (capability: CapabilityKey) => boolean, weight: "high" | "medium") => {
    const g = openGaps(cf).find(x => x.gap.weight === weight && filter(x.capability) && !get(x.agendaKey));
    if (!g) return null;
    const ctx = gapContext(cf);
    return ask(g.agendaKey, "gap", `${g.capability}:${g.gap.key}|${g.gap.slot ?? ""}`, null, g.gap.question(ctx), g.gap.reason);
  };
  const stated = new Set((cf.needs ?? []).filter(n => n.status === "stated").map(n => n.capability));

  // 2 · what the owner asked for: the details that would change it
  const s = gapAsk(c => stated.has(c), "high");
  if (s) return s;

  // 3 · problems: investigate the cause before suggesting a fix
  for (const p of cf.problems.filter(x => x.resolution === "open")) {
    const pb = playbookByKey(p.playbook);
    if (!pb) {
      const key = `describe:${p.id}`;
      if (!get(key)) return ask(key, "describe_problem", p.id, p, "I don't recognise that kind of problem yet, so I won't guess at its causes. Could you describe what happens, and how often?", null);
      closeProblem(cf, p.id, events); continue;
    }
    if (p.hypotheses.some(h => h.status === "confirmed")) { closeProblem(cf, p.id, events); continue; }
    if (p.probes >= MAX_PROBES_PER_PROBLEM) { closeProblem(cf, p.id, events); continue; }
    const supported = p.hypotheses.find(h => h.status === "supported" && !get(`confirm:${p.id}:${h.key}`));
    if (supported) {
      const label = causeOf(pb, supported.key)!.label;
      return ask(`confirm:${p.id}:${supported.key}`, "confirm_cause", supported.key, p,
        `So the likely cause looks like this: ${label}. Does that match what you see?`, null);
    }
    // No explanation of their own yet: one open question that can point to several causes at once.
    const anyOwnerView = p.hypotheses.some(h => h.owner_view);
    if (pb.opening && !anyOwnerView && !get(`opening:${p.id}`) && p.hypotheses.every(h => h.status === "open"))
      return ask(`opening:${p.id}`, "opening", p.id, p, p.from_goal ? pb.opening.goal : pb.opening.problem, null);
    const order = [...p.hypotheses.filter(h => h.owner_view), ...p.hypotheses.filter(h => !h.owner_view)];
    const nextHyp = order.find(h => h.status === "open" && !get(`hyp:${p.id}:${h.key}`));
    if (nextHyp) {
      const cause = causeOf(pb, nextHyp.key)!;
      const first = p.probes === 0;
      const reason = first ? (nextHyp.owner_view ? `You think it's because ${voice(cf.claims.find(c => c.id === p.cause_claim)?.text ?? cause.label)}. Let me check that first, along with other possible causes.` : pb.reason) : null;
      return ask(`hyp:${p.id}:${nextHyp.key}`, "hypothesis", nextHyp.key, p, cause.question, reason);
    }
    closeProblem(cf, p.id, events);
  }

  // 4 · the industry, when nothing the owner said tells us
  if (!isKnown(fields.industry) && !get("fact:industry")) return ask("fact:industry", "fact", "industry", null, questionFor("industry", { ...profile, fields }), null);

  // 5 · what they'd like help with, when they haven't said
  const purpose = cf.problems.length > 0 || cf.claims.some(c => c.kind === "goal" && c.status !== "questioned");
  if (!purpose && !isKnown(fields.challenges) && !get("fact:challenges")) {
    return ask("fact:challenges", "fact", "challenges", null, "What would you most like help with: something that goes wrong, or something that takes up too much of your time?", null);
  }

  // 6 · the details that would change any other possible solution
  const o = gapAsk(() => true, "high");
  if (o) return o;

  // 7 · something the owner said that I didn't understand (kept verbatim): ask, at most twice per conversation
  const clarified = cf.agenda.filter(a => a.kind === "clarify").length;
  const unclear = (cf.unrecognised ?? []).find(u => u.status === "open" && !get(`clarify:${u.id}`));
  if (unclear && clarified < MAX_CLARIFY) return ask(`clarify:${unclear.id}`, "clarify", unclear.id, null, `You mentioned ${quote(unclear.text, 80)}. Could you tell me a bit more about that, so I understand how it fits?`, null);

  // 8 · anything else costing time or money (asked once, when the owner reported a problem)
  const reported = cf.problems.filter(p => !p.from_goal);
  if (reported.length && cf.problems.length < MAX_PROBLEMS && !get("other_problems")) {
    return ask("other_problems", "other_problems", "other", null, "Is anything else costing you time or money at the moment, for example orders, payments or staff?", null);
  }

  // 9 · details that improve a possible solution
  const m = gapAsk(() => true, "medium");
  if (m) return m;

  const r = caseReadiness(cf, fields);
  return { kind: "ready", byBudget: r.byBudget };
}

const REPHRASE: Partial<Record<ProfileFieldKey, string>> = {
  industry: "To be sure I understand: what does the business sell or do?",
  products_services: "Let me ask it another way: what are the main things customers buy from you?",
  customers_channels: "Put simply: where do most customers place their orders?",
  goals: "In one sentence, what would you most like to be different in a few months?",
  challenges: "Put simply: what's the one thing you'd most like to change?",
  suppliers: "Where do you buy your main supplies?",
  team_structure: "How many people work in the business, including you?",
  current_tools: "Do you use any app, notebook or spreadsheet to keep track of things?",
  daily_operations: "Roughly, what are your opening hours and busiest times?",
  business_name: "What name do customers know the business by?",
};

function rephraseFor(item: AgendaItem, cf: CaseFile, profile: ProfileDoc): string {
  if (item.kind === "fact") return REPHRASE[item.target as ProfileFieldKey] ?? questionFor(item.target as ProfileFieldKey, profile);
  if (item.kind === "gap") {
    const [ck] = item.target.split("|");
    const [cap, key] = ck.split(":");
    const gap = GAPS[cap as CapabilityKey]?.find(g => g.key === key);
    if (gap) return gap.rephrase(gapContext(cf));
  }
  if (item.kind === "opening") {
    const p = cf.problems.find(x => x.id === item.problem_id);
    const pb = playbookByKey(p?.playbook);
    if (pb?.opening) return pb.opening.rephrase;
  }
  if (item.kind === "hypothesis" || item.kind === "confirm_cause") {
    const p = cf.problems.find(x => x.id === item.problem_id);
    const cause = p ? causeOf(playbookByKey(p.playbook)!, item.target) : null;
    if (cause) return item.kind === "hypothesis" ? cause.rephrase : `Would you say the main reason is that ${cause.label}?`;
  }
  if (item.kind === "contradiction") {
    const c = cf.contradictions.find(x => `contra:${x.id}` === item.key);
    if (c) return `Just to be sure about the ${SLOT_LABEL[c.slot].toLowerCase()}: is it ${quote(c.a.value, 50)} or ${quote(c.b.value, 50)}?`;
  }
  if (item.kind === "other_problems") return "Is there any other problem you'd like help with?";
  if (item.kind === "clarify") return "Could you put that another way? I'd like to be sure I've understood it.";
  return "Could you say a little more about that?";
}

// ---- compose -------------------------------------------------------------------------------------------

/** "I want to automate my chat replies to my clients" → "automate your chat replies to your clients". */
const goalAsAction = (g: string) => {
  const m = g.match(/^(?:what )?(?:i|we)(?:'d| would)? (?:really |just |mainly |actually )?(?:want|like|love|hope|need)(?: is)? to (.+)$/i) ?? g.match(/^(?:my|our) goal is to (.+)$/i);
  return m ? voice(m[1]) : null;
};

/** Reflect what was understood from the owner's opening message, in their words (first turn only). */
function understoodLine(cf: ReturnType<typeof withP6>, events: TurnEvent[]): string[] {
  const out: string[] = [];
  const first = cf.owner.name?.value ? cf.owner.name.value.split(" ")[0] : null;
  const name = cf.facts.business_name?.value ?? null;
  const biz = cf.owner.business
    ? `${cf.owner.business.verb === "in" ? "You're in" : "You run"} ${voice(cf.owner.business.phrase)}${name && !cf.owner.business.phrase.includes(name) ? `, ${name}` : ""}`
    : cf.facts.industry?.value && industryWords(cf.facts.industry.value) ? `${name ? `${name} is` : "You're"} in ${industryWords(cf.facts.industry.value)}` : name ? `You run ${name}` : null;
  const goals = events.filter((e): e is { type: "goal"; text: string } => e.type === "goal").map(e => goalAsAction(e.text)).filter((x): x is string => !!x);
  const problems = events.filter((e): e is Extract<TurnEvent, { type: "problem" }> => e.type === "problem");
  const lead = first ? `Hi ${first}! ` : "Thanks. ";
  // "You're in real estate, and you'd like to automate…" / "You run a bakery in Abuja, and you spend hours…"
  const p0 = problems[0];
  if (biz && goals.length && !problems.length) out.push(`${lead}${biz}, and you'd like to ${goals[0]}.`);
  else if (biz && p0 && !p0.cause) out.push(`${lead}${biz}, and ${voice(p0.symptom)}.`);
  else if (biz) out.push(`${lead}${biz}.`);
  else if (first) out.push(`Hi ${first}!`);
  else out.push("Thanks.");
  return out;
}

/** A possible solution, named tentatively (never a commitment). */
function suggestionLine(cf: ReturnType<typeof withP6>, events: TurnEvent[], firstTurn: boolean): string | null {
  const fresh = events.filter((e): e is Extract<TurnEvent, { type: "need" }> => e.type === "need");
  const stated = fresh.find(e => e.status === "stated");
  const audience = cf.owner.audience ?? "customers";
  if (stated) {
    const agent = agentFor(stated.capability).name.toLowerCase();
    const duty = DUTY[stated.capability].replace("{audience}", audience);
    const typical = cf.inferences.find(i => i.key === "typical_topics" && i.status === "inferred");
    const industry = cf.facts.industry?.value ?? null;
    const topics = typical && industry && stated.capability === "customer_messaging"
      ? ` In ${industryWords(industry)} those are usually about ${TYPICAL_TOPICS[industry]}, but I'll check that rather than assume it.` : "";
    return `I'm thinking of ${/^[aeiou]/.test(agent) ? "an" : "a"} ${agent} that ${duty}.${topics}`;
  }
  // A problem whose fix is clear in kind (messages or orders): name it, but investigate first.
  const enq = cf.problems.find(p => p.playbook === "enquiries" && !p.from_goal && events.some(e => e.type === "problem" && e.problem === p.id));
  if (firstTurn && enq) {
    const caps = enquiryCapabilities(cf.claims.find(c => c.id === enq.symptom_claim)?.text ?? "");
    return `That's the kind of work ${agentList(caps)} could take on, but first I'd like to see where the time actually goes.`;
  }
  return null;
}

export function composeReply(cf0: CaseFile, events: TurnEvent[], plan: Plan, ctx: { firstTurn: boolean; name: string | null; alreadyReady?: boolean }): string {
  const cf = withP6(cf0);
  const lines: string[] = [];
  const pb = (pid: string) => playbookByKey(cf.problems.find(p => p.id === pid)?.playbook);
  const label = (pid: string, key: string) => { const b = pb(pid); return b ? causeOf(b, key)?.label ?? key : key; };
  if (ctx.firstTurn) lines.push(...understoodLine(cf, events));
  else if (events.some(e => e.type === "owner_name")) lines.push(`Nice to meet you, ${(cf.owner.name?.value ?? "").split(" ")[0]}.`);
  const firstGoalReflected = ctx.firstTurn && !!cf.owner.business && events.some(e => e.type === "goal" && goalAsAction(e.text)) && !events.some(e => e.type === "problem");
  const firstProblemReflected = ctx.firstTurn && events.some(e => e.type === "problem" && !e.cause) && !!(cf.owner.business || cf.facts.industry?.value || cf.facts.business_name?.value);
  let problemSeen = false;
  for (const e of events) {
    switch (e.type) {
      case "problem":
        if (e.cause) lines.push(`${ctx.firstTurn ? upperFirst(voice(e.symptom)) : `I've noted that ${voice(e.symptom)}`}, and ${ctx.firstTurn ? "" : "that "}you think it's because ${voice(e.cause)}. I'll treat that as your view for now, not a conclusion.`);
        else if (e.recognised && !(firstProblemReflected && !problemSeen)) lines.push(`I've noted the problem: ${voice(e.symptom)}.`);
        problemSeen = true;
        break;
      case "supported": {
        const all = events.filter((x): x is { type: "supported"; problem: string; cause: string } => x.type === "supported" && x.problem === e.problem);
        if (all.length === 1) lines.push(`That points to one possible cause: ${label(e.problem, e.cause)}.`);
        else if (all[0] === e) lines.push(`That points to ${all.length === 2 ? "two" : "several"} possible causes: ${all.map(x => label(x.problem, x.cause)).join("; and ")}. Let's take them one at a time.`);
        break;
      }
      case "ruled_out": lines.push(`So it's probably not that ${label(e.problem, e.cause)}.`); break;
      case "confirmed": {
        const p = cf.problems.find(x => x.id === e.problem)!;
        const caps = causeCapabilities(cf, p, e.cause);
        lines.push(`Thanks. I'll record that as the cause, confirmed by you: ${label(e.problem, e.cause)}.${caps.length ? ` That's work ${agentList(caps)} could take on; I'll weigh it up in the analysis.` : ""}`);
        break;
      }
      case "denied": lines.push("Understood, I'll rule that out."); break;
      case "closed": {
        const p = cf.problems.find(x => x.id === e.problem);
        if (p?.resolution === "unknown") lines.push(`I can't pin down the cause from what we've covered, so I'll mark it as unknown rather than guess. ${p.uncertainty ?? ""}`.trim());
        else if (p?.resolution === "cause_supported") lines.push(p.uncertainty ?? "");
        break;
      }
      case "correction": lines.push(`Thanks for the correction: ${SLOT_LABEL[e.slot].toLowerCase()} is now ${quote(e.to, 60)} (before: ${quote(e.from, 60)}).`); break;
      case "contradiction": {
        // Asked about straight away (the question explains it), or acknowledged now and asked later.
        const x = cf.contradictions.find(c => c.id === e.id);
        if (x && !(plan.kind === "ask" && plan.item.key === `contra:${x.id}`))
          lines.push(`I've noted ${quote(x.b.value, 50)}, which differs from the ${quote(x.a.value, 50)} you mentioned earlier. I'll check which is right before the summary.`);
        break;
      }
      case "contradiction_resolved": lines.push(`Got it: ${SLOT_LABEL[e.slot].toLowerCase()} is ${quote(e.value, 60)}.`); break;
      case "goal": if (!firstGoalReflected) lines.push(`Understood, your goal is ${quote(e.text, 140)}.`); break;
      case "goal_changed": { const a = goalAsAction(e.text); lines.push(`${a ? `Got it: what you really want is to ${a}.` : `Got it: your goal is now ${quote(e.text, 120)}.`} I'll work from that instead.`); break; }
      case "need_rejected": lines.push(`Understood, I won't suggest ${agentList([e.capability])}.`); break;
      case "topics": lines.push(e.verdict === true ? "Good, that's what I'll plan around." : e.verdict === false ? "Thanks, I won't assume that then." : "Thanks, that tells me what it would need to answer."); break;
      case "unrecognised": break;                                                 // one line below
      case "owner_name": case "need": case "fact": break;                         // handled below
      case "declined": lines.push("No problem, I'll treat that as unknown."); break;
      case "elsewhere": lines.push("I've noted that where it belongs."); break;
      case "unclassified": if (!events.some(x => x.type === "unrecognised")) lines.push("I'm not sure how that fits yet."); break;
    }
  }
  // Say where each new fact was filed, so a misfiling is visible to the owner. On the first turn only the
  // team size is echoed (an opening message carries many facts; the panel shows them all).
  const noted = events.flatMap(e => e.type === "fact" && e.slot !== "industry" && e.slot !== "team_structure" && e.slot !== "business_name" && (!ctx.firstTurn || e.slot === "team_size")
    ? [`${e.slot === "customers_channels" ? `how your ${cf.owner.audience ?? "customers"} reach you` : SLOT_LABEL[e.slot].toLowerCase()} ${quote(e.value, 60)}`] : []);
  const onlyChannel = events.filter(e => e.type === "fact" && !ctx.firstTurn && e.slot !== "industry");
  if (onlyChannel.length === 1 && onlyChannel[0].type === "fact" && onlyChannel[0].slot === "customers_channels")
    lines.push(`Got it: your ${cf.owner.audience ?? "customers"} reach you on ${onlyChannel[0].value}.`);
  else if (noted.length) lines.push(`Noted: ${noted.slice(0, 3).join("; ")}.`);
  const unrec = events.find((e): e is Extract<TurnEvent, { type: "unrecognised" }> => e.type === "unrecognised");
  if (unrec && !(plan.kind === "ask" && plan.item.kind === "clarify")) lines.push(`I'm not sure how that fits yet, so I've kept a note of it as you said it: ${quote(unrec.text, 90)}.`);
  const suggestion = suggestionLine(cf, events, ctx.firstTurn);
  if (suggestion) lines.push(suggestion);
  const lead = [...new Set(lines.filter(Boolean))].slice(0, 5).join(" ").replace(/\?/g, ".");
  if (plan.kind === "ask") {
    // Don't restate the owner's explanation when this same reply has just acknowledged it.
    const restated = plan.reason?.startsWith("You think it's because") && events.some(e => e.type === "problem" && e.cause);
    let reason = restated ? "Let me check your explanation first, along with other possible causes." : plan.reason;
    if (suggestion && plan.item.kind !== "gap") reason = null;                  // the suggestion already says why
    const why = reason ? `${reason} ` : "";
    // "That points to one possible cause: X." already names X, so the confirmation needn't repeat it.
    const supportedNow = events.filter(e => e.type === "supported");
    const named = plan.item.kind === "confirm_cause" && supportedNow.length === 1 && supportedNow.some(e => e.type === "supported" && e.cause === plan.item.target);
    if (named) return `${lead}${lead ? " " : ""}Is that the main reason, in your experience?`.trim();
    return `${lead ? lead + "\n\n" : ""}${why}${plan.text}`.trim();
  }
  // Already summarised: a short acknowledgement instead of repeating the whole picture.
  if (ctx.alreadyReady) return `${lead ? lead + " " : "Noted. "}Add anything else you'd like, or choose “Analyse my business” when you're ready.`;
  const summary = cf.problems.map(p => {
    const sym = cf.claims.find(c => c.id === p.symptom_claim)?.text ?? "";
    const b = playbookByKey(p.playbook);
    const conf = p.hypotheses.find(h => h.status === "confirmed");
    if (conf && b) return p.from_goal ? `Behind ${quote(sym, 80)}: ${causeOf(b, conf.key)!.label}, as you confirmed.` : `${quote(sym, 70)}: the cause, confirmed by you, is that ${causeOf(b, conf.key)!.label}.`;
    return p.uncertainty ?? `${quote(sym, 70)}: cause still unknown.`;
  });
  const considering = cf.solutions.filter(s => s.status === "considering");
  const solutionsLine = considering.length ? `Worth looking at in the analysis: ${agentList(considering.map(s => s.capability))}. Nothing is decided until you review the team.` : "";
  const fields = fieldsView(cf, {} as ProfileDoc["fields"]);
  const missing = ESSENTIAL_FIELDS.filter(k => !isKnown(fields[k])).map(k => FIELD_LABELS[k].toLowerCase());
  const declinedGaps = cf.agenda.filter(a => a.kind === "gap" && (a.status === "declined" || a.status === "dropped")).map(a => GAP_LABEL[a.target.split("|")[0].split(":")[1]] ?? "a detail");
  // Only claim a clear picture when there is one: essentials known and no problem left with an unknown cause.
  const clear = !missing.length && !cf.problems.some(p => p.resolution === "unknown") && !declinedGaps.length;
  const head = plan.byBudget ? "I've reached my question limit, so I'll stop here and list what's still uncertain rather than guess."
    : clear ? "I think I have a clear enough picture to analyse the business."
    : "That's as far as I can get by asking, so I'll stop here rather than guess. The analysis will only build on what you've told me.";
  const openContra = cf.contradictions.filter(c => c.status === "open").map(c => `the ${SLOT_LABEL[c.slot].toLowerCase()} (${quote(c.a.value, 40)} or ${quote(c.b.value, 40)})`);
  const still = [...missing, ...new Set(declinedGaps), ...openContra];
  const unknownLine = still.length ? `Still unknown: ${still.join("; ")}. You can add these in the summary.` : "";
  return [lead, head, ...summary, solutionsLine, unknownLine, "Choose “Analyse my business” when you're ready, or add anything else first."].filter(Boolean).join("\n\n").replace(/\?/g, ".");
}

const GAP_LABEL: Record<string, string> = { channel: "which platform your clients use", topics: "what clients ask about most", products: "what you sell", suppliers: "your suppliers" };

// ---- one whole turn (pure) ------------------------------------------------------------------------------

export type TurnResult = { caseFile: CaseFile; fields: ProfileDoc["fields"]; reply: string; questionField: ProfileFieldKey | null; plan: Plan; events: TurnEvent[] };

export function runTurn(profile: ProfileDoc, cf0: CaseFile, it: Interpretation, ownerIds: ReadonlySet<string>, ctx: { firstTurn: boolean }, now = new Date().toISOString()): TurnResult {
  const alreadyReady = cf0.questions_asked > 0 && !cf0.pending && caseReadiness(cf0, fieldsView(cf0, profile.fields)).ready;
  const { caseFile, events } = applyInterpretation(cf0, it, ownerIds, now);
  const plan = planNext(caseFile, profile, events);
  const fields = fieldsView(caseFile, profile.fields);
  const name = caseFile.facts.business_name?.value ?? null;
  const reply = composeReply(caseFile, events, plan, { firstTurn: ctx.firstTurn, name, alreadyReady: alreadyReady && plan.kind === "ready" });
  const questionField = plan.kind === "ask" && plan.item.kind === "fact" ? plan.item.target as ProfileFieldKey : null;
  return { caseFile, fields, reply, questionField, plan, events };
}

/** Profile bookkeeping kept for M2 consumers (asked / skipped / last question). */
export function legacyBookkeeping(cf: CaseFile): Pick<ProfileDoc, "asked" | "skipped" | "last_question_field"> {
  const facts = cf.agenda.filter(a => a.kind === "fact" && a.asked > 0);
  const pending = cf.pending ? cf.agenda.find(a => a.key === cf.pending) : null;
  return {
    asked: facts.map(a => a.target as ProfileFieldKey),
    skipped: facts.filter(a => a.status === "declined").map(a => a.target as ProfileFieldKey),
    last_question_field: pending?.kind === "fact" ? pending.target as ProfileFieldKey : null,
  };
}

/** Live-model output (M2 schema) as an interpretation: facts only. Investigation in live mode is P5. */
export function legacyInterpretation(facts: Array<{ field: ProfileFieldKey; value: string; status: "confirmed" | "assumed"; source_message_ids: string[] }>, skipped: ProfileFieldKey[], pendingField: ProfileFieldKey | null): Interpretation {
  return {
    facts: facts.filter(f => f.field !== "challenges" && f.field !== "goals").map(f => ({ slot: f.field, value: f.value, status: f.status, sources: f.source_message_ids.slice(0, 5), correction: false, direct: f.field === pendingField })),
    claims: facts.filter(f => f.field === "challenges" || f.field === "goals").map((f, i) => ({ ref: `l${i}`, kind: f.field === "goals" ? "goal" as const : "symptom" as const, text: f.value, sources: f.source_message_ids.slice(0, 5), cause_of: null, correction: false })),
    answer: pendingField ? (skipped.includes(pendingField) ? "declined" : facts.some(f => f.field === pendingField) ? "answered" : "unanswered") : null,
    signals: [], unclassified: [],
    owner_name: null, business: null, audience: null, needs: [], gap_answer: null, topics_verdict: null, unrecognised: [],
  };
}

export { type Playbook };
