import { z } from "zod";
import { CAPABILITY_KEYS } from "@/lib/catalogue/catalogue";
import {
  EvidenceSchema, isKnown,
  type Analysis, type AnalysisItem, type Evidence, type ProfileDoc,
} from "./profile";
import type { CaseFile } from "./casefile";
import { causeOf, playbookByKey } from "./playbooks";

/** What a model (or the offline rules) returns for the `business_analysis` task. Code adds `basis`. */
const RawItem = z.object({
  title: z.string().min(1).max(120),
  detail: z.string().max(400),
  evidence: z.array(EvidenceSchema).min(1).max(6),
  capability: z.enum(CAPABILITY_KEYS).nullable(),
}).strict();
export const RawAnalysisSchema = z.object({
  processes: z.array(RawItem).max(8),
  repetitive_tasks: z.array(RawItem).max(8),
  bottlenecks: z.array(RawItem).max(8),
  opportunities: z.array(RawItem).max(8),
}).strict();
export type RawAnalysis = z.infer<typeof RawAnalysisSchema>;
export type RawItem = z.infer<typeof RawItem>;

const SECTIONS = ["processes", "repetitive_tasks", "bottlenecks", "opportunities"] as const;
/** Fields that say what the business IS, not how it operates; they can't confirm an operational insight. */
const IDENTITY_FIELDS = new Set(["industry", "business_name"]);

/**
 * Ground every insight in what the owner actually said:
 * - evidence must be one of the owner's messages in this session, or a profile field that is known;
 * - items with no valid evidence are dropped and counted;
 * - an item is "confirmed" only if it rests on an owner message or a confirmed operational field;
 *   otherwise it is labelled "assumed" and the UI says so.
 */
export function groundAnalysis(raw: RawAnalysis, profile: ProfileDoc, ownerMessageIds: ReadonlySet<string>, mode: Analysis["mode"], now = new Date().toISOString()): Analysis {
  let rejected = 0;
  const valid = (e: Evidence) => (e.kind === "message" ? ownerMessageIds.has(e.message_id) : isKnown(profile.fields[e.field]));
  const out = {} as Record<(typeof SECTIONS)[number], AnalysisItem[]>;
  for (const s of SECTIONS) {
    out[s] = [];
    const seen = new Set<string>();
    for (const item of raw[s]) {
      const evidence = dedupe(item.evidence.filter(valid));
      if (evidence.length === 0) { rejected++; continue; }
      const key = item.title.trim().toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const confirmed = evidence.some(e => e.kind === "message"
        || (!IDENTITY_FIELDS.has(e.field) && profile.fields[e.field].status === "confirmed"));
      out[s].push({ title: item.title.trim(), detail: item.detail.trim(), evidence, capability: item.capability, basis: confirmed ? "confirmed" : "assumed" });
    }
  }
  return { ...out, rejected_items: rejected, generated_at: now, mode };
}

function dedupe(ev: Evidence[]): Evidence[] {
  const seen = new Set<string>();
  return ev.filter(e => {
    const k = e.kind === "message" ? `m:${e.message_id}` : `f:${e.field}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * M3.5: the basis of each recommendation follows the case file, decided by code. An improvement for
 * a cause the owner confirmed is "confirmed"; for a cause their answers support but they haven't
 * confirmed, "supported"; "measure first" items (cause unknown) are "assumed" (possible, not verified).
 */
export function caseBasis(analysis: Analysis, cf: CaseFile): Analysis {
  const status = new Map<string, "confirmed" | "supported">();
  const measures = new Set<string>(["Measure first: keep a note of when it happens and what led to it"]);
  for (const p of cf.problems) {
    const pb = playbookByKey(p.playbook);
    if (!pb) continue;
    measures.add(pb.measure.title);
    for (const h of p.hypotheses) {
      const fix = causeOf(pb, h.key)?.fix;
      if (!fix) continue;
      if (h.status === "confirmed") status.set(fix, "confirmed");
      else if (h.status === "supported" && status.get(fix) !== "confirmed") status.set(fix, "supported");
    }
  }
  const opportunities = analysis.opportunities.map(o => {
    if (measures.has(o.title)) return { ...o, basis: "assumed" as const };
    const s = [...status.entries()].find(([fix]) => o.title === fix || o.title.startsWith(`${fix} (`))?.[1];
    return s ? { ...o, basis: s === "confirmed" ? o.basis : "supported" as const } : o;
  });
  return { ...analysis, opportunities };
}
