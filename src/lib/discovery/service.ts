import "server-only";
import { getAi } from "@/lib/ai";
import { normalizeBrands } from "@/lib/text";
import { AiError, describeAiError, type AiErrorCode } from "@/lib/ai/errors";
import { ANALYSIS_SYSTEM, DISCOVERY_SYSTEM, PROMPT_VERSION, renderProfile, renderTranscript } from "@/lib/ai/prompts";
import { applyAgentPatch, proposeTeam, teamWarnings, type AgentPatch } from "@/lib/catalogue/propose";
import type { AgentKey } from "@/lib/catalogue/catalogue";
import type { TurnContext } from "@/lib/rules/consultant";
import { groundAnalysis, RawAnalysisSchema } from "./analysis";
import { DiscoveryTurnSchema, mergeFacts } from "./merge";
import { FIELD_LABELS, MAX_FIELD_LENGTH, PROFILE_FIELDS, isKnown, readiness, type ProfileDoc, type ProfileFieldKey } from "./profile";
import { discoveryRepository, type AgentRecord, type BusinessRecord, type MessageRecord } from "./store";

export const MAX_OWNER_MESSAGES = 40;      // per discovery session (bounds AI cost in live mode)
const MAX_TURNS_PER_MINUTE = 10;
const SKIP_TEXT = "Skip this question.";

export class ServiceError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) { super(message); }
}
export type AiFailure = { code: AiErrorCode | "UNKNOWN"; message: string };

// In-process guards (single dev server). The Supabase version keeps the same contract.
const busy = new Set<string>();
const recentTurns = new Map<string, number[]>();

async function withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  if (busy.has(id)) throw new ServiceError("TURN_IN_PROGRESS", 409, "The consultant is still working on your last message.");
  busy.add(id);
  try { return await fn(); } finally { busy.delete(id); }
}

function rateCheck(id: string) {
  const now = Date.now();
  const list = (recentTurns.get(id) ?? []).filter(t => now - t < 60_000);
  if (list.length >= MAX_TURNS_PER_MINUTE) throw new ServiceError("RATE_LIMITED", 429, "That's a lot of messages in a short time. Please wait a moment.");
  list.push(now);
  recentTurns.set(id, list);
}

const ownerIds = (messages: MessageRecord[]) => new Set(messages.filter(m => m.role === "user").map(m => m.id));
const isApproved = (agents: AgentRecord[]) => agents.some(a => a.status === "approved");

function toAiFailure(e: unknown): AiFailure {
  const code = e instanceof AiError ? e.code : "UNKNOWN";
  // Log the code only: never message content, prompts or provider responses.
  console.warn(`[discovery] AI call failed: ${code}`);
  return { code, message: describeAiError(code) };
}

/** Owner messages written since the consultant's last reply. */
export function pendingOwnerMessages(messages: MessageRecord[]): MessageRecord[] {
  const lastAssistant = messages.map(m => m.role).lastIndexOf("assistant");
  return messages.slice(lastAssistant + 1).filter(m => m.role === "user");
}

function syncColumns(profile: ProfileDoc): Pick<BusinessRecord, "name" | "business_type"> {
  return {
    name: isKnown(profile.fields.business_name) ? profile.fields.business_name.value : null,
    business_type: isKnown(profile.fields.industry) ? profile.fields.industry.value : null,
  };
}

/**
 * One consultant turn. The owner's message is saved FIRST, so an AI failure or timeout never loses
 * it: the reply can be retried later (send again with no content).
 */
