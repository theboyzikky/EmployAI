// M3.5 · Offline interpretation (AI_PROVIDER=mock). Reads the WHOLE of each new owner message (P6):
// who the owner is, the business in their own words, goals, problems and their stated causes, the
// needs those signal, facts, and how the message relates to the question that was pending.
// Deterministic, no network. It never decides what is true: reasoning.ts applies the interpretation
// under code-owned rules.
//
// Rules:
// - a reply is filed under the pending question ONLY if it doesn't clearly belong somewhere else;
// - "X because Y" keeps the link: symptom X, and the owner's view that Y is the cause;
// - the vocabulary is not a hard limit (S9): a statement it doesn't recognise is kept VERBATIM and
//   reported, never discarded and never stuffed into a field.
import type { CaseFile, FactSlot } from "@/lib/discovery/casefile";
import { emptyInterpretation, type Interpretation } from "@/lib/discovery/interpretation";
import { MESSAGE_WORDS, audienceIn, businessPhraseIn, industryOfPhrase, needsIn, ownerNameIn, rejectsNeed } from "@/lib/discovery/needs";
import { causeOf, matchPlaybook, playbookByKey, statesCause, NO, PARTLY, YES } from "@/lib/discovery/playbooks";
import type { ProfileFieldKey } from "@/lib/discovery/profile";
import { upperFirst } from "@/lib/text";
import { CHANNELS, GOAL_RE, PAIN_RE, extractFacts, extractFromAnswer, industryOf, isSkipLike } from "./extract";

export type InterpretContext = {
  caseFile: CaseFile;
  transcript: Array<{ id: string; role: "user" | "assistant"; content: string }>;
  newOwnerMessageIds: string[];
  firstTurn: boolean;
};

