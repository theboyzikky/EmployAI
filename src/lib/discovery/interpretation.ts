// What a consultant turn UNDERSTOOD from the owner's new message(s), before any state changes.
// Produced by the offline interpreter (rules/interpret.ts); validated like model output. Code then
// applies it to the case file (reasoning.ts). An interpretation can't confirm a cause by itself:
// only the owner's "yes" to a confirmation question, applied by code, does that.
import { z } from "zod";
import { CAPABILITY_KEYS } from "@/lib/catalogue/catalogue";
import { FactSlotSchema } from "./casefile";

const ids = z.array(z.string().max(64)).min(1).max(5);

export const InterpretationSchema = z.object({
  facts: z.array(z.object({
    slot: FactSlotSchema,
    value: z.string().min(1).max(600),
    status: z.enum(["confirmed", "assumed"]),
    sources: ids,
    /** The owner explicitly corrected themself ("Actually…"). */
    correction: z.boolean(),
    /** This fact is the direct answer to the question that was pending. */
    direct: z.boolean(),
  }).strict()).max(20),
  claims: z.array(z.object({
    ref: z.string().max(8),
    kind: z.enum(["symptom", "cause", "goal", "constraint"]),
    text: z.string().min(1).max(400),
    sources: ids,
    /** For a cause: the ref of the symptom it explains. */
    cause_of: z.string().max(8).nullable(),
    /** "Actually, what I really want is…": replaces earlier claims of the same kind. */
    correction: z.boolean(),
  }).strict()).max(10),
  // ---- P6 · understanding first ----
  /** The owner's own name, when they gave it. */
  owner_name: z.object({ value: z.string().min(1).max(80), sources: ids }).strict().nullable(),
  /** The owner's own words for the business ("real estate", "a bakery in Abuja"), for reflecting it back. */
  business: z.object({ verb: z.enum(["in", "run"]), phrase: z.string().min(1).max(120), sources: ids }).strict().nullable(),
  audience: z.enum(["clients", "customers"]).nullable(),
  /** Needs signalled by a goal (stated) or a problem (implied), as catalogue capabilities. */
  needs: z.array(z.object({
    capability: z.enum(CAPABILITY_KEYS),
    label: z.string().min(1).max(80),
    status: z.enum(["stated", "implied", "rejected"]),
    from_ref: z.string().max(8).nullable(),
    sources: ids,
  }).strict()).max(10),
  /** The owner's answer to a gap question that has no profile field ("capability:gap"). */
  gap_answer: z.object({ key: z.string().max(60), text: z.string().min(1).max(400), sources: ids }).strict().nullable(),
  /** The typical-topics inference was confirmed (true) or rejected (false) by the owner's answer. */
  topics_verdict: z.boolean().nullable(),
  /** Statements the reader didn't recognise, kept verbatim (S9). */
  unrecognised: z.array(z.object({ text: z.string().min(1).max(400), sources: ids }).strict()).max(10),
  /** How the new message relates to the question that was pending (null when nothing was pending). */
  answer: z.enum(["answered", "partly", "declined", "unanswered"]).nullable(),
  signals: z.array(z.object({
    playbook: z.string().max(40),
    cause: z.string().max(40),
    /** supports / refutes come from what the owner described; confirms / denies only from a yes or no to a confirmation question. */
    effect: z.enum(["supports", "refutes", "confirms", "denies"]),
    sources: ids,
  }).strict()).max(20),
  unclassified: z.array(z.string().max(64)).max(10),
}).strict();
export type Interpretation = z.infer<typeof InterpretationSchema>;

export const emptyInterpretation = (): Interpretation => ({
  facts: [], claims: [], answer: null, signals: [], unclassified: [],
  owner_name: null, business: null, audience: null, needs: [], gap_answer: null, topics_verdict: null, unrecognised: [],
});
