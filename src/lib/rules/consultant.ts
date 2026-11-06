// Offline consultant (AI_PROVIDER=mock). M3.5: interpretation by deterministic rules (interpret.ts),
// then the same code-owned turn the service runs (reasoning.ts): case-file update, question policy
// and reply. It never invents facts: every fact and claim cites the owner's own message, and a cause
// is confirmed only by the owner's own answer.
import { migrateToCaseFile, type CaseFile } from "@/lib/discovery/casefile";
import type { OfflineTurn } from "@/lib/discovery/merge";
import type { ProfileDoc, ProfileFieldKey } from "@/lib/discovery/profile";
import { runTurn } from "@/lib/discovery/reasoning";
import { interpretOffline } from "./interpret";

export type TurnContext = {
  profile: ProfileDoc;
  /** The consultant's case file; built from the profile (migration) when absent. */
  caseFile?: CaseFile;
  transcript: Array<{ id: string; role: "user" | "assistant"; content: string }>;
  /** Owner messages since the consultant last replied, oldest first. */
  newOwnerMessageIds: string[];
  firstTurn: boolean;
};

export function offlineDiscoveryTurn(ctx: TurnContext): OfflineTurn {
  const caseFile = ctx.caseFile ?? migrateToCaseFile(ctx.profile).case_file!;
  const interpretation = interpretOffline({ caseFile, transcript: ctx.transcript, newOwnerMessageIds: ctx.newOwnerMessageIds, firstTurn: ctx.firstTurn });
  const owner = new Set(ctx.transcript.filter(m => m.role === "user").map(m => m.id));
  const turn = runTurn(ctx.profile, caseFile, interpretation, owner, { firstTurn: ctx.firstTurn });
  // Legacy view of what was understood (M2 shape): facts, plus symptoms as challenges and goals as goals.
  const facts: OfflineTurn["facts"] = [
    ...interpretation.facts.filter(f => f.slot !== "team_size").map(f => ({ field: f.slot as ProfileFieldKey, value: f.value, status: f.status, source_message_ids: f.sources })),
    ...interpretation.claims.filter(c => c.kind === "symptom" || c.kind === "goal").map(c => ({ field: (c.kind === "goal" ? "goals" : "challenges") as ProfileFieldKey, value: c.text, status: "confirmed" as const, source_message_ids: c.sources })),
  ];
  const skipped: ProfileFieldKey[] = interpretation.answer === "declined" && caseFile.pending?.startsWith("fact:") ? [caseFile.pending.slice(5) as ProfileFieldKey] : [];
  return { reply: turn.reply, question_field: turn.questionField, facts, skipped_fields: skipped, interpretation };
}
