import { z } from "zod";
import { normalizeBrands } from "@/lib/text";
import {
  LIST_FIELDS, MAX_FIELD_LENGTH, PROFILE_FIELDS, ProfileFieldKeySchema,
  type ProfileDoc, type ProfileFieldKey,
} from "./profile";
import { InterpretationSchema } from "./interpretation";

/**
 * Output of one consultant turn (the `discovery_turn` AI task). Live models must return exactly this
 * shape (strict JSON schema); the offline consultant returns the same shape. Nothing here can change
 * the stage, confirm the summary or touch agents: those are owner actions handled by code.
 */
export const DiscoveryTurnSchema = z.object({
  reply: z.string().min(1).max(1200),
  question_field: ProfileFieldKeySchema.nullable(),
  facts: z.array(z.object({
    field: ProfileFieldKeySchema,
    value: z.string().min(1).max(MAX_FIELD_LENGTH),
    status: z.enum(["confirmed", "assumed"]),
    source_message_ids: z.array(z.string().max(64)).min(1).max(5),
  }).strict()).max(20),
  skipped_fields: z.array(ProfileFieldKeySchema).max(PROFILE_FIELDS.length),
}).strict();
export type DiscoveryTurn = z.infer<typeof DiscoveryTurnSchema>;

/**
 * M3.5: what the OFFLINE consultant returns. The live schema above is left exactly as it is (it is
 * sent to the model as a strict JSON schema); only the offline provider adds the interpretation.
 * The reply is composed by code from the case file, so it may be empty here.
 */
export const OfflineTurnSchema = DiscoveryTurnSchema.extend({
  reply: z.string().max(1200),
  interpretation: InterpretationSchema,
}).strict();
export type OfflineTurn = z.infer<typeof OfflineTurnSchema>;

export type MergeResult = {
  profile: ProfileDoc;
  applied: Array<{ field: ProfileFieldKey; value: string; status: "confirmed" | "assumed" }>;
  rejected: number;
};

const splitList = (v: string) => v.split(/\s*,\s*/).map(s => s.trim()).filter(Boolean);

/**
 * Merge extracted facts into the profile, with rules enforced by code:
 * - a fact must cite at least one real message from THIS conversation written by the owner;
 * - fields the owner edited by hand are never changed by the consultant;
 * - an assumption never overwrites a confirmed answer;
 * - list fields (channels, tools) accumulate.
 */
export function mergeFacts(
  profile: ProfileDoc,
  facts: DiscoveryTurn["facts"],
  ownerMessageIds: ReadonlySet<string>,
  now = new Date().toISOString(),
): MergeResult {
  const next: ProfileDoc = structuredClone(profile);
  const applied: MergeResult["applied"] = [];
  let rejected = 0;
  for (const f of facts) {
    const sources = f.source_message_ids.filter(id => ownerMessageIds.has(id));
    if (sources.length === 0) { rejected++; continue; }          // ungrounded → dropped
    const cur = next.fields[f.field];
    if (cur.updated_by === "owner") continue;                    // owner edits win
    if (f.status === "assumed" && cur.status === "confirmed") continue;
    let value = normalizeBrands(f.value.trim()).slice(0, MAX_FIELD_LENGTH); // "whatsapp" → "WhatsApp" (live AI output too)
    if (LIST_FIELDS.includes(f.field) && cur.value) {
      value = [...new Set([...splitList(cur.value), ...splitList(value)])].join(", ").slice(0, MAX_FIELD_LENGTH);
    }
    next.fields[f.field] = {
      value,
      status: f.status,
      sources: [...new Set([...cur.sources, ...sources])].slice(-30),
      updated_by: "consultant",
      updated_at: now,
    };
    next.skipped = next.skipped.filter(k => k !== f.field);
    applied.push({ field: f.field, value, status: f.status });
  }
  return { profile: next, applied, rejected };
}
