// Offline business analysis (AI_PROVIDER=mock). Derives processes, repetitive work, bottlenecks
// and automation opportunities ONLY from what the owner said; every item cites the profile fields
// it rests on. Processes implied by the industry alone cite only `industry`, so code labels them
// "assumed" (see groundAnalysis).
import { isKnown, type ProfileDoc, type ProfileFieldKey } from "@/lib/discovery/profile";
import type { RawAnalysis, RawItem } from "@/lib/discovery/analysis";
import { causeOf, enquiryCapabilities, playbookByKey } from "@/lib/discovery/playbooks";
import type { CapabilityKey } from "@/lib/catalogue/catalogue";
import { lowerFirst, upperFirst } from "@/lib/text";

const STOCK = /\b(stock|ingredients?|inventory|run(?:ning)? out|ran out|out of|reorder|shelf|shelves|products? (?:we|i) sell)\b/i;
const RUN_OUT = /\b(run(?:ning)? out|ran out|out of stock|stock-?outs?|short of)\b/i;
const SUPPLIER_MANUAL = /\b(phone|call|calls|whatsapp|message|manually|by hand|go to the market|visit)\b/i;
const MONEY = /\b(pay(?:ing|ment|ments)?|invoices?|cash|budget|costs?|margins?|expenses?|transfers?|takings|accounts?|bookkeeping|profit)\b/i;
const MONEY_PAIN = /\b(chasing (?:payments?|invoices?)|late payments?|cash ?flow|lose track of (?:money|costs|spending)|costs?|overspend)\b/i;
const ORDER_PAIN = /\b(missed|miss|forget|forgot|lost|mix(?:ed)?[- ]?up|wrong) (?:orders?|messages?)|orders? (?:get|go) (?:missed|lost)|missed orders?\b/i;
const BOOKING = /\b(bookings?|appointments?|reservations?|no-?shows?|double[- ]book)/i;
const BOOKING_PAIN = /\b(no-?shows?|double[- ]book(?:ings?|ed)?|cancellations?)\b/i;
const MSG_CHANNEL = /\b(whats\s?app|instagram|facebook|email|messages?|dms?)\b/i;
const QUESTIONS = /\b(questions?|enquir(?:y|ies)|inquir(?:y|ies)|repl(?:y|ies|ying)|respond(?:ing)?|answering|messages? at (?:night|midnight))\b/i;
const ORDER_WORDS = /\b(orders?|ordering|purchases?|buy(?:s|ing)?|sales?|sell(?:s|ing)?|delivery|deliveries|takeaway)\b/i;
const PAPER = /\b(paper records|paper|notebook|spreadsheets?)\b/i;
const STOCK_INDUSTRIES = /restaurant|food|retail|manufactur/i;

type Field = ProfileFieldKey;

export function offlineAnalysis(p: ProfileDoc): RawAnalysis {
  // M3.5: with a case file, problems and opportunities come from the investigated problems and their
  // causes. Without one (a pre-M3.5 profile that hasn't been migrated), the M2 rules below apply.
  if (p.case_file) return caseAnalysis(p);
  return legacyAnalysis(p);
}

/** Each specialist's part in an improvement that needs more than one of them. */
const CAPABILITY_PART: Record<CapabilityKey, string> = {
  orchestration: "coordination", order_intake: "capturing orders", inventory_tracking: "watching stock levels",
  procurement: "preparing supplier orders", finance_payments: "tracking payments", bookings: "managing bookings",
  customer_messaging: "handling customer messages",
};
const cap = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);
const msgEvidence = (ids: string[]) => [...new Set(ids)].slice(0, 6).map(message_id => ({ kind: "message" as const, message_id }));

/**
 * Analysis grounded in the case file. Bottlenecks are cause chains (symptom ← cause, with its basis).
 * Opportunities exist ONLY for a problem the owner stated, and only:
 *  - for a cause confirmed by the owner or supported by their answers (one item per capability), or
 *  - as "measure first" when the cause is still unknown.
 * Keyword-only opportunities from the M2 rules are not used: every agent must trace to a problem.
 */
