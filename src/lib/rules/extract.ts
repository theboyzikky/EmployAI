// Offline (rule-based) fact extraction for the mock consultant. Deterministic, no network.
// It only ever reports what the owner's own words say; it never fills a field from a guess about the
// industry. Each fact carries the ID of the message it came from.
import type { ProfileFieldKey } from "@/lib/discovery/profile";
import { normalizeBrands, upperFirst } from "@/lib/text";

export type ExtractedFact = { field: ProfileFieldKey; value: string; status: "confirmed" | "assumed" };

// Unicode-aware word boundaries: JavaScript's \b does not treat "é" as a word character.
const word = (alts: string) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${alts})(?![\\p{L}\\p{N}])`, "iu");

/** The original (M2) industries, in their original order: matched anywhere in a message. */
export const INDUSTRY_RULES: Array<[RegExp, string]> = [
  [word("restaurant|café|cafe|coffee shop|takeaway|take-away|bistro|eatery|diner|food truck|canteen|bakery|bar|pub|catering|kitchen"), "Restaurant / food service"],
  [word("salon|barber(?:shop)?|hairdresser|hair stylist|beauty|spa|nail(?:s| bar)?|lashes|makeup studio"), "Salon / beauty services"],
  // M3.5 · P6: the only new names allowed here, because the professional rule below would otherwise read
  // their "agency" as a professional-services agency. They are unambiguous on their own.
  [word("real estate agen(?:t|ts|cy)|estate agen(?:t|ts|cy)|letting agen(?:t|cy)"), "Real estate / property"],
  [word("travel agen(?:t|cy)|visa agen(?:t|cy)"), "Travel"],
  [word("digital agency"), "Technology / IT services"],
  [word("consultancy|consulting|agency|accounting|accountant|law firm|lawyer|clinic|dental|tutoring|cleaning (?:company|service)|plumb(?:er|ing)|repair(?:s| shop)?|freelance|photography|gym|fitness studio"), "Professional / local services"],
  [word("logistics|courier|delivery company|transport company|haulage"), "Logistics"],
  [word("factory|manufactur(?:er|ing)|workshop|print shop"), "Manufacturing / production"],
  // Retail last, so "barber shop", "repair shop" or "coffee shop" match their own type first.
  [word("boutique|online store|online shop|e-?commerce|retail|grocery|supermarket|pharmacy|shop|store|minimart"), "Retail"],
];

/**
 * M3.5 · P6: the other new industries. They count ONLY when the wording identifies them as the
 * business ("I'm into real estate", "we run a hotel", "our tailoring business"), never when the word
 * appears in passing ("next to a school", "farm-fresh food", "above a garage", "construction workers").
 */
export const IDENTITY_INDUSTRY_RULES: Array<[RegExp, string]> = [
  [word("real estate|realtors?|property (?:agent|agency|business|company|management|developer|development|sales)|properties|landlord|short[- ]?lets?|rentals? (?:business|company)"), "Real estate / property"],
  [word("hotel|guest ?house|hostel|airbnb|bed and breakfast|b&b|lodge|serviced apartments?"), "Hospitality / accommodation"],
  [word("tour operator|tours? company"), "Travel"],
  [word("software|app development|web design|web development|it services|it support|tech start-?up|saas"), "Technology / IT services"],
  [word("event planning|events? (?:company|business|planner)|wedding planner|decor(?:ation)? business|party rentals?"), "Events"],
  [word("tailor(?:ing)?|fashion design(?:er)?|clothing brand|fashion brand|seamstress"), "Fashion / tailoring"],
  [word("mechanic|car wash|auto (?:repair|parts|shop)|garage|car dealership|vehicle repair"), "Automotive"],
  [word("farm|farming|poultry|fish farm|agro|agriculture|livestock"), "Agriculture"],
  [word("construction|builders?|building contractor|electrician|carpent(?:er|ry)|painting company|renovations?"), "Construction / trades"],
  [word("school|tutor(?:s|ing)?|lessons|academy|training centre|training center|driving school"), "Education / training"],
];

/** Phrases that say what the business IS: "I run a…", "I'm into…", "we are a…", "our…" (up to the next clause). */
const IDENTITY_FRAMES = [
  /\b(?:i|we)\s+(?:run|own|operate|manage|have|started)\s+([^.,;!?]+)/gi,
  /\b(?:i'?m|i am|we'?re|we are)\s+(?:into|in|an?)\s+([^.,;!?]+)/gi,
  /\b(?:my|our)\s+([^.,;!?]+)/gi,
];
const FRAME_END = /\s+(?:is|are|was|were|and|but|called|named|near|next|to|for|with|at|in|on|above|below|beside|behind|opposite|serving|that|which|who|where|so|because)\b/i;

/** The words that name the business itself, from identity phrases (and a short answer such as "Real estate."). */
function identityPhrases(text: string): string[] {
  const out: string[] = [];
  for (const re of IDENTITY_FRAMES) for (const m of text.matchAll(re)) out.push(m[1].split(FRAME_END)[0]);
  if (text.trim().split(/\s+/).length <= 5) out.push(text);
  return out;
}

/**
 * The industry a message names: an original industry anywhere in the text (unchanged M2 behaviour), else
 * a new industry only from wording that identifies the business.
 */
export function industryOf(text: string): string | null {
  const direct = INDUSTRY_RULES.find(([re]) => re.test(text));
  if (direct) return direct[1];
  const phrases = identityPhrases(text);
  return IDENTITY_INDUSTRY_RULES.find(([re]) => phrases.some(p => re.test(p)))?.[1] ?? null;
}

/** Industry of a phrase already known to describe the business (both lists, original first). */
export const industryOfIdentity = (phrase: string) => [...INDUSTRY_RULES, ...IDENTITY_INDUSTRY_RULES].find(([re]) => re.test(phrase))?.[1] ?? null;

export const CHANNELS: Array<[RegExp, string]> = [
  [/whats\s?app/i, "WhatsApp"], [/instagram/i, "Instagram"], [/facebook/i, "Facebook"], [/tiktok/i, "TikTok"],
  [/delivery (?:app|platform)s?|uber ?eats|glovo|chowdeck|deliveroo|jumia food|doordash/i, "Delivery apps"],
  [word("in person|in-person|counter|walk-?ins?|in store|in-store|at the shop"), "In person"],
  [word("phone|phone calls?|calls"), "Phone"], [word("website|online orders?|web shop|online"), "Website / online"],
  [word("email"), "Email"], [word("bookings?|appointments?"), "Bookings / appointments"],
];

const TOOLS: Array<[RegExp, string]> = [
  [word("POS|point of sale|till"), "POS / till"], [word("notebook|paper|pen and paper|ledger book|receipt book"), "Paper records"],
  [word("spreadsheets?|excel|google sheets"), "Spreadsheets"], [word("google calendar|calendar"), "Calendar"],
  [word("whatsapp business"), "WhatsApp Business"], [word("quickbooks|xero|sage|wave"), "Accounting software"],
  [word("square|shopify|woocommerce|wix|squarespace"), "Online store / payments platform"], [word("fresha|booksy|calendly|setmore"), "Booking app"],
  [word("bank transfers?|mobile money|opay|paystack|flutterwave|stripe|paypal"), "Payments app / transfers"],
];

const sentences = (t: string) => t.split(/(?<=[.!?;])\s+|\n+/).map(s => s.trim()).filter(Boolean);
const clip = (s: string, n = 220) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s).replace(/[.;,\s]+$/, "");
/** Clauses: sentences split further at ", and" / ", but" / "because" / "so that", so one fact doesn't swallow the others. */
const clauses = (t: string) => sentences(t)
  .flatMap(s => s.split(/,\s*(?:and|but|so)\s+|\s+because\s+|\s+but\s+|\s+so that\s+|,\s*which\s+/i))
  .map(c => c.trim()).filter(c => c.length > 2);
const ORDERING = /\b(order|orders|ordering|book|books|booking|bookings|buy|buys|customers?|clients?|sell|sales|message us|contact us|reach us|come in|walk in)\b/i;

const NEGATIVE = /^(?:no|none|nope|not really|nothing|n\/a|na|i don'?t know|don'?t know|not sure|skip(?: this(?: one| question)?)?|pass|-)[.!]?$/i;
export const isSkipLike = (t: string) => NEGATIVE.test(t.trim());

// ---- patterns ---------------------------------------------------------------------------------
const NAME_RE = /\b(?:called|named|name is|business is called)\s+["“']?((?:[\p{Lu}0-9][\p{L}0-9'’&-]*)(?:\s+(?:[\p{Lu}0-9&][\p{L}0-9'’&-]*|of|and|the|de|la)){0,5})/u;
/** A sentence that only introduces the business ("It's called X.", "Our salon is called X"). */
const NAME_INTRO = /^(?:(?:it'?s|it is|we'?re|we are|i'?m|this is)\s+(?:called|named)|(?:the|my|our)\s+(?:business|restaurant|shop|store|salon|company|bakery|café|cafe|kitchen|place)(?:'s name)?\s+is\s+(?:called|named)?|(?:the|our|my)\s+name\s+is|(?:we|i)\s+(?:trade|operate)\s+as)\b/i;
const PROD_RE = /\b(?:we|i)\s+(?:mainly\s+|mostly\s+|also\s+)?(?:sell|serve|offer|make|bake|cook|provide)\s+([^.;!?]+)/i;
const PROD_RE2 = /\b(?:our|my)\s+(?:menu|products?|services?)\s+(?:include|includes|are|is)\s+([^.;!?]+)/i;
/** Where/how it's sold belongs to channels, not products. */
const PROD_STOP = /\s+(?:at|in|on|from|via|through)\s+(?:the\s+)?(?:counter|shop|store|market|whats\s?app|instagram|phone|website)\b|,?\s+and\s+(?:we\s+|i\s+)?(?:take|accept|get)\s+(?:\w+\s+)?(?:orders|bookings)\b/i;
export const GOAL_RE = /\b(?:what (?:i|we) (?:really |actually |mainly )?(?:want|need) is|i (?:really|just|mainly|actually) (?:want|need)|i(?:'d| would)? (?:want|like|love|hope)|we(?:'d| would)? (?:want|like|love|hope)|my goal is|our goal is|goal is|help (?:me|us)|i need (?:help|to)|we need to|so that i|so that we)\b/i;
export const PAIN_RE = /\b(run(?:ning)? out|ran out|out of stock|stock-?outs?|problem|struggle|difficult|hard to|too long|takes? (?:up )?(?:hours|ages|time)|forget|missed?|mistakes?|errors?|chasing|no-?shows?|waste|late|slow|overwhelm|manual(?:ly)?|by hand|lose track|losing)\b/i;
export const SUP_RE = /\b(suppliers?|wholesalers?|distributors?|vendors?|(?:buy|order|source|get) (?:\w+ ){0,3}from|the market|reorder)\b/i;
export const TEAM_RE = /\b(\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|a few)\s+(?:full[- ]time\s+|part[- ]time\s+)?(?:staff|employees|people|workers|baristas|stylists|chefs|cooks|waiters|assistants|team members)\b[^.;!?]*|\b(?:just me|only me|on my own|by myself|i work alone|me and my (?:wife|husband|partner|brother|sister|family)|family[- ]run)\b[^.;!?]*/i;
/** Doing the daily work (opening, cooking, delivering…). "We serve X" is a product, not a routine. */
const OPS_RE = /\b(?:we|i)\s+(?:usually\s+|normally\s+)?(?:open|close|start|cook from|prep|prepare|work|go to|deliver|bake from)\b|\bopening hours\b|\bshifts?\b|\b(?:every|each) (?:morning|day|evening)\b.*\b(?:we|i) (?:go|buy|cook|open)\b/i;

const tidy = (s: string) => normalizeBrands(clip(s.trim()));

/**
 * Facts stated anywhere in a single message (keyword patterns). Each CLAUSE feeds at most one
 * clause-based field, so a sentence is never copied into several unrelated fields. Label fields
 * (industry, channels, tools) are recognised keywords, so they can come from any clause.
 */
export function extractFacts(text: string): ExtractedFact[] {
  const t = text.replace(/\s+/g, " ").trim();
  const facts: ExtractedFact[] = [];
  const push = (field: ProfileFieldKey, value: string | undefined, status: "confirmed" | "assumed" = "confirmed") => {
    if (value && value.trim().length > 1) facts.push({ field, value: tidy(value), status });
  };
  const cl = clauses(t);
  const used = new Set<number>();
  /** Take the first unused clause matching `re`. */
  const claim = (re: RegExp) => {
    const i = cl.findIndex((c, idx) => !used.has(idx) && re.test(c));
    if (i < 0) return null;
    used.add(i);
    return { clause: cl[i], match: cl[i].match(re)! };
  };

  const industry = industryOf(t);
  if (industry) push("industry", industry);

  // The name and the team size are short phrases picked out of a clause, not copies of it, so they
  // don't claim the clause ("…called Glow Studio with 4 stylists" gives both).
  const name = t.match(NAME_RE);
  if (name) push("business_name", name[1].replace(/["”']+$/, ""));
  const team = t.match(TEAM_RE);
  if (team) push("team_structure", team[0]);

  const prod = claim(PROD_RE) ?? claim(PROD_RE2);
  if (prod) push("products_services", prod.match[1].split(PROD_STOP)[0]);

  // Channels only from clauses about customers ordering or booking (not "I call my supplier by phone").
  const custClauses = cl.filter(c => ORDERING.test(c) && !/\bsuppliers?\b|\breorder/i.test(c));
  const ch = [...new Set(CHANNELS.filter(([re]) => custClauses.some(c => re.test(c))).map(([, v]) => v))];
  if (ch.length) push("customers_channels", ch.join(", "));

  const tools = [...new Set(TOOLS.filter(([re]) => re.test(t)).map(([, v]) => v))];
  if (tools.length) push("current_tools", tools.join(", "));

  // Clause-based fields, most specific first.
  const goal = claim(GOAL_RE);
  if (goal) push("goals", goal.clause.slice(goal.match.index));
  const pain = claim(PAIN_RE);
  if (pain) push("challenges", pain.clause);
  const sup = claim(SUP_RE);
  if (sup) push("suppliers", sup.clause);
  const ops = claim(OPS_RE);
  if (ops) push("daily_operations", ops.clause, "assumed");

  return facts;
}

/** Split an answer into "this is our name" sentences and the actual answer. */
export function separateIntroductions(text: string): { names: string[]; rest: string } {
  const names: string[] = [];
  const rest: string[] = [];
  for (const s of sentences(text)) {
    if (NAME_INTRO.test(s) && s.split(/\s+/).length <= 10) {
      const m = s.match(NAME_RE) ?? s.match(/\b(?:is|as)\s+["“']?((?:[\p{Lu}0-9][\p{L}0-9'’&-]*)(?:\s+(?:[\p{Lu}0-9&][\p{L}0-9'’&-]*|of|and|the)){0,5})/u);
      if (m) { names.push(m[1].replace(/["”'.]+$/, "")); continue; }
    }
    rest.push(s);
  }
  return { names, rest: rest.join(" ") };
}

/** Fields whose value is a recognised keyword label rather than a copy of the owner's sentence. */
const LABEL_FIELDS: ProfileFieldKey[] = ["industry", "customers_channels", "current_tools"];

/**
 * Interpret a reply to a specific question. The answer belongs to the field that was asked; a
 * sentence that only introduces the business name goes to business_name instead. Other sentence-
 * copying fields are NOT filled from the same answer (no sentence lands in two unrelated fields);
 * recognised labels (industry, channels, tools) are still picked up. "skip" is a skip.
 */
export function extractFromAnswer(text: string, askedField: ProfileFieldKey | null): { facts: ExtractedFact[]; skipped: boolean } {
  const t = text.replace(/\s+/g, " ").trim();
  if (askedField && isSkipLike(t)) return { facts: [], skipped: true };
  if (!askedField) return { facts: extractFacts(t), skipped: false };

  const { names, rest } = separateIntroductions(t);
  const facts: ExtractedFact[] = extractFacts(t).filter(f => f.field !== askedField && LABEL_FIELDS.includes(f.field));
  if (askedField !== "business_name" && names[0]) facts.push({ field: "business_name", value: tidy(names[0]), status: "confirmed" });

  if (askedField === "industry") {
    const ind = industryOf(t);
    facts.push({ field: "industry", value: ind ?? tidy(clip(t, 80)), status: "confirmed" });
  } else if (askedField === "business_name") {
    const value = names[0] ?? t.replace(/^(?:it'?s|we'?re|it is|the name is|we are)\s+(?:called\s+)?/i, "");
    facts.push({ field: "business_name", value: tidy(clip(value, 80)), status: "confirmed" });
  } else if (rest) {
    let value = rest;
    if (askedField === "products_services") {
      // "We serve jollof rice and…" → "Jollof rice and…"
      value = upperFirst(value.replace(/^(?:we|i)\s+(?:mainly\s+|mostly\s+)?(?:sell|serve|offer|make|bake|cook|provide|do)\s+/i, ""));
    }
    facts.push({ field: askedField, value: tidy(value), status: "confirmed" });
  }
  return { facts, skipped: false };
}
