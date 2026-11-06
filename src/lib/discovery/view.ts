import "server-only";
import { configuredProvider } from "@/lib/ai/factory";
import { isRunnableIndustry } from "@/lib/workflows/demo-data";
import { teamWarnings } from "@/lib/catalogue/propose";
import type { AgentKey } from "@/lib/catalogue/catalogue";
import { MAX_MESSAGE_LENGTH } from "./message";
import { FIELD_LABELS, PROFILE_FIELDS, isKnown, readiness, type AnalysisItem, type Evidence } from "./profile";
import { MAX_OWNER_MESSAGES, pendingOwnerMessages } from "./service";
import { discoveryRepository, type BusinessRecord, type MessageKind } from "./store";
import type { DiscoveryView, ViewEvidence } from "./view-types";

export type { DiscoveryView } from "./view-types";

const excerpt = (s: string, n = 140) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

/** Everything the consultant workspace needs, for the owner only. Never includes other sessions. */
export async function buildView(b: BusinessRecord): Promise<DiscoveryView> {
  const repo = discoveryRepository();
  const [business, messages, agents] = await Promise.all([repo.getBusiness(b.id), repo.listMessages(b.id), repo.listAgents(b.id)]);
  const p = business!.profile;
  const byId = new Map(messages.map(m => [m.id, m]));
  const resolve = (e: Evidence): ViewEvidence => e.kind === "message"
    ? { kind: "message", label: "You said", text: excerpt(byId.get(e.message_id)?.content ?? "") }
    : { kind: "field", label: FIELD_LABELS[e.field], text: excerpt(p.fields[e.field].value ?? ""), status: p.fields[e.field].status === "confirmed" ? "confirmed" : "assumed" };
  const items = (list: AnalysisItem[]) => list.map(i => ({ title: i.title, detail: i.detail, basis: i.basis, capability: i.capability, evidence: i.evidence.map(resolve) }));

  const approved = agents.some(a => a.status === "approved");
  const { ready } = readiness(p);
  const stage: DiscoveryView["stage"] = approved ? "approved" : p.stage;
  const stageIndex = stage === "introduction" ? 0 : stage === "discovery" ? (ready ? 2 : 1) : stage === "summary" ? 3 : 4;
  const ai = configuredProvider(process.env);
  const runnable = isRunnableIndustry(business!.business_type);

  return {
    id: b.id,
    stage,
    stageIndex,
    businessName: business!.name,
    runnable,
    ready: p.stage === "discovery" && ready,
    pendingReply: (p.stage === "introduction" || p.stage === "discovery") && pendingOwnerMessages(messages).length > 0,
    messages: messages.map(m => ({
      id: m.id, role: m.role, kind: m.meta.kind as MessageKind, content: m.content, createdAt: m.created_at,
      mode: m.meta.mode ?? null, clientMessageId: m.meta.client_message_id ?? null,
    })),
    fields: PROFILE_FIELDS.map(k => {
      const f = p.fields[k];
      return {
        key: k, label: FIELD_LABELS[k], value: isKnown(f) ? f.value : null, status: f.status,
        skipped: p.skipped.includes(k), editedByOwner: f.updated_by === "owner",
        sources: f.sources.filter(id => byId.has(id)).slice(-3).map(id => excerpt(byId.get(id)!.content, 100)),
      };
    }),
    analysis: p.analysis ? {
      processes: items(p.analysis.processes), repetitiveTasks: items(p.analysis.repetitive_tasks),
      bottlenecks: items(p.analysis.bottlenecks), opportunities: items(p.analysis.opportunities),
      rejectedItems: p.analysis.rejected_items, mode: p.analysis.mode, generatedAt: p.analysis.generated_at,
    } : null,
    analysisStale: p.analysis_stale,
    confirmedAt: business!.profile_confirmed_at,
    team: agents.length || p.stage === "proposal" ? {
      agents: agents.map(a => ({
        // Only the restaurant scenario is runnable in this prototype; other industries stay Preview.
        key: a.key as AgentKey, name: a.name, status: a.status, executable: a.executable && runnable, approvedAt: a.approved_at,
        role: a.definition.role, purpose: a.definition.purpose, tasks: a.definition.tasks, reasons: a.definition.reasons.map(r => ({ title: r.title, detail: r.detail, basis: r.basis, evidence: r.evidence.map(resolve) })),
        collaboratesWith: a.definition.collaborates_with.map(k => agents.find(x => x.key === k)?.name).filter((n): n is string => !!n),
        tools: a.definition.allowed_tools, financialPermissions: a.definition.financial_permissions,
        prohibited: a.definition.prohibited_actions, approvals: a.definition.approval_requirements, ownerNote: a.definition.owner_note,
      })),
      proposed: agents.length > 0,
      warnings: teamWarnings(agents.map(a => ({ key: a.key, status: a.status }))),
      approvedAt: agents.find(a => a.approved_at)?.approved_at ?? null,
    } : null,
    ai: { label: ai.label, provider: ai.name, problem: ai.problem },
    limits: { maxMessageLength: MAX_MESSAGE_LENGTH, ownerMessagesLeft: Math.max(0, MAX_OWNER_MESSAGES - messages.filter(m => m.role === "user").length) },
  };
}
