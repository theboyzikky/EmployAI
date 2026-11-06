// Offline consultant (AI_PROVIDER=mock): produces the same DiscoveryTurn shape as a live model,
// from deterministic rules. It never invents facts: every fact comes from the owner's own message.
import { FIELD_LABELS, LIST_FIELDS, isKnown, readiness, type ProfileDoc, type ProfileFieldKey } from "@/lib/discovery/profile";
import { mergeFacts, type DiscoveryTurn } from "@/lib/discovery/merge";
import { extractFacts, extractFromAnswer } from "./extract";
import { nextQuestionField, questionFor } from "./questions";

export type TurnContext = {
  profile: ProfileDoc;
  transcript: Array<{ id: string; role: "user" | "assistant"; content: string }>;
  /** Owner messages since the consultant last replied, oldest first. */
  newOwnerMessageIds: string[];
  firstTurn: boolean;
};

const short = (s: string, n = 80) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

export function offlineDiscoveryTurn(ctx: TurnContext): DiscoveryTurn {
  const byId = new Map(ctx.transcript.map(m => [m.id, m]));
  const facts: DiscoveryTurn["facts"] = [];
  const skipped: ProfileFieldKey[] = [];
  ctx.newOwnerMessageIds.forEach((id, i) => {
    const msg = byId.get(id);
    if (!msg || msg.role !== "user") return;
    // Only the first new message answers the pending question; later ones are extra detail.
    const asked = i === 0 && !ctx.firstTurn ? ctx.profile.last_question_field : null;
    const r = asked ? extractFromAnswer(msg.content, asked) : { facts: extractFacts(msg.content), skipped: false };
    if (r.skipped && asked) skipped.push(asked);
    for (const f of r.facts) {
      // A direct answer may replace an earlier value; a side mention only fills a gap (or adds to a list),
      // so a passing keyword never overwrites something the owner answered properly.
      const direct = f.field === asked;
      if (!direct && !LIST_FIELDS.includes(f.field) && isKnown(ctx.profile.fields[f.field])) continue;
      facts.push({ ...f, source_message_ids: [id] });
    }
  });

  // Preview the merge so the reply reflects what was actually captured.
  const owner = new Set(ctx.transcript.filter(m => m.role === "user").map(m => m.id));
  const merged = mergeFacts(ctx.profile, facts, owner);
  const preview: ProfileDoc = { ...merged.profile, skipped: [...new Set([...merged.profile.skipped, ...skipped])] };
  const { ready } = readiness(preview);
  const field = ready ? null : nextQuestionField(preview);
  const name = preview.fields.business_name.value;

  let reply: string;
  const wasReady = readiness(ctx.profile).ready;
  if (ready && wasReady) {
    const noted = merged.applied.slice(0, 2);
    reply = (noted.length ? `Noted: ${noted.map(a => `${FIELD_LABELS[a.field].toLowerCase()}, “${short(a.value, 70)}”`).join("; ")}. ` : "Thanks, I've added that. ")
      + "Add anything else you'd like, or choose “Analyse my business” when you're ready.";
  } else if (ready) {
    reply = `Thank you, that gives me a clear picture of ${name ?? "your business"}. I have what I need to analyse how it runs.\n\n`
      + "When you're ready, choose “Analyse my business” below. You can also keep adding detail first.";
  } else {
    const noted = merged.applied.slice(0, ctx.firstTurn ? 6 : 2);
    let lead: string;
    if (ctx.firstTurn) {
      lead = noted.length
        ? `Thanks for the introduction. Here's what I've noted so far:\n${noted.map(a => `• ${FIELD_LABELS[a.field]}: ${short(a.value)}`).join("\n")}\n\n`
          + "I'll ask a few short questions to fill in the gaps. Answer in your own words, or say “skip” for anything you'd rather not share."
        : "Thanks for getting in touch. I'll ask a few short questions to understand how your business works. Answer in your own words, or say “skip” for anything you'd rather not share.";
    } else if (skipped.length) {
      lead = "No problem, we'll leave that out.";
    } else if (noted.length) {
      lead = `Noted: ${noted.map(a => `${FIELD_LABELS[a.field].toLowerCase()}, “${short(a.value, 70)}”`).join("; ")}.`;
    } else {
      lead = "Thanks.";
    }
    reply = field ? `${lead}\n\n${questionFor(field, preview)}` : `${lead}\n\nIs there anything else about how the business runs that I should know?`;
  }
  return { reply, question_field: field, facts, skipped_fields: skipped };
}
