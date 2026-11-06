// M3 unit tests: deterministic workflow generation, the path-based validator, layout and demo data.
import { describe, expect, test } from "vitest";
import { AGENT_TEMPLATES, type AgentKey } from "@/lib/catalogue/catalogue";
import { isRunnableIndustry, restaurantDemoScenario, RESTAURANT_INDUSTRY } from "@/lib/workflows/demo-data";
import { DEFAULT_PARAMS, generateRestaurantWorkflow, type TeamMember } from "@/lib/workflows/generate";
import { layoutWorkflow } from "@/lib/workflows/layout";
import type { Step, WorkflowDoc } from "@/lib/workflows/schema";
import { explainDisconnected, workflowStructure } from "@/lib/workflows/structure";
import { allPaths, validateWorkflow } from "@/lib/workflows/validate";

const KEYS: AgentKey[] = ["orchestrator", "order", "inventory", "procurement", "finance"];

function team(opts: { without?: AgentKey[]; off?: Partial<Record<AgentKey, string[]>>; preview?: AgentKey[] } = {}): TeamMember[] {
  return KEYS.map(k => ({
    key: k,
    status: opts.without?.includes(k) ? "removed" : "approved",
    executable: !opts.preview?.includes(k),
    tasks: AGENT_TEMPLATES[k].tasks.map(t => ({ id: t.id, enabled: !opts.off?.[k]?.includes(t.id) })),
  }));
}

const full = () => generateRestaurantWorkflow(team());
const ok = { team: team(), runnable: true };
const step = (doc: WorkflowDoc, id: string) => doc.steps.find(s => s.id === id)! as Step & Record<string, unknown>;
const failed = (doc: unknown, ctx = ok) => validateWorkflow(doc, ctx).checks.filter(c => !c.passed).map(c => c.code);
const types = (doc: WorkflowDoc) => doc.steps.map(s => s.type);

describe("generation (fixed templates, no AI)", () => {
  test("full restaurant team: valid, 15 steps, payment guarded on every path", () => {
    const doc = full();
    const v = validateWorkflow(doc, ok);
    expect(v.valid).toBe(true);
    expect(v.checks.every(c => c.passed)).toBe(true);
    expect(doc.steps).toHaveLength(15);
    expect(doc.scenario).toBe("restaurant_demo");
    expect(doc.params).toEqual(DEFAULT_PARAMS);
    expect(doc.notes).toEqual([]);
    const byId = new Map(doc.steps.map(s => [s.id, s]));
    expect(allPaths(doc.start, byId)).toHaveLength(6);
    // The chain to a payment: supplier → prepare → security (allow/warn) → approval (approved) → payment.
    expect(step(doc, "security_check").next).toEqual({ allow: "owner_approval", warn: "owner_approval", block: "end_blocked" });
    expect(step(doc, "owner_approval").next).toEqual({ approved: "payment", rejected: "end_rejected" });
  });

  test("payment step separates the beneficiary (approved supplier) from the channel (treasury contract)", () => {
    const pay = full().steps.find(s => s.type === "payment")!;
    expect(pay).toMatchObject({
      agent: "finance",
      beneficiary: { kind: "approved_supplier", from_step: "supplier_choice" },
      channel: { kind: "treasury_contract", method: "request_payment", network: "near-testnet", contract_account: null },
      amount: { source: "supplier_quote", currency: "NGN", illustrative: true },
      mode: "test_run",
    });
    // The preparing step can't request the payment itself.
    expect((step(full(), "payment_prepare").tools as string[])).not.toContain("request_payment");
  });

  test("deterministic: the same team and settings give the same workflow", () => {
    expect(generateRestaurantWorkflow(team())).toEqual(generateRestaurantWorkflow(team()));
  });

  test("no Finance Agent: no payment path; the owner places the order", () => {
    const doc = generateRestaurantWorkflow(team({ without: ["finance"] }));
    expect(types(doc)).not.toContain("payment");
    expect(types(doc)).not.toContain("security_check");
    expect(step(doc, "end").result).toBe("manual_order");
    expect(doc.notes.join(" ")).toMatch(/Finance Agent/);
    expect(validateWorkflow(doc, { team: team({ without: ["finance"] }), runnable: true }).valid).toBe(true);
  });

  test("no Inventory Agent: no stock, reorder, supplier or payment steps", () => {
    const t = team({ without: ["inventory"] });
    const doc = generateRestaurantWorkflow(t);
    expect(doc.steps.map(s => s.id)).not.toEqual(expect.arrayContaining(["stock_update"]));
    expect(types(doc)).not.toContain("condition");
    expect(types(doc)).not.toContain("payment");
    expect(doc.notes.join(" ")).toMatch(/Inventory Agent/);
    expect(validateWorkflow(doc, { team: t, runnable: true }).valid).toBe(true);
  });

  test("no Procurement Agent: stops at the reorder decision, no payment", () => {
    const t = team({ without: ["procurement"] });
    const doc = generateRestaurantWorkflow(t);
    expect(doc.steps.some(s => s.id === "supplier_choice")).toBe(false);
    expect(types(doc)).not.toContain("payment");
    expect(doc.notes.join(" ")).toMatch(/Procurement Agent/);
    expect(validateWorkflow(doc, { team: t, runnable: true }).valid).toBe(true);
  });

  test("Order Agent's confirm task off: no customer confirmation, with a note", () => {
    const t = team({ off: { order: ["confirm"] } });
    const doc = generateRestaurantWorkflow(t);
    expect(doc.steps.some(s => s.id === "notify_customer")).toBe(false);
    expect(doc.notes.join(" ")).toMatch(/Confirms the order|switched off/);
    expect(validateWorkflow(doc, { team: t, runnable: true }).valid).toBe(true);
    // Turning the setting off removes the step without a note.
    const quiet = generateRestaurantWorkflow(team(), { ...DEFAULT_PARAMS, notify_customer: false });
    expect(quiet.steps.some(s => s.id === "notify_customer")).toBe(false);
    expect(quiet.notes).toEqual([]);
  });

  test("no Orchestrator: the owner summary has no agent", () => {
    const t = team({ without: ["orchestrator"] });
    const doc = generateRestaurantWorkflow(t);
    expect(step(doc, "notify_owner")).toMatchObject({ agent: null, task: null });
    expect(validateWorkflow(doc, { team: t, runnable: true }).valid).toBe(true);
  });

  test("no Order Agent: starts from a demo stock check", () => {
    const t = team({ without: ["order"] });
    const doc = generateRestaurantWorkflow(t);
    expect(step(doc, "trigger").source).toBe("demo_stock_check");
    expect(validateWorkflow(doc, { team: t, runnable: true }).valid).toBe(true);
  });

  test("preview-only agents produce no steps", () => {
    const doc = generateRestaurantWorkflow(team({ preview: ["finance"] }));
    expect(types(doc)).not.toContain("payment");
  });
});

