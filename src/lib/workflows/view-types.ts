// Client-safe types for the workspace (Team + Workflows tabs).
import type { AgentKey } from "@/lib/catalogue/catalogue";
import type { DemoScenario } from "./demo-data";
import type { ValidationResult, WorkflowDoc, WorkflowStatus } from "./schema";

export type WorkspaceAgent = {
  key: AgentKey; name: string; role: string; purpose: string;
  status: "proposed" | "approved" | "removed" | "paused"; runnable: boolean;
  tasks: Array<{ id: string; label: string; enabled: boolean }>;
  tools: string[]; financialPermissions: string; prohibited: string[];
};

export type WorkspaceWorkflow = {
  id: string; version: number; status: WorkflowStatus; approvedAt: string | null; createdAt: string;
  doc: WorkflowDoc; validation: ValidationResult;
};

export type WorkspaceView = {
  businessId: string;
  businessName: string | null;
  industry: string | null;
  runnable: boolean;
  /** M3.5: discovery captured before the consultant could investigate causes (approved items are unaffected). */
  discoveryBeforeM35: boolean;
  teamApproved: boolean;
  teamApprovedAt: string | null;
  agents: WorkspaceAgent[];
  demoData: DemoScenario | null;
  workflows: WorkspaceWorkflow[];   // newest first
  paramLimits: { approval_threshold_ngn: { min: number; max: number }; max_payment_ngn: { min: number; max: number } };
};

export type WorkspaceApiFailure = { error: { code: string; message: string; correlation_id: string }; view?: WorkspaceView };
