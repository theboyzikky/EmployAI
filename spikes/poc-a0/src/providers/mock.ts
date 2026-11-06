// Offline demo provider: deterministic rules, zero cost, no network. Labelled "offline-demo".
// It implements only known tasks; anything else is a CONFIG error (never a generic fake answer).
import { AiError } from '../errors.ts';
import { PROFILE_FIELDS, type ProfileField } from '../schemas.ts';
import type { AiProvider, AiResult, TaskName, ToolDef } from '../provider.ts';
import type { z } from 'zod';

type Fact = { field: ProfileField; value: string; status: 'confirmed' | 'assumed' };

// Unicode-aware word boundaries: JavaScript's \b does not treat "é" as a word character.
const word = (alts: string) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${alts})(?![\\p{L}\\p{N}])`, 'iu');
const TYPE_RULES: Array<[RegExp, string]> = [
  [word('restaurant|café|cafe|takeaway|bistro|eatery|diner'), 'restaurant / café'],
  [word('salon|barber|hairdresser|beauty|spa|nails?'), 'salon / beauty services'],
  [word('boutique|online store|online shop|retail|shop|store'), 'retail shop'],
  [word('consultancy|consulting|agency|accounting|law firm|clinic|services?'), 'professional services'],
];
const CHANNELS: Array<[RegExp, string]> = [
  [/whatsapp/i, 'WhatsApp'], [/instagram/i, 'Instagram'], [/delivery app/i, 'delivery app'],
  [/\b(in person|counter|walk-?in)\b/i, 'in person'], [/\bphone\b/i, 'phone'], [/\b(website|online)\b/i, 'online'],
  [/\b(booking|appointment)s?\b/i, 'bookings'],
];
const TOOLS: Array<[RegExp, string]> = [[/\bPOS\b/i, 'POS'], [/notebook|paper/i, 'paper records'], [/spreadsheet|excel/i, 'spreadsheet'], [/calendar/i, 'calendar']];

/** Question bank per business type, in priority order of unknown fields. */
const QUESTIONS: Record<string, Partial<Record<ProfileField, string>>> = {
  'restaurant / café': {
    products: 'What are your main dishes or products?', order_channels: 'How do customers place orders today: in person, by phone, WhatsApp or a delivery app?',
    suppliers: 'Who supplies your key ingredients, and how do you reorder from them?', pain_points: 'What takes up most of your time or goes wrong most often?',
    team_size: 'How many people work in the business?', current_tools: 'What tools do you use today for sales and stock?', goals: 'What would you most like to improve in the next three months?',
  },
  'salon / beauty services': {
    products: 'Which services do you offer most?', order_channels: 'How do clients book: walk-in, phone, WhatsApp or online?',
    pain_points: 'What causes the most trouble: no-shows, double bookings, payments or stock?', team_size: 'How many stylists or staff do you have?',
    current_tools: 'Do you use a booking calendar or app today?', suppliers: 'Where do you buy your products and supplies?', goals: 'What would you most like to improve?',
  },
};
const GENERIC: Partial<Record<ProfileField, string>> = {
  business_type: 'What kind of business do you run?', products: 'What do you sell or offer?', order_channels: 'How do customers reach you or place orders?',
  pain_points: 'What takes up most of your time or goes wrong most often?', team_size: 'How many people work in the business?',
  current_tools: 'Which tools or apps do you use today?', suppliers: 'Do you rely on suppliers? How do you order from them?', goals: 'What would you most like to improve?',
};
const READY_FIELDS: ProfileField[] = ['business_type', 'products', 'order_channels', 'pain_points'];

export function extractFacts(text: string): Fact[] {
  const facts: Fact[] = [];
  const t = text.replace(/\s+/g, ' ');
  const type = TYPE_RULES.find(([re]) => re.test(t));
  if (type) facts.push({ field: 'business_type', value: type[1], status: 'confirmed' });
  const prod = t.match(/\b(?:we )?(?:sell|serve|offer|make)s? ([^.;]+)/i);
  if (prod) facts.push({ field: 'products', value: prod[1].trim(), status: 'confirmed' });
  const ch = CHANNELS.filter(([re]) => re.test(t)).map(([, v]) => v);
  if (ch.length) facts.push({ field: 'order_channels', value: [...new Set(ch)].join(', '), status: 'confirmed' });
  const team = t.match(/\b(\d{1,3})\s*(?:staff|employees|people|workers|baristas|stylists)\b/i);
  if (team) facts.push({ field: 'team_size', value: team[1], status: 'confirmed' });
  const tools = TOOLS.filter(([re]) => re.test(t)).map(([, v]) => v);
  if (tools.length) facts.push({ field: 'current_tools', value: tools.join(', '), status: 'confirmed' });
  const sup = t.match(/\b(?:from|with)?\s*(\w+|\d+)?\s*suppliers?\b[^.;]*/i);
  if (sup) facts.push({ field: 'suppliers', value: sup[0].trim(), status: 'confirmed' });
  const pain = t.match(/\b(running out of [^.;]+|stock ?outs?[^.;]*|chasing [^.;]+|no-?shows?[^.;]*|biggest problem[^.;]*|takes? (?:up )?(?:hours|too long)[^.;]*)/i);
  if (pain) facts.push({ field: 'pain_points', value: pain[0].trim(), status: 'confirmed' });
  const goal = t.match(/\b(?:i (?:want|would like)|we want|help (?:me |us )?)([^.;]+)/i);
  if (goal) facts.push({ field: 'goals', value: goal[1].trim(), status: 'confirmed' });
  const hours = t.match(/\b(?:open(?:s)?|opening hours?)\s+([^.;]*\d[^.;]*)/i);
  if (hours) facts.push({ field: 'opening_hours', value: hours[1].trim(), status: 'confirmed' });
  return facts;
}

export function discoveryTurn(history: string): { reply: string; facts: Fact[]; unknowns: ProfileField[]; ready_for_summary: boolean } {
  const facts = extractFacts(history);
  const known = new Set(facts.map(f => f.field));
  const unknowns = PROFILE_FIELDS.filter(f => !known.has(f) && f !== 'location_type' && f !== 'opening_hours');
  const type = facts.find(f => f.field === 'business_type')?.value;
  const bank = (type && QUESTIONS[type]) || GENERIC;
  const next = Object.keys(bank).find(k => unknowns.includes(k as ProfileField)) as ProfileField | undefined;
  const ready = READY_FIELDS.every(f => known.has(f));
  const reply = ready ? 'Thanks — I have enough to summarise your business. Shall I show you the summary?'
    : (next ? bank[next]! : (GENERIC.business_type!));
  return { reply, facts, unknowns, ready_for_summary: ready };
}

type Quote = { recipient: string; price: number; days: number };
export function parseQuotes(text: string): Quote[] {
  return [...text.matchAll(/(supplier-\d+\.[a-z0-9.-]+\.testnet) quotes ([\d.]+) NEAR[^,]*, delivery in (\d+)/gi)]
    .map(m => ({ recipient: m[1], price: Number(m[2]), days: Number(m[3]) }));
}
/** Deterministic procurement choice: approved suppliers only; lowest price, then fastest delivery. */
export function chooseSupplier(text: string, approved: RegExp = /^supplier-[123]\.employai-demo\.testnet$/) {
  const qs = parseQuotes(text).filter(q => approved.test(q.recipient)).sort((a, b) => a.price - b.price || a.days - b.days);
  if (!qs.length) return { name: 'no_action', args: { reason: 'No quote from an approved supplier.' } };
  const q = qs[0];
  return { name: 'propose_payment', args: { recipient: q.recipient, amount_near: q.price, reason: `Lowest approved quote (${q.price} NEAR, ${q.days}-day delivery).` } };
}

export class MockProvider implements AiProvider {
  readonly name = 'mock' as const;
  private result<T>(data: T): AiResult<T> {
    return { data, provider: 'mock', model: 'offline-rules-v1', mode: 'offline-demo', usage: { input: 0, output: 0 }, costUsd: 0 };
  }
  async structured<T>(req: { task: TaskName; schema: z.ZodType<T>; system: string; user: string; maxTokens: number }): Promise<AiResult<T>> {
    if (req.task !== 'discovery_turn') throw new AiError('CONFIG', 'mock', `Mock provider has no structured handler for task ${req.task}`);
    return this.result(req.schema.parse(discoveryTurn(req.user)));   // same schema as live mode
  }
  async toolCall(req: { task: TaskName; system: string; user: string; tools: readonly ToolDef[]; maxTokens: number }) {
    if (req.task !== 'procurement_decision') throw new AiError('CONFIG', 'mock', `Mock provider has no tool handler for task ${req.task}`);
    const call = chooseSupplier(req.user);
    const tool = req.tools.find(t => t.name === call.name);
    if (!tool) throw new AiError('NO_TOOL_CALL', 'mock', `Tool ${call.name} not offered`);
    return this.result({ name: call.name, args: tool.schema.parse(call.args) });
  }
}
