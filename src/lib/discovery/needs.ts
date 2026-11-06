// M3.5 · P6 (understanding first). REVIEWED DATA, like the playbooks and the catalogue:
// - NEEDS: what an owner's goal or problem asks for, as a catalogue capability;
// - GAPS: per capability, the few things that would CHANGE a possible solution, with a weight
//   (only high and medium gaps are ever asked; nothing already stated or reasonably inferable);
// - INFERENCES, in two kinds that are never mixed (safeguard S10):
//     implied  – follows from the owner's own words ("chat replies" → clients contact you by message);
//     typical  – general knowledge about the industry, always labelled "typical", never a fact about
//                this business, and never written into a profile field.
//   Never inferred: quantities, team size, platform or tool names, prices, people's names.
// The vocabulary is NOT a hard limit (S9): anything outside it is kept verbatim and clarified.
import { AGENT_FOR_CAPABILITY, AGENT_TEMPLATES, type CapabilityKey } from "@/lib/catalogue/catalogue";
import { industryOfIdentity } from "@/lib/rules/extract";
import type { CaseFile, Fact } from "./casefile";
import type { ProfileFieldKey } from "./profile";

// ---- reading the owner's words -------------------------------------------------------------------

/** "Hello, I'm Isaac", "My name is Ada Obi", "This is Tunde". A capitalised word after the phrase. */
const OWNER_NAME = /(?:^|[.!?,;]\s*|\b(?:hello|hi|hey|good (?:morning|afternoon|evening)),?\s+)(?:[Ii]'?m|[Ii] am|[Tt]his is|[Mm]y name is|[Mm]y name'?s)\s+([\p{Lu}][\p{L}'’-]+)(?:\s+([\p{Lu}][\p{L}'’-]+))?/u;
const NOT_A_NAME = new Set(["In", "Into", "The", "A", "An", "From", "Based", "Not", "Just", "Looking", "Trying", "Running", "Here", "Glad", "Happy", "Sorry", "Interested", "New", "Currently", "Also", "Still", "Really", "Very", "So", "Nigerian", "Ghanaian", "Kenyan", "British", "American", "South", "Lagos", "Abuja", "Owner", "Founder", "CEO", "Manager", "Calling", "Writing", "Reaching"]);

export function ownerNameIn(text: string): string | null {
  const m = text.match(OWNER_NAME);
  if (!m || NOT_A_NAME.has(m[1])) return null;
  return m[2] && !NOT_A_NAME.has(m[2]) && !/^(?:And|But|I|We)$/.test(m[2]) ? `${m[1]} ${m[2]}` : m[1];
}

/**
 * The owner's own description of the business, for reflecting it back in their words:
 * "I'm into real estate" → { verb: "in", phrase: "real estate" }; "I run a bakery in Abuja" →
 * { verb: "run", phrase: "a bakery in Abuja" }. Stops before "and", "called", "where", "but".
 */
const BUSINESS_PHRASE = /\b(?:(?:i'?m|i am|we'?re|we are) (into|in) (?:the )?|(?:i|we) (?:run|own|operate|manage|have|started) (?=(?:a|an|my|our|small|little|family)\b)|(?:we are|we'?re|i am|i'?m) (a|an) (?=[\w-]+ (?:business|company|shop|store|salon|agency|firm|restaurant|bakery|studio|practice)\b))([^.,;!?]+?)(?=\s+(?:and (?=(?:i|i'm|we|we're|my|our|they|it|clients?|customers?|people|staff|orders?|sometimes|often|also)\b)|but|called|named|where|which|that|with|so|because)\b|[.,;!?]|$)/gi;
const NOT_A_BUSINESS = /\b(?:problem|issue|question|lot|hard time|trouble|hurry|touch|charge)\b/i;

export function businessPhraseIn(text: string): { verb: "in" | "run"; phrase: string } | null {
  for (const m of text.matchAll(BUSINESS_PHRASE)) {
    let phrase = m[3].trim().replace(/\s+(?:business|industry|trade)$/i, "").trim();
    if (m[2]) phrase = `${m[2]} ${phrase}`;
    if (!phrase || phrase.split(/\s+/).length > 10 || NOT_A_BUSINESS.test(phrase)) continue;
    // "I'm in real estate" names a business; "I'm in Lagos" doesn't. Plain "in" counts only before a known industry.
    if (m[1]?.toLowerCase() === "in" && !industryOfIdentity(phrase)) continue;
    return { verb: m[1] ? "in" : "run", phrase };
  }
  return null;
}

/**
 * The industry of the business itself, read from the HEAD of the owner's description: "drone mapping
 * for farms and construction sites" is drone mapping, not construction or farming. Null when the
 * vocabulary doesn't know it (S9: the owner's own words are then kept as the industry).
 */