describe("validator: every rule rejects its failure case", () => {
  const mutate = (fn: (d: WorkflowDoc) => void) => { const d = structuredClone(full()); fn(d); return d; };

  test("structure: loop, unreachable step, missing or unknown route, duplicate IDs, two triggers, too many steps", () => {
    expect(failed(mutate(d => { step(d, "notify_owner").next.next = "trigger"; }))).toContain("NO_CYCLES");
    expect(failed(mutate(d => { d.steps.push({ id: "orphan", type: "end", title: "Orphan", description: "", result: "completed", next: {} }); }))).toContain("ALL_REACHABLE");
    expect(failed(mutate(d => { delete step(d, "security_check").next.block; }))).toContain("ROUTES_COMPLETE");
    expect(failed(mutate(d => { step(d, "security_check").next.maybe = "payment"; }))).toContain("ROUTES_COMPLETE");
    expect(failed(mutate(d => { step(d, "trigger").next.next = "nowhere"; }))).toContain("ROUTES_COMPLETE");
    expect(failed(mutate(d => { d.steps.push({ ...step(d, "end") } as Step); }))).toContain("UNIQUE_IDS");
    expect(failed(mutate(d => { d.steps.push({ id: "trigger_2", type: "trigger", title: "Again", description: "", source: "demo_order", next: { next: "end" } }); }))).toContain("SINGLE_TRIGGER");
    const big = mutate(d => {
      for (let i = 0; i < 12; i++) d.steps.push({ id: `extra_${i}`, type: "end", title: "x", description: "", result: "completed", next: {} });
    });
    expect(failed(big)).toContain("SCHEMA"); // more than 25 steps is rejected outright
  });

  test("shape: unknown step types, extra fields and tampered payment channel are rejected", () => {
    expect(failed(mutate(d => { (step(d, "end") as Record<string, unknown>).type = "transfer"; }))).toContain("SCHEMA");
    expect(failed(mutate(d => { (step(d, "order_check") as Record<string, unknown>).wallet_key = "ed25519:abc"; }))).toContain("SCHEMA");
    expect(failed(mutate(d => { (step(d, "payment").channel as Record<string, unknown>).contract_account = "attacker.testnet"; }))).toContain("SCHEMA");
    expect(failed(mutate(d => { (step(d, "payment").channel as Record<string, unknown>).kind = "direct_wallet"; }))).toContain("SCHEMA");
    expect(failed(mutate(d => { (step(d, "payment").amount as Record<string, unknown>).currency = "NEAR"; }))).toContain("SCHEMA");
    expect(failed(mutate(d => { (step(d, "payment").beneficiary as Record<string, unknown>).kind = "any_account"; }))).toContain("SCHEMA");
    expect(failed(mutate(d => { (step(d, "payment") as Record<string, unknown>).agent = "procurement"; }))).toContain("SCHEMA");
  });

  test("payment beneficiary must come from the Procurement recommendation", () => {
    const d = mutate(x => { (step(x, "payment").beneficiary as { from_step: string }).from_step = "payment_prepare"; });
    expect(failed(d)).toContain("PAYMENT_BENEFICIARY_AND_CHANNEL");
  });

  test("payment paths: no security check, BLOCK, skipped approval, declined approval, wrong subject", () => {
    const noSecurity = mutate(d => { step(d, "payment_prepare").next.next = "payment"; });
    expect(failed(noSecurity)).toContain("PAYMENT_PATHS_GUARDED");
    expect(validateWorkflow(noSecurity, ok).checks.find(c => c.code === "PAYMENT_PATHS_GUARDED")!.detail).toMatch(/without its security check/);

    const blockPays = mutate(d => { step(d, "security_check").next.block = "owner_approval"; });
    expect(validateWorkflow(blockPays, ok).checks.find(c => c.code === "PAYMENT_PATHS_GUARDED")!.detail).toMatch(/after a BLOCK/);

    const skipApproval = mutate(d => { step(d, "security_check").next.allow = "payment"; });
    expect(validateWorkflow(skipApproval, ok).checks.find(c => c.code === "PAYMENT_PATHS_GUARDED")!.detail).toMatch(/without the approval check/);

    const declinedPays = mutate(d => { step(d, "owner_approval").next.rejected = "payment"; });
    expect(validateWorkflow(declinedPays, ok).checks.find(c => c.code === "PAYMENT_PATHS_GUARDED")!.detail).toMatch(/after you declined/);

    const otherSubject = mutate(d => { (step(d, "security_check") as { subject: string }).subject = "end"; });
    expect(failed(otherSubject)).toContain("PAYMENT_PATHS_GUARDED");

    // Approval before the security check doesn't count: the approval must come after it.
    const approvalFirst = mutate(d => {
      step(d, "payment_prepare").next.next = "owner_approval";
      step(d, "owner_approval").next.approved = "security_check";
      step(d, "security_check").next = { allow: "payment", warn: "payment", block: "end_blocked" };
    });
    expect(failed(approvalFirst)).toContain("PAYMENT_PATHS_GUARDED");

    for (const d of [noSecurity, blockPays, skipApproval, declinedPays, otherSubject, approvalFirst]) expect(validateWorkflow(d, ok).valid).toBe(false);
  });

  test("agents, tasks and tools come only from the approved team and the catalogue", () => {
    const doc = full();
    expect(failed(doc, { team: team({ without: ["finance"] }), runnable: true })).toContain("AGENTS_APPROVED");
    expect(failed(doc, { team: team({ preview: ["procurement"] }), runnable: true })).toContain("AGENTS_APPROVED");
    expect(failed(doc, { team: team({ off: { procurement: ["recommend"] } }), runnable: true })).toContain("TASKS_ENABLED");
    expect(failed(mutate(d => { (step(d, "order_check").tools as string[]).push("send_money"); }))).toContain("TOOLS_ALLOWED");
    expect(failed(mutate(d => { (step(d, "supplier_choice").tools as string[]).push("request_payment"); }))).toContain("TOOLS_ALLOWED");
  });

  test("settings: out of range, and a threshold above the maximum", () => {
    expect(validateWorkflow(mutate(d => { d.params.approval_threshold_ngn = 10; }), ok).valid).toBe(false);
    expect(validateWorkflow(mutate(d => { d.params.max_payment_ngn = 50_000_000; }), ok).valid).toBe(false);
    expect(failed(mutate(d => { d.params.approval_threshold_ngn = 300_000; d.params.max_payment_ngn = 200_000; }))).toEqual(["SETTINGS_VALID"]);
  });

  test("only the restaurant demo is runnable", () => {
    expect(failed(full(), { team: team(), runnable: false })).toContain("RUNNABLE_SCENARIO");
    expect(isRunnableIndustry(RESTAURANT_INDUSTRY)).toBe(true);
    expect(isRunnableIndustry("Salon / beauty services")).toBe(false);
    expect(isRunnableIndustry(null)).toBe(false);
  });

  test("garbage input never validates", () => {
    for (const bad of [null, {}, "workflow", { ...full(), steps: [] }]) expect(validateWorkflow(bad, ok).valid).toBe(false);
  });
});