function caseAnalysis(p: ProfileDoc): RawAnalysis {
  const cf = p.case_file!;
  const base = legacyAnalysis({ ...p, case_file: undefined });   // descriptive processes and repetitive work only
  const bottlenecks: RawItem[] = [], opportunities: RawItem[] = [];
  for (const prob of cf.problems) {
    const pb = playbookByKey(prob.playbook);
    const sym = cf.claims.find(c => c.id === prob.symptom_claim);
    if (!sym) continue;
    const own = cf.claims.find(c => c.id === prob.cause_claim);
    const symEv = sym.sources;
    const confirmed = pb ? prob.hypotheses.filter(h => h.status === "confirmed") : [];
    const supported = pb ? prob.hypotheses.filter(h => h.status === "supported") : [];
    const label = (key: string) => causeOf(pb!, key)!.label;
    // Message problems that are really orders go to the Order Agent; other enquiries to the messages agent.
    const capsOf = (key: string): CapabilityKey[] => pb?.key === "enquiries" ? enquiryCapabilities(sym.text) : causeOf(pb!, key)!.capabilities;
    if (prob.from_goal) {
      // The problem behind a goal: the bottleneck is the cause, not the goal itself.
      for (const h of [...confirmed, ...supported]) bottlenecks.push({ title: cap(upperFirst(label(h.key)), 120), detail: cap(`Behind your goal “${cap(sym.text, 80)}”: ${h.status === "confirmed" ? "confirmed by you" : "likely, not yet confirmed by you"}.`, 400), evidence: msgEvidence([...h.evidence, ...symEv]), capability: null });
    }
    const chain = [
      confirmed.length ? `Cause, confirmed by you: ${confirmed.map(h => label(h.key)).join("; ")}.` : "",
      supported.length ? `${confirmed.length ? "Also likely" : "Likely cause"}, not yet confirmed by you: ${supported.map(h => label(h.key)).join("; ")}.` : "",
      !confirmed.length && !supported.length ? `Cause still unknown.${pb ? ` ${pb.measure.title}.` : ""}` : "",
      own && own.status !== "confirmed" ? `Your view (not verified): “${cap(own.text, 80)}”.` : "",
    ].filter(Boolean).join(" ");
    if (!prob.from_goal) bottlenecks.push({ title: cap(sym.text.replace(/^./, c => c.toUpperCase()), 120), detail: cap(chain, 400), evidence: msgEvidence([...symEv, ...[...confirmed, ...supported].flatMap(h => h.evidence)]), capability: null });

    if (pb && (confirmed.length || supported.length)) {
      for (const h of [...confirmed, ...supported]) {
        const cause = causeOf(pb, h.key)!;
        const caps = capsOf(h.key);
        const what = prob.from_goal ? `Serves your goal “${cap(sym.text, 70)}”; the reason behind it, ${h.status === "confirmed" ? "as you confirmed" : "likely but not yet confirmed"}, is that` : `Addresses “${cap(sym.text, 70)}”, ${h.status === "confirmed" ? "caused, as you confirmed," : "likely caused"} by:`;
        const why = `${what} ${cause.label}. ${cause.fixDetail}`;
        const ev = msgEvidence([...h.evidence, ...symEv]);
        if (!caps.length) opportunities.push({ title: cap(cause.fix, 120), detail: cap(why, 400), evidence: ev, capability: null });
        // One item per capability, each with its own title (titles are unique within the analysis).
        for (const c of caps) {
          const title = caps.length > 1 ? `${cause.fix} (${CAPABILITY_PART[c]})` : cause.fix;
          opportunities.push({ title: cap(title, 120), detail: cap(why, 400), evidence: ev, capability: c });
        }
      }
    } else if (prob.from_goal) {
      // The owner asked for it, but the reason behind it is unknown: offer it, and say so.
      const need = (cf.needs ?? []).find(n => n.status === "stated" && n.from.includes(sym.id));
      if (need) opportunities.push({ title: cap(`${need.label}, as you asked`, 120), detail: cap(`You asked for this: “${cap(sym.text, 90)}”. What's behind it is still unknown, so start small and check it helps. ${pb?.measure.title ?? ""}`.trim(), 400), evidence: msgEvidence(symEv), capability: need.capability });
    } else {
      const m = pb?.measure ?? { capability: null, title: "Measure first: keep a note of when it happens and what led to it", detail: "So the cause can be found before anything is automated." };
      opportunities.push({ title: cap(m.title, 120), detail: cap(`${m.detail} The cause of “${cap(sym.text, 70)}” is still unknown.`, 400), evidence: msgEvidence(symEv), capability: m.capability });
    }
  }
  // Coordination, only when several areas would be automated.
  const auto = [...new Set(opportunities.filter(o => o.capability && o.capability !== "bookings" && o.capability !== "customer_messaging").map(o => o.capability))];
  if (auto.length >= 2) opportunities.unshift({ title: "Coordinate the hand-offs between these tasks", detail: "One coordinator passes work between the specialists working on these problems and asks you when a decision is needed.", evidence: msgEvidence(cf.problems.flatMap(pr => cf.claims.find(c => c.id === pr.symptom_claim)?.sources ?? [])), capability: "orchestration" });
  return { processes: base.processes, repetitive_tasks: base.repetitive_tasks, bottlenecks: bottlenecks.slice(0, 8), opportunities: opportunities.slice(0, 8) };
}

