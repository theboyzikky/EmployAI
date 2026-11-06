// Offline business analysis (AI_PROVIDER=mock). Derives processes, repetitive work, bottlenecks
// and automation opportunities ONLY from what the owner said; every item cites the profile fields
// it rests on. Processes implied by the industry alone cite only `industry`, so code labels them
// "assumed" (see groundAnalysis).
import { isKnown, type ProfileDoc, type ProfileFieldKey } from "@/lib/discovery/profile";
import type { RawAnalysis, RawItem } from "@/lib/discovery/analysis";
import type { CapabilityKey } from "@/lib/catalogue/catalogue";
import { lowerFirst } from "@/lib/text";

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