export async function consultantTurn(business: BusinessRecord, input: { content?: string; clientMessageId?: string; skip?: boolean }): Promise<{ aiError: AiFailure | null }> {
  const repo = discoveryRepository();
  return withLock(business.id, async () => {
    const fresh = (await repo.getBusiness(business.id))!;
    if (fresh.profile.stage !== "introduction" && fresh.profile.stage !== "discovery") {
      throw new ServiceError("STATE_CONFLICT", 409, "Discovery is complete. Edit the summary to make corrections.");
    }
    let messages = await repo.listMessages(business.id);
    const text = input.skip ? SKIP_TEXT : input.content;
    if (text) {
      if (messages.filter(m => m.role === "user").length >= MAX_OWNER_MESSAGES) {
        throw new ServiceError("RATE_LIMITED", 429, "This conversation has reached its message limit. Please analyse what you have, or start a new conversation.");
      }
      rateCheck(business.id);
      await repo.appendMessage({ business_id: business.id, role: "user", content: text, meta: { kind: "answer", client_message_id: input.clientMessageId } });
      messages = await repo.listMessages(business.id);
    }
    const pending = pendingOwnerMessages(messages);
    if (pending.length === 0) return { aiError: null }; // nothing to answer (e.g. a duplicate retry)

    const profile = fresh.profile;
    const firstTurn = !messages.some(m => m.role === "assistant");
    const transcript = messages.map(m => ({ id: m.id, role: m.role, content: m.content }));
    const context: TurnContext = { profile, transcript, newOwnerMessageIds: pending.map(m => m.id), firstTurn };
    const user = [
      `Prompt version: ${PROMPT_VERSION}`,
      `Profile so far (status in brackets):\n${renderProfile(profile)}`,
      `Fields already asked about: ${profile.asked.join(", ") || "none"}`,
      `New owner message IDs to process: ${pending.map(m => m.id).join(", ")}`,
      `Conversation:\n${renderTranscript(transcript)}`,
    ].join("\n\n");

    let result;
    try {
      const ai = await getAi();
      result = await ai.structured({ task: "discovery_turn", schema: DiscoveryTurnSchema, system: DISCOVERY_SYSTEM, user, context, maxTokens: 900 });
    } catch (e) {
      return { aiError: toAiFailure(e) };
    }

    const turn = result.data;
    const merged = mergeFacts(profile, turn.facts, ownerIds(messages));
    const next = merged.profile;
    // Skips are only accepted for fields that are still unknown.
    next.skipped = [...new Set([...next.skipped, ...turn.skipped_fields.filter(k => !isKnown(next.fields[k]))])];
    const q = turn.question_field && !isKnown(next.fields[turn.question_field]) ? turn.question_field : null;
    if (q && !next.asked.includes(q)) next.asked = [...next.asked, q];
    next.last_question_field = q;
    next.stage = "discovery";

    await repo.updateBusiness(business.id, { profile: next, ...syncColumns(next) });
    await repo.appendMessage({
      business_id: business.id, role: "assistant", content: turn.reply,
      meta: { kind: q ? "question" : "insight", provider: result.provider, model: result.model, mode: result.mode, tokens: result.usage, cost_usd: result.costUsd },
    });
    return { aiError: null };
  });
}

