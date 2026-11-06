// Offline consultant: question banks per business type, in priority order, with contextual
// follow-ups that build on what the owner already said. Only fields still unknown are asked.
import { CORE_FIELDS, FIELD_LABELS, PROFILE_FIELDS, isKnown, type ProfileDoc, type ProfileFieldKey } from "@/lib/discovery/profile";

type Bank = Partial<Record<ProfileFieldKey, string>>;

const GENERIC: Bank = {
  industry: "What kind of business do you run?",
  products_services: "What do you sell or offer to customers?",
  customers_channels: "How do customers find you and buy from you today: in person, by phone, on WhatsApp, online?",
  challenges: "What takes up most of your time, or goes wrong most often, in a typical week?",
  team_structure: "Who works in the business, and who handles what?",
  daily_operations: "Could you walk me through a normal day, from opening to closing?",
  current_tools: "Which tools or apps do you use today to keep track of sales, stock or money?",
  suppliers: "Do you rely on suppliers? If so, how do you place orders with them?",
  goals: "If some of this ran on its own, what would you most like to improve in the next few months?",
  business_name: "What's the name of the business?",
};

const BANKS: Record<string, Bank> = {
  "Restaurant / food service": {
    products_services: "What's on the menu: your main dishes or products?",
    customers_channels: "How do customers order today: at the counter, by phone, on WhatsApp or through delivery apps?",
    challenges: "What goes wrong most often in a busy week: running out of ingredients, missed orders, waste, something else?",
    suppliers: "Who supplies your key ingredients, and how do you reorder from them today?",
    daily_operations: "How does a normal day run, from buying stock in the morning to closing?",
    team_structure: "How many people work with you, and who handles orders, cooking and purchasing?",
    current_tools: "What do you use today to track orders, stock and takings: a POS, a notebook, spreadsheets?",
    goals: "What would you most like to take off your plate: ordering, stock, supplier payments, or something else?",
    business_name: "What's the restaurant called?",
  },
  "Salon / beauty services": {
    products_services: "Which services do you offer most, and do you also sell products?",
    customers_channels: "How do clients book: walk-in, phone, WhatsApp, Instagram or an online booking page?",
    challenges: "What causes the most trouble: no-shows, double bookings, chasing payments or running out of products?",
    team_structure: "How many stylists or staff do you have, and how are their schedules organised?",
    current_tools: "Do you use a booking calendar or app today?",
    daily_operations: "What does a typical day look like for you and the team?",
    suppliers: "Where do you buy your products and supplies, and how do you reorder?",
    goals: "What would you most like to improve in the next few months?",
    business_name: "What's the salon called?",
  },
  Retail: {
    products_services: "What kinds of products do you sell, and roughly how many different items?",
    customers_channels: "Where do customers buy: in the shop, online, on social media or by message?",
    challenges: "What slows you down most: stock counts, reordering, answering customers, payments?",
    suppliers: "Who are your main suppliers, and how do you place orders with them?",
    current_tools: "How do you keep track of stock and sales today?",
    team_structure: "How many people work in the shop, and who does what?",
    daily_operations: "What does a normal day in the shop involve?",
    goals: "What would you most like to improve or automate first?",
    business_name: "What's the shop called?",
  },
  "Professional / local services": {
    products_services: "Which services do you offer, and who are your typical clients?",
    customers_channels: "How do clients find you and book or request work?",
    challenges: "Where does time go that you'd rather spend on clients: scheduling, quotes, invoicing, follow-ups?",
    team_structure: "Who works in the business, and how is the work divided?",
    current_tools: "Which tools do you use for bookings, invoices and client records?",
    daily_operations: "How does a typical job run, from first contact to getting paid?",
    suppliers: "Do you buy materials or rely on any suppliers or subcontractors?",
    goals: "What would you most like to improve in the next few months?",
    business_name: "What's the business called?",
  },
};

const STOCK = /\b(run(?:ning)? out|stock|ingredients?|inventory|reorder)\b/i;

/** The next field to ask about, by business-type priority, skipping known, skipped and already-asked fields. */
export function nextQuestionField(p: ProfileDoc): ProfileFieldKey | null {
  const bank = { ...GENERIC, ...(BANKS[p.fields.industry.value ?? ""] ?? {}) };
  const bankOrder = (p.fields.industry.value ? Object.keys(BANKS[p.fields.industry.value] ?? GENERIC) : Object.keys(GENERIC)) as ProfileFieldKey[];
  // Essentials first (in the bank's order for this business type), then the optional details.
  const order = [...bankOrder.filter(k => CORE_FIELDS.includes(k)), ...bankOrder.filter(k => !CORE_FIELDS.includes(k))];
  const candidates = [...order, ...PROFILE_FIELDS];
  return candidates.find(k => bank[k] && !isKnown(p.fields[k]) && !p.skipped.includes(k) && !p.asked.includes(k))
    // The two essentials may be asked again (rephrased by the bank) until they're known.
    ?? (["industry", "products_services"] as ProfileFieldKey[]).find(k => !isKnown(p.fields[k]))
    ?? null;
}

/** The question text, referring back to earlier answers where that makes it more natural. */
export function questionFor(field: ProfileFieldKey, p: ProfileDoc): string {
  const ch = p.fields.customers_channels.value ?? "";
  const pain = p.fields.challenges.value ?? "";
  if (field === "suppliers" && STOCK.test(pain)) return `You mentioned: “${short(pain)}”. Who supplies those items, and how do you reorder from them today?`;
  if (field === "current_tools" && /whatsapp/i.test(ch)) {
    const what = /salon|services/i.test(p.fields.industry.value ?? "") ? "bookings, clients or money: a booking app, a diary, spreadsheets" : "orders, stock or money: a POS, a notebook, spreadsheets";
    return `Besides WhatsApp, which tools do you use to keep track of ${what}?`;
  }
  if (field === "goals" && pain) return `If EmployAI took care of things like “${short(pain)}”, what would you most like to achieve in the next few months?`;
  if (field === "daily_operations" && p.fields.team_structure.value) return `With ${short(p.fields.team_structure.value, 60)}, how does a normal day run from opening to closing?`;
  const bank = { ...GENERIC, ...(BANKS[p.fields.industry.value ?? ""] ?? {}) };
  return bank[field] ?? `Could you tell me about your ${FIELD_LABELS[field].toLowerCase()}?`;
}

const short = (s: string, n = 90) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s).replace(/[.\s]+$/, "");
