import { z } from "zod";
import { MAX_FIELD_LENGTH, PROFILE_FIELDS, type ProfileFieldKey } from "./profile";

/** Owner corrections to the summary: any subset of profile fields; null or "" clears a field. */
export const FieldEditsSchema = z.object(
  Object.fromEntries(PROFILE_FIELDS.map(k => [k, z.string().max(MAX_FIELD_LENGTH).nullable().optional()])) as Record<ProfileFieldKey, z.ZodOptional<z.ZodNullable<z.ZodString>>>,
).strict();