/** Stage 3: analyse operations from the owner's answers (grounded; see groundAnalysis). */
export async function analyse(business: BusinessRecord): Promise<{ aiError: AiFailure | null }> {
  const repo = discoveryRepository();
  return withLock(business.id, async () => {
    const fresh = (await repo.getBusiness(business.id))!;
    const stage = fresh.profile.stage;
    if (stage === "proposal") throw new ServiceError("STATE_CONFLICT", 409, "The summary is already confirmed.");
    if (stage === "discovery" && !readiness(fresh.profile).ready) {
      throw new ServiceError("STATE_CONFLICT", 409, "The consultant needs a little more information first.");
    }
    if (stage === "introduction") throw new ServiceError("STATE_CONFLICT", 409, "Discovery hasn't started yet.");
    const messages = await repo.listMessages(business.id);
    const transcript = messages.map(m => ({ id: m.id, role: m.role, content: m.content }));
    const user = [
      `Prompt version: ${PROMPT_VERSION}`,
      `Profile (status in brackets):\n${renderProfile(fresh.profile)}`,
      `Owner messages:\n${renderTranscript(transcript.filter(m => m.role === "user"), 40)}`,
    ].join("\n\n");

    let result;
    try {
      const ai = await getAi();
      result = await ai.structured({ task: "business_analysis", schema: RawAnalysisSchema, system: ANALYSIS_SYSTEM, user, context: { profile: fresh.profile }, maxTokens: 1800 });
    } catch (e) {
      return { aiError: toAiFailure(e) };
    }
    const analysis = groundAnalysis(result.data, fresh.profile, ownerIds(messages), result.mode);
    const first = fresh.profile.analysis === null;
    const profile: ProfileDoc = { ...fresh.profile, analysis, analysis_stale: false, stage: "summary", last_question_field: null };
    await repo.updateBusiness(business.id, { profile });
    await repo.appendMessage({
      business_id: business.id, role: "assistant",
      content: first
        ? "I've analysed how the business runs. Below are the processes, repetitive work, bottlenecks and automation opportunities I found, each linked to what you told me. Please check the summary and correct anything I got wrong."
        : "I've updated the analysis with your corrections.",
      meta: { kind: "analysis", provider: result.provider, model: result.model, mode: result.mode, tokens: result.usage, cost_usd: result.costUsd },
    });
    return { aiError: null };
  });
}

export type FieldEdits = Partial<Record<ProfileFieldKey, string | null>>;

/** Owner corrections. They lock the field against consultant changes and mark the analysis stale. */
export async function editProfile(business: BusinessRecord, edits: FieldEdits): Promise<void> {
  const repo = discoveryRepository();
  const agents = await repo.listAgents(business.id);
  if (isApproved(agents)) throw new ServiceError("STATE_CONFLICT", 409, "The team is already approved, so the summary is locked.");
  const fresh = (await repo.getBusiness(business.id))!;
  if (fresh.profile.stage === "introduction") throw new ServiceError("STATE_CONFLICT", 409, "Discovery hasn't started yet.");
  const profile = applyEdits(fresh.profile, edits);
  const reopen = fresh.profile.stage === "proposal";
  if (reopen) profile.stage = "summary";
  await repo.updateBusiness(business.id, {
    profile, ...syncColumns(profile),
    ...(reopen ? { profile_confirmed_at: null, summary: null, status: "discovering" as const } : {}),
  });
  if (reopen) await repo.replaceAgents(business.id, []); // the old proposal no longer matches
}

function applyEdits(p: ProfileDoc, edits: FieldEdits): ProfileDoc {
  const next = structuredClone(p);
  const now = new Date().toISOString();
  let changed = false;
  for (const k of PROFILE_FIELDS) {
    if (!(k in edits)) continue;
    const raw = edits[k];
    // Brand casing only ("whatsapp" → "WhatsApp"); the owner's wording is otherwise kept as typed.
    const value = raw ? normalizeBrands(raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim()).slice(0, MAX_FIELD_LENGTH) : "";
    const cur = next.fields[k];
    if ((cur.value ?? "") === value && (value === "" || cur.status === "confirmed")) continue;
    next.fields[k] = value
      ? { value, status: "confirmed", sources: cur.sources, updated_by: "owner", updated_at: now }
      : { value: null, status: "unknown", sources: [], updated_by: "owner", updated_at: now };
    changed = true;
  }
  if (changed && next.analysis) next.analysis_stale = true;
  return next;
}