export function industryOfPhrase(phrase: string): string | null {
  const head = phrase.split(/\s+(?:for|to|in|with|near|at|around|across|serving|on)\s+/i)[0];
  return industryOfIdentity(head);
}

/** Whether the owner calls the people they serve "clients" or "customers" (to ask in their words). */
export const audienceIn = (text: string): "clients" | "customers" | null =>
  /\bclients?\b/i.test(text) ? "clients" : /\bcustomers?\b/i.test(text) ? "customers" : null;

// ---- needs ---------------------------------------------------------------------------------------

export type NeedRule = { capability: CapabilityKey; label: string; re: RegExp };

/** Most specific first: "answering WhatsApp orders" is about orders, not general messages. */
export const NEED_RULES: NeedRule[] = [
  { capability: "order_intake", label: "Taking and confirming orders", re: /\b(?:orders?|ordering)\b/i },
  { capability: "bookings", label: "Managing bookings and appointments", re: /\b(?:bookings?|appointments?|reservations?|viewings?|schedul\w+|no-?shows?|not (?:showing|turning) up)\b/i },
  { capability: "customer_messaging", label: "Automated customer communication", re: /\b(?:chats?|messages?|messaging|enquir(?:y|ies)|inquir(?:y|ies)|dms?|repl(?:y|ies|ying)|respond(?:ing)?|answer(?:ing)? (?:my |our )?(?:clients|customers|questions|messages)|customer (?:service|support|care)|client (?:communication|questions|support))\b/i },
  { capability: "inventory_tracking", label: "Keeping track of stock", re: /\b(?:stock|inventory|run(?:ning)? out|ran out|ingredients)\b/i },
  { capability: "procurement", label: "Ordering from suppliers", re: /\b(?:suppliers?|reorder\w*|purchas\w+)\b/i },
  { capability: "finance_payments", label: "Keeping track of money and payments", re: /\b(?:payments?|invoices?|bookkeeping|expenses|spending|money|profit|cash ?flow)\b/i },
];

/** The capabilities a goal or problem text asks for (orders win over generic messaging). */
export function needsIn(text: string): NeedRule[] {
  const found = NEED_RULES.filter(r => r.re.test(text));
  return found.some(r => r.capability === "order_intake") ? found.filter(r => r.capability !== "customer_messaging") : found;
}

/** "I don't want a bot replying to clients" → the owner rejects that need. */
const REJECT = /\b(?:don'?t|do not|never) (?:want|need) (?:\w+ ){0,4}?(?:bot|agent|automat\w*|ai)\b|\bno (?:bots?|automation)\b|\b(?:don'?t|do not) (?:want|need) (?:help with|to automate) /i;
export const rejectsNeed = (text: string) => REJECT.test(text);

// ---- possible solutions ----------------------------------------------------------------------------

export const agentFor = (c: CapabilityKey) => AGENT_TEMPLATES[AGENT_FOR_CAPABILITY[c]];

// ---- gaps: what would change a possible solution -----------------------------------------------------

export type GapWeight = "high" | "medium";
export type GapDef = {
  key: string;
  weight: GapWeight;
  /** Profile field the answer belongs to, when there is one. */
  slot: ProfileFieldKey | null;
  question: (ctx: GapContext) => string;
  rephrase: (ctx: GapContext) => string;
  /** Why this matters, in one sentence (said only when it helps). */
  reason: string | null;
  satisfied: (cf: CaseFile) => boolean;
};
export type GapContext = { audience: "clients" | "customers"; industry: string | null; topics: string | null };

const NAMED_PLATFORM = /WhatsApp|Instagram|Facebook|TikTok|Email|Website|Phone|Delivery apps|In person|Bookings/;
const hasPlatform = (cf: CaseFile) => NAMED_PLATFORM.test(cf.facts.customers_channels?.value ?? "");
const known = (f: Fact | undefined) => !!f?.value && f.status !== "unknown";
const gapAnswered = (cf: CaseFile, key: string) => !!cf.gap_answers?.[key];