function legacyAnalysis(p: ProfileDoc): RawAnalysis {
  const v = (k: Field) => (isKnown(p.fields[k]) ? p.fields[k].value ?? "" : "");
  const has = (k: Field) => isKnown(p.fields[k]);
  /** The fields (among `keys`) whose text matches `re`. */
  const where = (re: RegExp, keys: Field[]) => keys.filter(k => has(k) && re.test(v(k)));
  const ev = (keys: Field[]) => [...new Set(keys)].map(field => ({ kind: "field" as const, field }));
  const item = (title: string, detail: string, keys: Field[], capability: CapabilityKey | null = null): RawItem => ({ title, detail, evidence: ev(keys), capability });

  const processes: RawItem[] = [], repetitive: RawItem[] = [], bottlenecks: RawItem[] = [], opportunities: RawItem[] = [];
  const ops: Field[] = ["challenges", "goals", "daily_operations", "current_tools", "suppliers", "products_services", "customers_channels"];

  // Orders and sales: only when the owner talks about orders or sales, or the business type sells goods.
  // A salon or consultancy whose customers *book* is covered by bookings instead.
  const orderTalk = where(ORDER_WORDS, ["customers_channels", "challenges", "goals", "daily_operations"]);
  const sellsGoods = has("industry") && STOCK_INDUSTRIES.test(v("industry"));
  if (has("customers_channels") && (orderTalk.length || sellsGoods)) {
    processes.push(item("Taking customer orders", `Customers buy through: ${v("customers_channels")}.`, ["customers_channels"]));
    if (MSG_CHANNEL.test(v("customers_channels")) || /phone/i.test(v("customers_channels")))
      repetitive.push(item("Writing down orders that arrive by message or phone", "Each order has to be read, recorded and confirmed by hand.", ["customers_channels"]));
    const pain = where(ORDER_PAIN, ["challenges"]);
    if (pain.length) bottlenecks.push(item("Orders get missed or mixed up", v("challenges"), pain));
    opportunities.push(item("Capture and confirm every order automatically", "Record each order as it arrives, check it against what you sell, and confirm it with the customer.", ["customers_channels", ...pain], "order_intake"));
  }

  // Stock
  const stockFields = where(STOCK, ops);
  const stockByIndustry = has("industry") && STOCK_INDUSTRIES.test(v("industry"));
  if (stockFields.length || stockByIndustry) {
    processes.push(item("Managing stock", stockFields.length ? "Keeping track of what's in stock and what needs replacing." : "A business of this type usually keeps stock. Please confirm this applies to you.", stockFields.length ? stockFields : ["industry"]));
    const runOut = where(RUN_OUT, ["challenges", "goals", "daily_operations"]);
    if (runOut.length) bottlenecks.push(item("Items run out before they're reordered", v(runOut[0]), runOut));
    const paper = where(PAPER, ["current_tools"]);
    if (paper.length) repetitive.push(item("Counting and recording stock by hand", `Stock and sales are tracked with ${lowerFirst(v("current_tools"))}.`, paper));
    opportunities.push(item("Track stock and flag low items early", "Update stock after every sale and warn you before key items run out.", [...runOut, ...stockFields, ...(stockFields.length ? [] : ["industry" as Field])], "inventory_tracking"));
  }

  // Suppliers
  if (has("suppliers")) {
    processes.push(item("Buying from suppliers", v("suppliers"), ["suppliers"]));
    if (SUPPLIER_MANUAL.test(v("suppliers"))) repetitive.push(item("Placing supplier orders by phone or message", "Each reorder is arranged by hand with the supplier.", ["suppliers"]));
    opportunities.push(item("Prepare reorders and compare supplier offers", "Request quotes from approved suppliers and recommend the best one, for you or the Finance Agent to check.", ["suppliers", ...where(RUN_OUT, ["challenges"])], "procurement"));
  }

  // Money
  const moneyFields = where(MONEY, ops);
  if (moneyFields.length || has("suppliers")) {
    const basis: Field[] = moneyFields.length ? moneyFields : ["suppliers"];
    processes.push(item("Handling payments and costs", moneyFields.length ? "Money comes in from sales and goes out to suppliers and costs." : "Supplier orders have to be paid for.", basis));
    const pain = where(MONEY_PAIN, ["challenges"]);
    if (pain.length) bottlenecks.push(item("Keeping on top of payments and costs", v("challenges"), pain));
    opportunities.push(item("Track spending and prepare supplier payments for approval", "Check payments against your budget and limits, and keep sales and costs on one ledger.", [...basis, ...pain], "finance_payments"));
  }

  // Bookings (preview capability)
  const booking = where(BOOKING, ["customers_channels", "challenges", "products_services", "daily_operations", "goals"]);
  if (booking.length) {
    processes.push(item("Managing bookings", "Clients book appointments or reservations.", booking));
    const pain = where(BOOKING_PAIN, ["challenges"]);
    if (pain.length) bottlenecks.push(item("No-shows and booking clashes", v("challenges"), pain));
    opportunities.push(item("Automate bookings and reminders", "Record bookings and send reminders to reduce no-shows.", [...booking, ...pain], "bookings"));
  }

  // Customer messages (preview capability)
  const msgChannels = where(MSG_CHANNEL, ["customers_channels"]);
  const msgPain = where(QUESTIONS, ["challenges", "goals", "daily_operations"]);
  if (msgChannels.length || msgPain.length) {
    repetitive.push(item("Answering routine customer messages", "Customers send messages that need a reply.", [...msgChannels, ...msgPain]));
    // Only proposed as an opportunity when the owner says replying is a burden or a goal.
    if (msgPain.length) opportunities.push(item("Answer routine customer questions", "Reply to common questions and pass anything unusual to you.", [...msgPain, ...msgChannels], "customer_messaging"));
  }

  // Coordination: only worthwhile when several areas would be automated.
  const auto = opportunities.filter(o => o.capability && o.capability !== "bookings" && o.capability !== "customer_messaging");
  if (auto.length >= 2) {
    opportunities.unshift(item("Coordinate the hand-offs between these tasks", "One coordinator passes work between the specialists and asks you when a decision is needed.", [...new Set(auto.flatMap(o => o.evidence.map(e => (e as { field: Field }).field)))], "orchestration"));
  }

  return { processes: processes.slice(0, 8), repetitive_tasks: repetitive.slice(0, 8), bottlenecks: bottlenecks.slice(0, 8), opportunities: opportunities.slice(0, 8) };
}