describe("structure: main sequence, branches and disconnected steps", () => {
  test("full team: 12 main steps in execution order, three dead-end branches", () => {
    const s = workflowStructure(full());
    expect(s.main.map(x => x.id)).toEqual([
      "trigger", "order_check", "notify_customer", "stock_update", "reorder_needed", "supplier_choice",
      "payment_prepare", "security_check", "owner_approval", "payment", "notify_owner", "end",
    ]);
    expect(s.enteredBy.get("supplier_choice")).toEqual(["yes"]);
    expect(s.enteredBy.get("owner_approval")).toEqual(["allow", "warn"]);
    expect(s.enteredBy.get("payment")).toEqual(["approved"]);
    const br = (id: string) => s.branches.get(id)!.map(b => ({ outcomes: b.outcomes, chain: b.chain.map(c => c.id), rejoins: b.rejoins }));
    expect(br("reorder_needed")).toEqual([{ outcomes: ["no"], chain: ["end_no_reorder"], rejoins: null }]);
    expect(br("security_check")).toEqual([{ outcomes: ["block"], chain: ["end_blocked"], rejoins: null }]);
    expect(br("owner_approval")).toEqual([{ outcomes: ["rejected"], chain: ["end_rejected"], rejoins: null }]);
    expect(s.disconnected).toEqual([]);
    // Every step appears exactly once across the main sequence and the branches.
    const listed = [...s.main, ...[...s.branches.values()].flat().flatMap(b => b.chain)].map(x => x.id);
    expect(listed.sort()).toEqual(full().steps.map(x => x.id).sort());
  });

  test("a rerouted BLOCK: the disconnected step names the missing connection", () => {
    const d = structuredClone(full());
    d.steps.find(x => x.id === "security_check")!.next.block = "owner_approval";
    const s = workflowStructure(d);
    expect(s.enteredBy.get("owner_approval")).toEqual(["allow", "warn", "block"]);
    expect(s.disconnected).toHaveLength(1);
    const text = explainDisconnected(s.disconnected[0]);
    expect(text).toBe("Nothing leads to “Payment blocked”. It normally follows the BLOCK outcome of “Security check on the payment”, which now goes to “Your approval when needed”.");
    // The validator reports the same explanation, and the layout puts the step beside its anchor.
    expect(validateWorkflow(d, ok).checks.find(c => c.code === "ALL_REACHABLE")!.detail).toBe(text);
    const l = layoutWorkflow(d, new Map([["end_blocked", "security_check"]]));
    const at = (id: string) => l.nodes.find(n => n.id === id)!;
    expect(at("end_blocked")).toMatchObject({ row: at("security_check").row, col: at("security_check").col + 1 });
  });

  test("a step with no known source gets a generic explanation", () => {
    const d = structuredClone(full());
    d.steps.push({ id: "orphan", type: "end", title: "Orphan", description: "", result: "completed", next: {} });
    expect(explainDisconnected(workflowStructure(d).disconnected[0])).toBe("Nothing leads to “Orphan”, so it can never run.");
  });
});

describe("layout and demo data", () => {
  test("every step gets its own cell", () => {
    for (const t of [team(), team({ without: ["finance"] }), team({ without: ["inventory"] })]) {
      const doc = generateRestaurantWorkflow(t);
      const l = layoutWorkflow(doc);
      expect(l.nodes).toHaveLength(doc.steps.length);
      expect(new Set(l.nodes.map(n => `${n.row}:${n.col}`)).size).toBe(doc.steps.length);
    }
  });

  test("demo data is fictional, labelled and in illustrative NGN", () => {
    const d = restaurantDemoScenario();
    expect(d).toMatchObject({ kind: "restaurant_demo", demo: true, currency: "NGN" });
    expect(d.label).toMatch(/^Demo data/);
    expect(d.suppliers.every(s => s.name.endsWith("(demo)"))).toBe(true);
    expect(d.suppliers.some(s => !s.approved)).toBe(true); // an unapproved supplier exists to test the gate later
  });
});
