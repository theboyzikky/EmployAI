import { z } from "zod";

/**
 * Business profile (stored as `businesses.profile` jsonb in the approved schema, doc 03).
 * Every field records its value, whether it is CONFIRMED (stated by the owner) or ASSUMED
 * (inferred, must be checked), and the message IDs it came from. Unknown fields have no value.
 */
export const PROFILE_FIELDS = [
  "business_name",
  "industry",
  "products_services",
  "customers_channels",
  "team_structure",
  "daily_operations",
  "current_tools",
  "suppliers",
  "challenges",
  "goals",
] as const;
export type ProfileFieldKey = (typeof PROFILE_FIELDS)[number];
export const ProfileFieldKeySchema = z.enum(PROFILE_FIELDS);

export const FIELD_LABELS: Record<ProfileFieldKey, string> = {
  business_name: "Business name",
  industry: "Industry",
  products_services: "Products & services",
  customers_channels: "How customers buy",
  team_structure: "Team & structure",
  daily_operations: "Daily operations",
  current_tools: "Tools you use today",
  suppliers: "Suppliers",
  challenges: "Challenges",
  goals: "Goals & automation wishes",
};

/** Needed before analysis (with business_name, industry and products_services always required to be known). */
export const CORE_FIELDS: ProfileFieldKey[] = ["industry", "products_services", "customers_channels", "challenges", "goals"];
export const OPTIONAL_FIELDS: ProfileFieldKey[] = ["business_name", "team_structure", "daily_operations", "current_tools", "suppliers"];
/** Fields whose values are lists that grow as the owner mentions more items. */
export const LIST_FIELDS: ProfileFieldKey[] = ["customers_channels", "current_tools"];

export const MAX_FIELD_LENGTH = 600;
export const FieldStatusSchema = z.enum(["confirmed", "assumed", "unknown"]);
export type FieldStatus = z.infer<typeof FieldStatusSchema>;

export const ProfileFieldSchema = z.object({
  value: z.string().max(MAX_FIELD_LENGTH).nullable(),
  status: FieldStatusSchema,
  sources: z.array(z.string().max(64)).max(30),          // message IDs (user messages only)
  updated_by: z.enum(["consultant", "owner"]).nullable(), // owner edits lock the field against AI changes
  updated_at: z.string().nullable(),
}).strict();
export type ProfileField = z.infer<typeof ProfileFieldSchema>;

export const STAGES = ["introduction", "discovery", "summary", "proposal"] as const;
export type StoredStage = (typeof STAGES)[number];

export const EvidenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("message"), message_id: z.string().max(64) }).strict(),
  z.object({ kind: z.literal("field"), field: ProfileFieldKeySchema }).strict(),
]);
export type Evidence = z.infer<typeof EvidenceSchema>;

/** A validated analysis item. `basis` is computed by code from the evidence, never by the AI. */
export const AnalysisItemSchema = z.object({
  title: z.string().min(1).max(120),
  detail: z.string().max(400),
  evidence: z.array(EvidenceSchema).min(1).max(6),
  basis: z.enum(["confirmed", "assumed"]),
  capability: z.string().max(40).nullable(),
}).strict();
export type AnalysisItem = z.infer<typeof AnalysisItemSchema>;

export const AnalysisSchema = z.object({
  processes: z.array(AnalysisItemSchema).max(8),
  repetitive_tasks: z.array(AnalysisItemSchema).max(8),
  bottlenecks: z.array(AnalysisItemSchema).max(8),
  opportunities: z.array(AnalysisItemSchema).max(8),
  rejected_items: z.number().int().min(0),   // items dropped because their evidence didn't check out
  generated_at: z.string(),
  mode: z.enum(["offline-demo", "live"]),
}).strict();
export type Analysis = z.infer<typeof AnalysisSchema>;

export const ProfileDocSchema = z.object({
  version: z.literal(1),
  fields: z.record(ProfileFieldKeySchema, ProfileFieldSchema),
  stage: z.enum(STAGES),
  asked: z.array(ProfileFieldKeySchema),        // fields the consultant has asked about, in order
  last_question_field: ProfileFieldKeySchema.nullable(),
  skipped: z.array(ProfileFieldKeySchema),
  analysis: AnalysisSchema.nullable(),
  analysis_stale: z.boolean(),
}).strict();
export type ProfileDoc = z.infer<typeof ProfileDocSchema>;

export function emptyField(): ProfileField {
  return { value: null, status: "unknown", sources: [], updated_by: null, updated_at: null };
}

export function emptyProfile(): ProfileDoc {
  return {
    version: 1,
    fields: Object.fromEntries(PROFILE_FIELDS.map(k => [k, emptyField()])) as Record<ProfileFieldKey, ProfileField>,
    stage: "introduction",
    asked: [],
    last_question_field: null,
    skipped: [],
    analysis: null,
    analysis_stale: false,
  };
}

export const isKnown = (f: ProfileField) => f.status !== "unknown" && !!f.value;

/** The application, not the AI, decides when there is enough information to analyse. */
export function readiness(p: ProfileDoc): { ready: boolean; missing: ProfileFieldKey[] } {
  const known = (k: ProfileFieldKey) => isKnown(p.fields[k]);
  // Asked once and still unanswered counts as resolved: the consultant doesn't ask the same thing twice.
  // The question currently waiting for an answer is NOT resolved yet.
  const resolved = (k: ProfileFieldKey) => known(k) || p.skipped.includes(k) || (p.asked.includes(k) && p.last_question_field !== k);
  const missing = PROFILE_FIELDS.filter(k => !known(k));
  const mustKnow: ProfileFieldKey[] = ["industry", "products_services"];
  const coreOk = mustKnow.every(known) && CORE_FIELDS.every(resolved);
  const optionalOk = OPTIONAL_FIELDS.filter(resolved).length >= 3;
  return { ready: coreOk && optionalOk, missing };
}