const CORRECTION = /^(?:actually|sorry|correction|i meant|to correct|wait|oops|no,? (?:actually|sorry|wait))\b/i;
const CAUSAL = /^(.*?)[,;]?\s+\b(?:because|since|due to|caused by|as a result of)\b\s+(.+)$/i;
const SO_THAT_EFFECT = /^(.+?),?\s+\bso\b\s+(?!that\b)(.+)$/i;
const NOTHING_ELSE = /^(?:no|nope|nothing|that'?s (?:it|all)|not really|no,? (?:that'?s|nothing))\b/i;
const SOLO = /\b(?:just me|only me|on my own|by myself|i do everything (?:myself|alone)|i work alone|it'?s just me)\b/i;
const COUNT = /\b(\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|twelve|a few)\s+(?:full[- ]time\s+|part[- ]time\s+)?(?:staff|employees|people|workers|baristas|stylists|chefs|cooks|waiters|assistants|team members|helpers|agents)\b/i;
const RELATIVES = /\bmy (?:wife|husband|partner|sister|brother|son|daughter|mother|mum|mom|father|dad|cousin|friend|aunt|uncle)\b/gi;
const ME = /^\s*me\b|\b(?:me|myself)\s*(?:,|and\b)/i;   // the owner listed as one of the team
const WORDS: Record<string, string> = { one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10", twelve: "12" };
/** Greetings and small talk: nothing to keep. */
const SMALL_TALK = /^(?:hello|hi|hey|good (?:morning|afternoon|evening)|thanks?(?: you)?|thank you|ok(?:ay)?|great|cool|sure|alright|nice to meet you)[\s!,.]*$/i;
/** A goal that asks for a specific activity to be handled, not just a wish ("more profit"). */
const ACTION_GOAL = /\b(?:automat\w*|handle|handling|take care of|answer\w*|repl(?:y|ies|ying)|respond\w*|manag\w+|track\w*|keep track|take (?:orders|bookings)|send (?:reminders|replies)|stop (?:phoning|calling|chasing|missing|running out|losing track)|help (?:me|us) with)\b/i;

const sentencesOf = (t: string) => t.split(/(?<=[.!?;])\s+|\n+/).map(s => s.trim()).filter(Boolean);
/** "4 staff and customers order on WhatsApp" → "4 staff": a team description stops at the next clause. */
const firstClause = (s: string) => s.split(/,\s*(?:and|but)\s+|\s+(?:and|but)\s+(?=(?:customers?|clients?|orders?|we|i|they|our|my|people)\b)/i)[0].trim();
/** The team as the owner described it: "Me, my sister and two cooks", not just the matched "two cooks". */
const teamText = (matched: string, t: string) => {
  const listed = sentencesOf(t).find(s => ME.test(s));
  return listed ? clean(firstClause(listed)) : firstClause(matched);
};
/** "We take orders on WhatsApp, and we often run out" → separate statements, so each is judged on its own. */
const partsOf = (s: string) => s.split(/,\s*(?:and|but)\s+|\s+and\s+(?=(?:i|we|they|my|our|sometimes|often|also|clients?|customers?|people|staff)\b)/i).map(x => x.trim()).filter(x => x.length > 2);
/** Platforms the owner says they're on ("I also use Instagram"), outside any supplier context. */
const SOCIAL = new Set(["WhatsApp", "Instagram", "Facebook", "TikTok"]);
const ON_PLATFORM = /\b(?:use|using|on|via|through|also)\b/i;
/** Words for what clients ask about (prices, availability, viewings…): two in one sentence describe the topics. */
const TOPIC_WORDS = /\b(?:prices?|pricing|costs?|fees?|availab\w*|still (?:available|there)|viewings?|inspections?|locations?|menu|delivery|opening hours|slots?|schedules?|bookings?|stock|sizes?|payment plans?)\b/gi;
/** Problems no playbook covers, so the consultant can say honestly that it doesn't recognise them. */
const GENERIC_PROBLEM = /\b(keeps? (?:quitting|leaving|failing|breaking|complaining)|(?:staff|people|customers) (?:keep )?(?:quit|leave|complain)|problem|issue|struggl\w*|difficult|hard to|can'?t (?:find|keep|get|afford)|losing (?:customers|staff)|complain\w*)\b/i;
/** A stated negative outcome: what turns a pain word ("late", "manually") into a problem the owner reports. */
const NEGATIVE_OUTCOME = /\b(?:problem|issue|struggl\w*|difficult|hard to|too (?:long|slow|late|much|many)|keeps?|kept|always|never|forget\w*|forgot|miss(?:es|ed|ing)?|lose|losing|lost|wast\w*|mistakes?|errors?|takes? (?:up )?(?:hours|ages|forever|too long)|spend(?:s|ing)? (?:hours|ages)|can'?t|cannot|headache|nightmare|stress\w*|overwhelm\w*|late (?:payments?|deliveries|orders))\b/i;
const TIMEY = /\b(?:every|months?|weeks?|days?|hours?|yesterday|today|someone|sometimes|usually|always|never)\b/i;
/** A reply to the goals / problems question is filed there only if it reads like a goal / a problem
 *  ("Jollof rice, fried rice and grilled chicken" is neither: it is kept verbatim and asked again). */
const GOALISH = /\b(?:want|wish|hope|need|like to|love to|stop|save|saving|more|less|fewer|grow|reduce|increase|cut|faster|quicker|better|automate|help|handle|take care|focus|spend|free|profit|never|avoid|easier|track|sell|expand|improve|get|make|keep)\b/i;
const PROBLEMISH = /\b(?:too|lose|losing|lost|wast\w*|late|slow|miss\w*|run(?:ning)? out|ran out|expensive|hard|difficult|can'?t|cannot|don'?t|never|forget\w*|forgot|mistakes?|stress\w*|busy|short|behind|wrong|bad|spoil\w*|delay\w*|confus\w*)\b/i;
/** A last-resort reply must at least look like an answer to this field before it is filed there. */
const PLAUSIBLE: Partial<Record<ProfileFieldKey, (t: string) => boolean>> = {
  products_services: t => !TIMEY.test(t) && !/^(?:it|they|he|she|someone|my|our|i|we)\b/i.test(t),
  customers_channels: t => t.split(/\s+/).length <= 8,
  business_name: t => t.split(/\s+/).length <= 6 && !TIMEY.test(t),
  industry: t => t.split(/\s+/).length <= 8,
  team_structure: t => /\b(?:people|staff|cooks?|chefs?|waiters?|sister|brother|wife|husband|family|me|alone|partner|helpers?|team)\b/i.test(t),
  suppliers: t => /\b(?:market|suppliers?|wholesale\w*|buy|from|deliver\w*|order)\b/i.test(t) || t.split(/\s+/).length <= 6,
  current_tools: t => t.split(/\s+/).length <= 10,
  daily_operations: t => /\b(?:open|close|am|pm|morning|afternoon|evening|night|day|hours?|shifts?|until|from)\b/i.test(t),
};
const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const clean = (s: string) => s.replace(/^[\s,;:-]+|[\s.,;:!?]+$/g, "").replace(/\s+/g, " ").trim();

/** "Just you (no staff)", "4 staff", or null. Used to detect contradictions about team size. */
export function teamSize(text: string): string | null {
  if (SOLO.test(text)) return "Just you (no staff)";
  // "Me, my sister and two cooks" is four people, not "2 staff".
  const relatives = text.match(RELATIVES)?.length ?? 0;
  const me = ME.test(text) ? 1 : 0;
  const m = text.match(COUNT);
  if (!m) return me && relatives ? `${me + relatives} people including you` : null;
  const n = WORDS[m[1].toLowerCase()] ?? m[1].toLowerCase();
  if (n === "a few") return "A few staff";
  if (me) return `${Number(n) + relatives + 1} people including you`;
  return `${Number(n) + relatives} staff`;
}

/** Fields an answer can be "dumped" into only when nothing else in the reply claims it. */
const FREE_TEXT: ProfileFieldKey[] = ["products_services", "daily_operations", "suppliers", "current_tools", "customers_channels", "team_structure", "business_name", "industry"];

export function interpretOffline(ctx: InterpretContext): Interpretation {
  const out = emptyInterpretation();
  const cf = ctx.caseFile;
  const byId = new Map(ctx.transcript.map(m => [m.id, m]));
  const pending = cf.pending ? cf.agenda.find(a => a.key === cf.pending && a.status === "open") ?? null : null;
  const pendingProblem = pending?.problem_id ? cf.problems.find(p => p.id === pending.problem_id) ?? null : null;
  const pendingPlaybook = playbookByKey(pendingProblem?.playbook);
  let ref = 0;

  ctx.newOwnerMessageIds.forEach((id, idx) => {
    const msg = byId.get(id);
    if (!msg || msg.role !== "user") return;
    const t = msg.content.replace(/\s+/g, " ").trim();
    const answering = idx === 0 && !ctx.firstTurn ? pending : null;   // only the first new message answers the question
    const correction = CORRECTION.test(t);
    const src = [id];
    const before = { facts: out.facts.length, claims: out.claims.length, signals: out.signals.length, needs: out.needs.length };
    if (answering && isSkipLike(t)) { out.answer = "declined"; return; }

    // ---- who, and the business in the owner's own words ------------------------------------------
    const name = ownerNameIn(t);
    if (name && !out.owner_name) out.owner_name = { value: name, sources: src };
    const phrase = businessPhraseIn(t);
    // The industry: known already; else from the owner's description of the business itself ("drone
    // mapping for construction sites" is not construction); else any industry word in the message.
    const phraseIndustry = phrase ? industryOfPhrase(phrase.phrase) : null;
    const industry = cf.facts.industry?.value ?? (phrase ? phraseIndustry : industryOf(t));
    if (phrase && !out.business) out.business = { ...phrase, sources: src };
    out.audience ??= audienceIn(t);

    // ---- claims: symptoms, the owner's causal explanations, goals ---------------------------------
    const diagnosing = answering && (answering.kind === "hypothesis" || answering.kind === "confirm_cause" || answering.kind === "contradiction" || answering.kind === "opening");
    // A neutral statement ("we open late on Sundays", "I do the books in a notebook") never opens a problem on
    // its own: a pain word counts only with a stated negative outcome, or as the answer to "what would you
    // most like help with".
    const answeringHelp = answering?.kind === "fact" && answering.target === "challenges";
    const allowPainOnly = !diagnosing;
    const isSymptom = (s: string) => {
      const pb = matchPlaybook(s, industry);
      // While diagnosing problem P, sentences about P are evidence, not a new problem.
      if (pb && pendingPlaybook && pb.key === pendingPlaybook.key && diagnosing) return false;
      return !!pb || (allowPainOnly && (GENERIC_PROBLEM.test(s) || (PAIN_RE.test(s) && (NEGATIVE_OUTCOME.test(s) || answeringHelp))) && !GOAL_RE.test(s));
    };
    const claim = (kind: "symptom" | "cause" | "goal", text: string, cause_of: string | null = null) => {
      const r = `r${++ref}`;
      out.claims.push({ ref: r, kind, text, sources: src, cause_of, correction: correction && kind === "goal" });
      return r;
    };
    for (const s of sentencesOf(t)) {
      const c = s.match(CAUSAL);
      if (c && clean(c[1]) && clean(c[2])) {
        const effect = clean(c[1]), cause = clean(c[2]);
        // Each statement before "because" is judged on its own; the cause explains the nearest symptom.
        const parts = partsOf(effect);
        const symptoms = parts.filter(isSymptom);
        if (symptoms.length || matchPlaybook(cause, industry)) {
          const list = symptoms.length ? symptoms : [parts.at(-1) ?? effect];
          let last = "";
          for (const p of list) last = claim("symptom", clean(p));
          claim("cause", cause, last);
          continue;
        }
      }
      const so = s.match(SO_THAT_EFFECT);
      if (so && clean(so[1]) && clean(so[2]) && isSymptom(clean(so[2])) && !GOAL_RE.test(s)) {
        const sym = claim("symptom", clean(so[2]));
        claim("cause", clean(so[1]), sym);
        continue;
      }
      const g = s.match(GOAL_RE);
      if (g) { claim("goal", clean(s.slice(g.index))); continue; }
      // A recognised problem is kept as its own clause; an unrecognised one keeps the whole sentence, so no
      // context is lost ("Everyone wants a quote before a job and I write each one by hand").
      const parts = partsOf(s).filter(isSymptom);
      if (parts.length && parts.every(p => !matchPlaybook(p, industry))) claim("symptom", clean(s));
      else for (const p of parts) claim("symptom", clean(p));
    }

    // ---- facts (typed slots); challenges and goals are claims, not facts ---------------------------
    const found = extractFacts(t).filter(f => f.field !== "challenges" && f.field !== "goals")
      // "My name is Isaac" names the owner, not the business.
      .filter(f => !(f.field === "business_name" && name && norm(f.value).startsWith(norm(name.split(" ")[0]))))
      // The industry comes from the business's own description when there is one.
      .filter(f => !(f.field === "industry" && phrase && f.value !== phraseIndustry));
    if (phrase && phraseIndustry && !found.some(f => f.field === "industry")) found.push({ field: "industry", value: phraseIndustry, status: "confirmed" });
    // "I also use Instagram": a platform the owner is on counts as a way customers reach them.
    if (!found.some(f => f.field === "customers_channels")) {
      const on = sentencesOf(t).filter(s => ON_PLATFORM.test(s) && !/\bsuppliers?\b|\breorder|\bwholesal/i.test(s));
      const named = [...new Set(CHANNELS.filter(([re, v]) => SOCIAL.has(v) && on.some(s => re.test(s))).map(([, v]) => v))];
      if (named.length) found.push({ field: "customers_channels", value: named.join(", "), status: "confirmed" });
    }
    const size = teamSize(t);
    for (const f of found) out.facts.push({ slot: f.field, value: f.field === "team_structure" ? teamText(f.value, t) : f.value, status: f.status, sources: src, correction, direct: answering?.kind === "fact" && answering.target === f.field });
    if (size) out.facts.push({ slot: "team_size" as FactSlot, value: size, status: "confirmed", sources: src, correction, direct: answering?.kind === "contradiction" || (answering?.kind === "fact" && answering.target === "team_structure") });
    // S9: a business the vocabulary doesn't know is kept in the owner's words, not dropped or re-asked.
    if (!phraseIndustry && !cf.facts.industry?.value && phrase && !found.some(f => f.field === "industry")) {
      const desc = upperFirst(phrase.phrase.replace(/^(?:a|an|my|our|the)\s+/i, "").replace(/^(?:small|little|tiny|family)\s+/i, ""));
      out.facts.push({ slot: "industry", value: desc, status: "confirmed", sources: src, correction: false, direct: false });
    }

    // ---- needs: what a goal asks for (stated) or a problem calls for (implied) ----------------------
    for (const c of out.claims.slice(before.claims)) {
      const stated = c.kind === "goal";
      if (stated && !ACTION_GOAL.test(c.text)) continue;          // "more profit" is a wish, not a request to automate
      for (const n of needsIn(c.text)) out.needs.push({ capability: n.capability, label: n.label, status: stated ? "stated" : "implied", from_ref: c.ref, sources: src });
    }
    if (rejectsNeed(t)) for (const n of needsIn(t)) out.needs.push({ capability: n.capability, label: n.label, status: "rejected", from_ref: null, sources: src });

    // ---- relation to the pending question ---------------------------------------------------------
    if (answering) {
      // Only NEW information counts as "the reply was about something else" (re-mentioning a known fact doesn't).
      const known = (slot: string, value: string) => { const k = cf.facts[slot as FactSlot]; return !!k?.value && norm(k.value) === norm(value); };
      const somethingElse = out.facts.slice(before.facts).some(f => !known(f.slot, f.value)) || out.claims.length > before.claims;
      const factAnswer = (field: ProfileFieldKey) => {
        if (field === "challenges") {
          out.answer = out.claims.some(c => c.kind === "symptom") ? "answered" : somethingElse ? "partly" : "unanswered";
          if (out.answer === "unanswered" && t.length > 3 && (PROBLEMISH.test(t) || GENERIC_PROBLEM.test(t))) { claim("symptom", clean(t)); out.answer = "answered"; }
        } else if (field === "goals") {
          out.answer = out.claims.some(c => c.kind === "goal") ? "answered" : somethingElse ? "partly" : "unanswered";
          if (out.answer === "unanswered" && t.length > 3 && GOALISH.test(t)) { claim("goal", clean(t)); out.answer = "answered"; }
        } else if (out.facts.some(f => f.slot === field || (field === "team_structure" && f.slot === "team_size"))) {
          out.answer = "answered";
          for (const f of out.facts) if (f.slot === field) f.direct = true;
        } else if (!somethingElse && FREE_TEXT.includes(field) && (PLAUSIBLE[field]?.(t) ?? true)) {
          // Nothing else claims this reply, so it is the answer (the old behaviour, now only as a last resort).
          const direct = extractFromAnswer(t, field).facts.find(f => f.field === field);
          if (direct) { out.facts.push({ slot: field, value: direct.value, status: direct.status, sources: src, correction, direct: true }); out.answer = "answered"; }
          else out.answer = "unanswered";
        } else {
          out.answer = somethingElse ? "partly" : "unanswered";   // it answered something else: the question stays open
        }
      };
      // Evidence for causes of the problem being investigated. The OPEN question ("what is driving this?")
      // may point to any cause through its broad patterns; otherwise a cause that wasn't asked about needs
      // a direct statement of that cause (statesCause), never a passing word.
      const causeSignals = (only: string | null, openQuestion: boolean) => {
        const pb = pendingPlaybook;
        if (!pb || !pendingProblem) return;
        for (const k of pb.causes) {
          if (only && k.key === only) continue;
          const hyp = pendingProblem.hypotheses.find(h => h.key === k.key);
          const evidence = openQuestion ? k.supports.test(t) : statesCause(pb, k.key, t);
          if (hyp?.status === "open" && evidence && !k.refutes?.test(t)) out.signals.push({ playbook: pb.key, cause: k.key, effect: "supports", sources: src });
        }
      };
      switch (answering.kind) {
        case "fact": factAnswer(answering.target as ProfileFieldKey); break;
        case "gap": {
          const [ck, slot] = answering.target.split("|");
          const gapKey = ck.split(":")[1];
          if (gapKey === "channel") {
            // A short answer like "Mostly WhatsApp" names the platform without any ordering words.
            const named = [...new Set(CHANNELS.filter(([re]) => re.test(t)).map(([, v]) => v))];
            if (named.length) {
              const existing = out.facts.find(f => f.slot === "customers_channels");
              if (existing) { existing.direct = true; existing.value = [...new Set([...existing.value.split(/\s*,\s*/), ...named])].join(", "); }
              else out.facts.push({ slot: "customers_channels", value: named.join(", "), status: "confirmed", sources: src, correction, direct: true });
              out.answer = "answered";
            } else out.answer = somethingElse ? "partly" : "unanswered";
          } else if (gapKey === "topics") {
            if (YES.test(t) && !/\bbut\b|\bexcept\b|\balso\b/i.test(t)) { out.topics_verdict = true; out.answer = "answered"; }
            else {
              if (NO.test(t)) out.topics_verdict = false;
              const rest = clean(t.replace(/^(?:no|nope|not really|yes|yeah|mostly)[,.!]?\s*/i, ""));
              if (rest.split(/\s+/).length >= 2) out.gap_answer = { key: ck, text: rest.slice(0, 400), sources: src };
              out.answer = out.topics_verdict !== null || out.gap_answer ? "answered" : "unanswered";
            }
          } else if (slot) factAnswer(slot as ProfileFieldKey);
          else if (t.split(/\s+/).length >= 2) { out.gap_answer = { key: ck, text: clean(t).slice(0, 400), sources: src }; out.answer = "answered"; }
          break;
        }
        case "opening": {
          // One open question that can point to several causes at once.
          causeSignals(null, true);
          out.answer = out.signals.length > before.signals ? "answered" : PARTLY.test(t) || somethingElse ? "partly" : "unanswered";
          break;
        }
        case "hypothesis": {
          const pb = pendingPlaybook, cause = pb ? causeOf(pb, answering.target) : null;
          if (pb && cause) {
            const s = cause.supports.test(t), r = !!cause.refutes?.test(t);
            let effect: "supports" | "refutes" | null = s && !r ? "supports" : r && !s ? "refutes" : null;
            if (!effect && !s && !r && cause.yes) effect = YES.test(t) ? cause.yes : NO.test(t) ? (cause.yes === "supports" ? "refutes" : "supports") : null;
            if (effect) out.signals.push({ playbook: pb.key, cause: cause.key, effect, sources: src });
            // The same answer can point to other possible causes too.
            causeSignals(cause.key, false);
            out.answer = effect ? "answered" : out.signals.length > before.signals || PARTLY.test(t) ? "partly" : "unanswered";
          }
          break;
        }
        case "confirm_cause": {
          const pb = pendingPlaybook;
          if (pb) {
            if (YES.test(t)) { out.signals.push({ playbook: pb.key, cause: answering.target, effect: "confirms", sources: src }); out.answer = "answered"; }
            else if (NO.test(t)) { out.signals.push({ playbook: pb.key, cause: answering.target, effect: "denies", sources: src }); out.answer = "answered"; }
            else {
              // Not a yes or no, but the owner may describe evidence for other possible causes.
              causeSignals(answering.target, false);
              out.answer = PARTLY.test(t) || out.signals.length > before.signals ? "partly" : "unanswered";
            }
          }
          break;
        }
        case "contradiction":
          out.answer = out.facts.some(f => f.slot === answering.target || (answering.target === "team_size" && f.slot === "team_structure")) ? "answered" : "unanswered";
          break;
        case "other_problems":
          out.answer = out.claims.some(c => c.kind === "symptom") || NOTHING_ELSE.test(t) || somethingElse ? "answered" : "unanswered";
          break;
        case "describe_problem":
          if (t.length > 3) { claim("symptom", clean(t)); out.answer = "answered"; }
          break;
        case "clarify":
          if (t.length > 3) { out.gap_answer = { key: `clarify:${answering.target}`, text: clean(t).slice(0, 400), sources: src }; out.answer = "answered"; }
          break;
      }
    }

    // ---- continuous understanding: a DIRECT statement about an open enquiries problem counts, whatever was asked ----
    for (const p of cf.problems) {
      if (p.playbook !== "enquiries" || p.resolution !== "open" || p.id === pendingProblem?.id) continue;
      const pb = playbookByKey(p.playbook)!;
      for (const k of pb.causes) {
        const hyp = p.hypotheses.find(h => h.key === k.key);
        if (hyp?.status === "open" && statesCause(pb, k.key, t) && !k.refutes?.test(t) && !out.signals.some(s => s.cause === k.key)) out.signals.push({ playbook: pb.key, cause: k.key, effect: "supports", sources: src });
      }
    }

    // ---- what clients ask about, when the owner has already said it (never ask it again) ----------------
    const typicalOpen = (cf.inferences ?? []).some(i => i.key === "typical_topics" && i.status === "inferred") && !cf.gap_answers?.["customer_messaging:topics"];
    if (typicalOpen && !out.gap_answer) {
      const said = sentencesOf(t).find(s => (s.match(TOPIC_WORDS) ?? []).length >= 2);
      if (said) out.gap_answer = { key: "customer_messaging:topics", text: clean(said).slice(0, 400), sources: src };
    }

    // ---- S9: keep what wasn't understood, verbatim ------------------------------------------------------
    const singleAnswer = answering && out.answer === "answered" && sentencesOf(t).length === 1;
    if (!singleAnswer) {
      for (const s of sentencesOf(t)) {
        if (recognised(s, industry, pendingPlaybook?.key ?? null)) continue;
        out.unrecognised.push({ text: clean(s).slice(0, 400), sources: src });
      }
    }

    const understood = out.facts.length > before.facts || out.claims.length > before.claims || out.signals.length > before.signals
      || out.needs.length > before.needs || (answering && out.answer && out.answer !== "unanswered") || (!!name && idx === 0);
    if (!understood) out.unclassified.push(id);
  });
  return out;
}

/** Does the reader understand anything in this sentence? (Everything else is kept verbatim.) */
function recognised(s: string, industry: string | null, playbook: string | null): boolean {
  const rest = s.replace(/^(?:hello|hi|hey|good (?:morning|afternoon|evening))[,!.]?\s*/i, "");
  if (!rest || SMALL_TALK.test(s) || SMALL_TALK.test(rest)) return true;
  if (rest.split(/\s+/).length < 3) return true;                       // too short to be worth keeping on its own
  if (isSkipLike(rest) || YES.test(rest) || NO.test(rest) || PARTLY.test(rest) || NOTHING_ELSE.test(rest) || CORRECTION.test(rest)) return true;
  if (ownerNameIn(s) || businessPhraseIn(s) || industryOf(s)) return true;
  if (extractFacts(s).length || teamSize(s)) return true;
  if (GOAL_RE.test(s) || PAIN_RE.test(s) || GENERIC_PROBLEM.test(s) || CAUSAL.test(s) || MESSAGE_WORDS.test(s) || needsIn(s).length) return true;
  if (matchPlaybook(s, industry)) return true;
  const pb = playbookByKey(playbook);
  return !!pb?.causes.some(k => k.supports.test(s) || k.refutes?.test(s));
}

// Re-exported for tests.
export { causeOf };
