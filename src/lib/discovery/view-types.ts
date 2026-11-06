// Client-safe types for the consultant workspace (no server imports).
import type { AgentKey } from "@/lib/catalogue/catalogue";
import type { FieldStatus, ProfileFieldKey } from "./profile";

export type ViewEvidence =
  | { kind: "message"; label: string; text: string }
  | { kind: "field"; label: string; text: string; status: "confirmed" | "assumed" };

export type ViewInsight = { title: string; detail: string; basis: "confirmed" | "supported" | "assumed"; capability: string | null; evidence: ViewEvidence[] };

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
      reasons: Array<{ title: string; detail: string; basis: "confirmed" | "supported" | "assumed"; evidence: ViewEvidence[] }>;
      collaboratesWith: string[]; tools: string[]; financialPermissions: string; prohibited: string[]; approvals: string[]; ownerNote: string;
    }>;
    proposed: boolean;
    warnings: string[];
    approvedAt: string | null;
  } | null;
  /** M3.5: the consultant's reasoning, from the case file. */
  understanding: ViewUnderstanding;
  ai: { label: string; provider: "mock" | "nearai" | "ollama" | null; problem: string | null };
  limits: { maxMessageLength: number; ownerMessagesLeft: number };
};

export type ApiFailure = { error: { code: string; message: string; correlation_id: string }; view?: DiscoveryView; ai?: { code: string; message: string } };

export type ViewCauseStatus = "checking" | "supported" | "ruled_out" | "confirmed";
export type ViewUnderstanding = {
  /** True when this discovery was captured before the M3.5 consultant could investigate causes. */
  preM35: boolean;
  problems: Array<{
    id: string;
    symptom: string;
    /** The owner's own explanation, shown as their view until confirmed. */
    ownerView: string | null;
    ownerViewStatus: "stated" | "confirmed" | "questioned" | null;
    /** The playbook's problem title, or null when the consultant doesn't recognise the problem. */
    recognisedAs: string | null;
    resolution: "open" | "cause_confirmed" | "cause_supported" | "unknown";
    causes: Array<{ label: string; status: ViewCauseStatus; ownerView: boolean }>;
    uncertainty: string | null;
    /** P6: investigated because of a goal the owner stated (what's behind it). */
    fromGoal: boolean;
  }>;
  /** P6 · understanding first. */
  owner: { name: string | null; business: string | null };
  goals: string[];
  needs: Array<{ label: string; status: "stated" | "implied" }>;
  /** Agents being considered: never committed before the analysis. */
  solutions: Array<{ agent: string; for: string; preview: boolean }>;
  /** Kept apart (S10): implied by the owner's words vs typical for the industry. */
  inferences: Array<{ kind: "implied" | "typical"; statement: string; reason: string; status: "inferred" | "confirmed" | "rejected"; settledBy: "owner_words" | "summary_review" | null; ownerWords: string | null }>;
  /** Statements kept verbatim because the consultant didn't understand them (S9). */
  unrecognised: Array<{ text: string; clarification: string | null }>;
  contradictions: Array<{ label: string; a: string; b: string; status: "open" | "resolved"; kind: "contradiction" | "correction"; resolution: string | null }>;
  asking: { kind: string; target: string; label: string } | null;
  questionsAsked: number;
  maxQuestions: number;
};