/** Stage 4 → 5: the owner confirms the summary. Assumptions shown for review become confirmed. */
export async function confirmSummary(business: BusinessRecord, edits: FieldEdits | undefined): Promise<void> {
  const repo = discoveryRepository();
  const fresh = (await repo.getBusiness(business.id))!;
  if (fresh.profile.stage !== "summary") throw new ServiceError("STATE_CONFLICT", 409, "There's no summary to confirm yet.");
  let profile = edits ? applyEdits(fresh.profile, edits) : structuredClone(fresh.profile);
  if (!profile.analysis || profile.analysis_stale) {
    throw new ServiceError("ANALYSIS_STALE", 409, "Your corrections changed the picture. Update the analysis before confirming.");
  }
  if (!isKnown(profile.fields.industry) || !isKnown(profile.fields.products_services)) {
    throw new ServiceError("VALIDATION_FAILED", 400, "Please fill in the industry and what you sell before confirming.");
  }
  const now = new Date().toISOString();
  for (const k of PROFILE_FIELDS) {
    const f = profile.fields[k];
    if (f.status === "assumed") profile.fields[k] = { ...f, status: "confirmed", updated_at: now };
  }
  profile = { ...profile, stage: "proposal" };
  await repo.updateBusiness(business.id, { profile, ...syncColumns(profile), profile_confirmed_at: now, summary: summaryText(profile) });
}

export function summaryText(p: ProfileDoc): string {
  return PROFILE_FIELDS.filter(k => isKnown(p.fields[k])).map(k => `${FIELD_LABELS[k]}: ${p.fields[k].value}`).join("\n");
}

/** Stage 5: deterministic team proposal from the confirmed analysis (FR-05: blocked until confirmed). */
export async function proposeTeamFor(business: BusinessRecord): Promise<void> {
  const repo = discoveryRepository();
  const fresh = (await repo.getBusiness(business.id))!;
  if (!fresh.profile_confirmed_at || !fresh.profile.analysis) throw new ServiceError("STATE_CONFLICT", 409, "Confirm the business summary before the team is proposed.");
  if (isApproved(await repo.listAgents(business.id))) throw new ServiceError("STATE_CONFLICT", 409, "The team is already approved.");
  const team = proposeTeam(fresh.profile.analysis);
  await repo.replaceAgents(business.id, team.map(a => ({ ...a, status: "proposed" as const, approved_at: null, near_account_id: null })));
  await repo.updateBusiness(business.id, { status: "team_proposed" });
}

export async function updateAgent(business: BusinessRecord, key: AgentKey, patch: AgentPatch): Promise<void> {
  const repo = discoveryRepository();
  const agents = await repo.listAgents(business.id);
  if (isApproved(agents)) throw new ServiceError("STATE_CONFLICT", 409, "The team is already approved.");
  const agent = agents.find(a => a.key === key);
  if (!agent) throw new ServiceError("NOT_FOUND", 404, "That agent isn't part of this proposal.");
  const def = applyAgentPatch(agent.definition, patch);
  if ("error" in def) throw new ServiceError("VALIDATION_FAILED", 400, def.error);
  await repo.updateAgent(business.id, key, { definition: def, ...(patch.status ? { status: patch.status } : {}) });
}

/** The owner approves the team. Approval is recorded; nothing is deployed or executed. */
export async function approveTeam(business: BusinessRecord): Promise<void> {
  const repo = discoveryRepository();
  const agents = await repo.listAgents(business.id);
  if (agents.length === 0) throw new ServiceError("STATE_CONFLICT", 409, "There's no proposed team to approve.");
  if (isApproved(agents)) throw new ServiceError("STATE_CONFLICT", 409, "The team is already approved.");
  const kept = agents.filter(a => a.status !== "removed");
  if (kept.length === 0) throw new ServiceError("VALIDATION_FAILED", 400, "Keep at least one agent to approve the team.");
  const now = new Date().toISOString();
  for (const a of kept) await repo.updateAgent(business.id, a.key, { status: "approved", approved_at: now });
  await repo.appendMessage({
    business_id: business.id, role: "assistant",
    content: `Team approved: ${kept.map(a => a.name).join(", ")}. Nothing runs yet. Workflows are generated, tested and deployed only with your approval in the next stage.`,
    meta: { kind: "note" },
  });
}

export { teamWarnings };
