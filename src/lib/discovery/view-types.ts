// Client-safe types for the consultant workspace (no server imports).
import type { AgentKey } from "@/lib/catalogue/catalogue";
import type { FieldStatus, ProfileFieldKey } from "./profile";

export type ViewEvidence =
  | { kind: "message"; label: string; text: string }
  | { kind: "field"; label: string; text: string; status: "confirmed" | "assumed" };

export type ViewInsight = { title: string; detail: string; basis: "confirmed" | "assumed"; capability: string | null; evidence: ViewEvidence[] };

export type ViewStage = "introduction" | "discovery" | "summary" | "proposal" | "approved";

export type DiscoveryView = {
  id: string;
  stage: ViewStage;
  /** 0 Introduce · 1 Discover · 2 Analyse · 3 Confirm · 4 Review team */
  stageIndex: number;
  businessName: string | null;
  /** True only for the restaurant demo, the one runnable workflow scenario in this prototype. */
  runnable: boolean;
  ready: boolean;
  pendingReply: boolean;
  messages: Array<{ id: string; role: "user" | "assistant"; kind: string; content: string; createdAt: string; mode: "offline-demo" | "live" | null; clientMessageId: string | null }>;
  fields: Array<{ key: ProfileFieldKey; label: string; value: string | null; status: FieldStatus; skipped: boolean; editedByOwner: boolean; sources: string[] }>;
  analysis: {
    processes: ViewInsight[]; repetitiveTasks: ViewInsight[]; bottlenecks: ViewInsight[]; opportunities: ViewInsight[];
    rejectedItems: number; mode: "offline-demo" | "live"; generatedAt: string;
  } | null;
  analysisStale: boolean;
  confirmedAt: string | null;
  team: {
    agents: Array<{
      key: AgentKey; name: string; status: "proposed" | "approved" | "removed"; executable: boolean; approvedAt: string | null;
      role: string; purpose: string; tasks: Array<{ id: string; label: string; enabled: boolean }>;
      reasons: Array<{ title: string; detail: string; basis: "confirmed" | "assumed"; evidence: ViewEvidence[] }>;
      collaboratesWith: string[]; tools: string[]; financialPermissions: string; prohibited: string[]; approvals: string[]; ownerNote: string;
    }>;
    proposed: boolean;
    warnings: string[];
    approvedAt: string | null;
  } | null;
  ai: { label: string; provider: "mock" | "nearai" | "ollama" | null; problem: string | null };
  limits: { maxMessageLength: number; ownerMessagesLeft: number };
};

export type ApiFailure = { error: { code: string; message: string; correlation_id: string }; view?: DiscoveryView; ai?: { code: string; message: string } };
