import { z } from "zod";

/**
 * Workflow model (stored in `workflows.steps` jsonb; approved table 4). A workflow is a DAG of typed
 * steps joined by OUTCOME-labelled edges. Only the 8 approved step types exist. In M3 a workflow is
 * generated, validated and APPROVED by the owner; nothing executes until M4.
 */
export const STEP_TYPES = ["trigger", "agent_task", "condition", "security_check", "approval", "payment", "notify", "end"] as const;
export type StepType = (typeof STEP_TYPES)[number];

export const MAX_STEPS = 25;

/** The outcomes each step type must route. A path follows exactly one outcome per step. */
export const OUTCOMES: Record<StepType, readonly string[]> = {
  trigger: ["next"],
  agent_task: ["next"],
  condition: ["yes", "no"],
  security_check: ["allow", "warn", "block"],
  approval: ["approved", "rejected"],
  payment: ["next"],
  notify: ["next"],
  end: [],
};

const id = z.string().regex(/^[a-z][a-z0-9_]{1,39}$/);
const label = z.string().min(1).max(160);
const text = z.string().max(400);

const base = {
  id,
  title: label,
  description: text,
  next: z.record(z.string().max(20), id),
};

const AgentKey = z.enum(["orchestrator", "order", "inventory", "procurement", "finance", "bookings", "messaging"]);

export const TriggerStep = z.object({ ...base, type: z.literal("trigger"), source: z.enum(["demo_order", "demo_stock_check"]) }).strict();
export const AgentTaskStep = z.object({
  ...base, type: z.literal("agent_task"),
  agent: AgentKey, task: z.string().max(40),
  input: text, output: text,
  tools: z.array(z.string().max(40)).max(8),
  reads: z.array(z.string().max(40)).max(8), writes: z.array(z.string().max(40)).max(8),
}).strict();
export const ConditionStep = z.object({ ...base, type: z.literal("condition"), expression: z.enum(["reorder_needed"]) }).strict();
export const SecurityCheckStep = z.object({
  ...base, type: z.literal("security_check"),
  /** The payment step this check evaluates. The gate decides ALLOW / WARN / BLOCK (M5). */
  subject: id,
}).strict();
export const ApprovalStep = z.object({
  ...base, type: z.literal("approval"),
  /** Pauses for the owner when the amount is over the approval threshold or the gate said WARN. */
  rule: z.literal("over_threshold_or_warn"),
  subject: id,
}).strict();

/**
 * Payment request. The BENEFICIARY (who should receive the money: an approved supplier chosen by the
 * Procurement step) is deliberately separate from the CHANNEL (the treasury contract through which the
 * Finance Agent requests the payment). The agent never pays directly and never chooses a free-form
 * recipient. Amounts are ILLUSTRATIVE NGN for the restaurant demo; NEAR-denominated contract limits
 * and network fees are configured separately in M5. There is no currency conversion.
 */
export const PaymentStep = z.object({
  ...base, type: z.literal("payment"),
  agent: z.literal("finance"),
  beneficiary: z.object({
    kind: z.literal("approved_supplier"),
    /** The agent_task step (Procurement) whose recommendation names the supplier. */
    from_step: id,
  }).strict(),
  channel: z.object({
    kind: z.literal("treasury_contract"),
    method: z.literal("request_payment"),
    network: z.literal("near-testnet"),
    /** The contract account is configured in M5; it is never the beneficiary. */
    contract_account: z.null(),
  }).strict(),
  amount: z.object({
    source: z.literal("supplier_quote"),
    currency: z.literal("NGN"),
    illustrative: z.literal(true),
  }).strict(),
  mode: z.literal("test_run"),
}).strict();
export const NotifyStep = z.object({ ...base, type: z.literal("notify"), audience: z.enum(["owner", "customer"]), agent: AgentKey.nullable(), task: z.string().max(40).nullable() }).strict();
export const EndStep = z.object({ ...base, type: z.literal("end"), result: z.enum(["completed", "no_reorder", "manual_order", "blocked", "rejected"]) }).strict();

export const StepSchema = z.discriminatedUnion("type", [TriggerStep, AgentTaskStep, ConditionStep, SecurityCheckStep, ApprovalStep, PaymentStep, NotifyStep, EndStep]);
export type Step = z.infer<typeof StepSchema>;

/** Owner-editable settings. Amounts are illustrative NGN for the demo restaurant. */
export const PARAM_LIMITS = {
  approval_threshold_ngn: { min: 1_000, max: 5_000_000 },
  max_payment_ngn: { min: 1_000, max: 10_000_000 },
} as const;
export const ParamsSchema = z.object({
  approval_threshold_ngn: z.number().int().min(PARAM_LIMITS.approval_threshold_ngn.min).max(PARAM_LIMITS.approval_threshold_ngn.max),
  max_payment_ngn: z.number().int().min(PARAM_LIMITS.max_payment_ngn.min).max(PARAM_LIMITS.max_payment_ngn.max),
  notify_customer: z.boolean(),
  notify_owner: z.boolean(),
}).strict();
export type Params = z.infer<typeof ParamsSchema>;

export const WorkflowDocSchema = z.object({
  schema_version: z.literal(1),
  template: z.literal("restaurant_order_to_restock"),
  name: label,
  scenario: z.literal("restaurant_demo"),
  coordinator: z.enum(["orchestrator", "runner"]),
  start: id,
  steps: z.array(StepSchema).min(2).max(MAX_STEPS),
  params: ParamsSchema,
  /** Why steps were left out (e.g. "No Finance Agent: no payment path"). Shown to the owner. */
  notes: z.array(text).max(10),
  catalogue_version: z.string().max(40),
}).strict();
export type WorkflowDoc = z.infer<typeof WorkflowDocSchema>;

export const WorkflowStatusSchema = z.enum(["draft", "approved", "superseded"]);
export type WorkflowStatus = z.infer<typeof WorkflowStatusSchema>;

export type ValidationCheck = { code: string; label: string; passed: boolean; detail: string };
export type ValidationResult = { valid: boolean; checks: ValidationCheck[]; validated_at: string };
