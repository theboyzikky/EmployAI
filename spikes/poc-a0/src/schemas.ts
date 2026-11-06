import { z } from 'zod';

export const PROFILE_FIELDS = ['business_type', 'products', 'order_channels', 'team_size', 'current_tools',
  'suppliers', 'pain_points', 'goals', 'opening_hours', 'location_type'] as const;
export type ProfileField = typeof PROFILE_FIELDS[number];

export const DiscoveryTurn = z.object({
  reply: z.string().min(1),
  facts: z.array(z.object({
    field: z.enum(PROFILE_FIELDS),
    value: z.string().min(1),
    status: z.enum(['confirmed', 'assumed']),
  }).strict()),
  unknowns: z.array(z.enum(PROFILE_FIELDS)),
  ready_for_summary: z.boolean(),
}).strict();
export type DiscoveryTurn = z.infer<typeof DiscoveryTurn>;

export const ProposePaymentArgs = z.object({
  recipient: z.string().min(2),
  amount_near: z.number().positive(),
  reason: z.string().min(1),
}).strict();
export const NoActionArgs = z.object({ reason: z.string().min(1) }).strict();

export const PROCUREMENT_TOOLS = [
  { name: 'propose_payment', description: 'Propose paying one supplier. A security gate checks it before anything is signed.', schema: ProposePaymentArgs },
  { name: 'no_action', description: 'Decline to propose a payment.', schema: NoActionArgs },
] as const;

/** JSON Schema for strict structured output (provider side). */
export const toJsonSchema = (s: z.ZodType) => z.toJSONSchema(s, { target: 'draft-7' }) as Record<string, unknown>;