export const GAPS: Partial<Record<CapabilityKey, GapDef[]>> = {
  customer_messaging: [
    { key: "channel", weight: "high", slot: "customers_channels", reason: null,
      question: c => `Which platform do most of your ${c.audience} message you on?`,
      rephrase: () => "Is it mostly WhatsApp, Instagram, email or something else?",
      satisfied: hasPlatform },
    { key: "topics", weight: "medium", slot: null, reason: null,
      question: c => c.topics ? `In ${c.industry ?? "businesses like yours"}, ${c.audience} usually ask about ${c.topics}. Is that what most of your messages are about, or something else?` : `What do your ${c.audience} ask about most often?`,
      rephrase: c => `What are the two or three questions your ${c.audience} ask most?`,
      satisfied: cf => gapAnswered(cf, "customer_messaging:topics") || (cf.inferences ?? []).some(i => i.key === "typical_topics" && i.status !== "inferred") },
  ],
  order_intake: [
    { key: "channel", weight: "high", slot: "customers_channels", reason: null,
      question: c => `How do most ${c.audience} place their orders: WhatsApp, phone, Instagram, in person or something else?`,
      rephrase: () => "Where do most orders come in?",
      satisfied: cf => known(cf.facts.customers_channels) },
    { key: "products", weight: "medium", slot: "products_services", reason: "An order agent needs to know what it's taking orders for.",
      question: () => "What are the main things you sell, so orders can be checked against them?",
      rephrase: () => "What do customers usually order?",
      satisfied: cf => known(cf.facts.products_services) || (cf.inferences ?? []).some(i => i.slot === "products_services" && i.status !== "rejected") },
  ],
  bookings: [
    { key: "channel", weight: "high", slot: "customers_channels", reason: null,
      question: c => `How do ${c.audience} book with you today: phone, WhatsApp, Instagram, a booking app or in person?`,
      rephrase: () => "Where do most bookings come in?",
      satisfied: hasPlatform },
  ],
  procurement: [
    { key: "suppliers", weight: "medium", slot: "suppliers", reason: "Reorders can only go to suppliers you've approved.",
      question: () => "Who are your main suppliers, and how do you order from them today?",
      rephrase: () => "Where do you buy your main supplies?",
      satisfied: cf => known(cf.facts.suppliers) },
  ],
};

// ---- inferences --------------------------------------------------------------------------------------

/** What the business deals in, IMPLIED by the industry the owner named (definitional, not a guess). */
export const INDUSTRY_OFFER: Record<string, string> = {
  "Real estate / property": "Property (sales, rentals or management: not yet specified)",
  "Hospitality / accommodation": "Accommodation",
  "Travel": "Travel bookings and tours",
  "Automotive": "Vehicle services",
  "Education / training": "Lessons or training",
  "Events": "Event services",
};

/** Service businesses whose offer is clear from the owner's own description ("a hair salon" → hair salon services). */
const PHRASE_OFFER = new Set(["Salon / beauty services", "Professional / local services", "Technology / IT services", "Construction / trades", "Logistics", "Fashion / tailoring"]);
export function offerFromPhrase(industry: string, phrase: string | null): string | null {
  if (!phrase || !PHRASE_OFFER.has(industry)) return null;
  const head = phrase.split(/\s+(?:for|to|in|with|near|at|around|across|serving|on)\s+/i)[0]
    .replace(/^(?:a|an|my|our|the)\s+/i, "").replace(/^(?:small|little|tiny|family|local|new)\s+/i, "").trim();
  return head ? `${head.charAt(0).toUpperCase()}${head.slice(1)} services` : null;
}

/** TYPICAL enquiry topics by industry: general knowledge, shown only as "typical", never as a fact. */
export const TYPICAL_TOPICS: Record<string, string> = {
  "Real estate / property": "property availability, prices and viewing arrangements",
  "Restaurant / food service": "the menu, prices, opening hours and delivery",
  "Salon / beauty services": "prices, available slots and services",
  "Retail": "whether items are in stock, prices and delivery",
  "Hospitality / accommodation": "availability, room prices and directions",
  "Travel": "prices, dates and what's included",
  "Professional / local services": "prices, availability and how to book",
  "Education / training": "fees, schedules and how to enrol",
  "Events": "availability on a date, packages and prices",
  "Automotive": "prices, repair times and availability",
};

/** Implied by the owner's words: they talk about chats or messages with their clients. */
export const MESSAGE_WORDS = /\b(?:chats?|messages?|messaging|dms?|enquir(?:y|ies)|inquir(?:y|ies)|repl(?:y|ies))\b/i;

/** Short lower-case industry name for sentences ("real estate", "restaurants"). */
const INDUSTRY_WORDS: Record<string, string> = {
  "Restaurant / food service": "restaurants", "Salon / beauty services": "salons", "Professional / local services": "professional services",
  "Real estate / property": "real estate", "Hospitality / accommodation": "hospitality", "Technology / IT services": "IT services",
  "Fashion / tailoring": "fashion and tailoring", "Construction / trades": "construction", "Education / training": "education",
  "Manufacturing / production": "manufacturing", "Retail": "retail", "Logistics": "logistics", "Travel": "travel", "Events": "events",
  "Automotive": "the motor trade", "Agriculture": "farming",
};
export const industryWords = (industry: string | null) => (industry ? INDUSTRY_WORDS[industry] ?? industry.toLowerCase() : null);
