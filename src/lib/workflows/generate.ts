// Deterministic workflow generation from fixed templates (no AI, no free-form steps). The restaurant
// "Order to restock" template is assembled from per-capability pieces for the APPROVED agents and the
// tasks the owner kept enabled. Steps for removed agents or disabled tasks are simply not produced,
// and the reason is recorded in `notes` for the owner.
import { AGENT_TEMPLATES, CATALOGUE_VERSION, type AgentKey } from "@/lib/catalogue/catalogue";
import type { Params, Step, WorkflowDoc } from "./schema";

export type TeamMember = { key: AgentKey; status: "proposed" | "approved" | "removed"; executable: boolean; tasks: Array<{ id: string; enabled: boolean }> };

export const DEFAULT_PARAMS: Params = {
  approval_threshold_ngn: 50_000,
  max_payment_ngn: 250_000,
  notify_customer: true,
  notify_owner: true,
};

const tools = (k: AgentKey) => AGENT_TEMPLATES[k].allowed_tools;

export function generateRestaurantWorkflow(team: TeamMember[], params: Params = DEFAULT_PARAMS): WorkflowDoc {
  const approved = new Map(team.filter(a => a.status === "approved" && a.executable).map(a => [a.key, a]));
  const has = (k: AgentKey, task?: string) => {
    const a = approved.get(k);
    return !!a && (!task || a.tasks.some(t => t.id === task && t.enabled));
  };
  const notes: string[] = [];
  const steps: Step[] = [];
  const add = (s: Step) => { steps.push(s); return s.id; };
  // Each piece links to the next one through `link`, filled in as the chain is built.
  let pending: Array<{ step: Step; outcome: string }> = [];
  const link = (to: string) => { for (const p of pending) p.step.next[p.outcome] = to; pending = []; };
  const chain = (s: Step, outcome = "next") => { link(add(s)); pending = [{ step: s, outcome }]; };

  const orderStep = has("order", "validate") ? "validate" : has("order", "capture") ? "capture" : null;
  chain({
    id: "trigger", type: "trigger", title: orderStep ? "A demo customer order arrives" : "Demo stock check",
    description: "Started by the \"Run demo order\" button in the next stage (M4). There are no live order channels in this prototype.",
    source: orderStep ? "demo_order" : "demo_stock_check", next: {},
  });

  // ---- Order Agent
  if (orderStep) {
    chain({
      id: "order_check", type: "agent_task", title: "Order Agent checks the order", agent: "order", task: orderStep,
      description: "Checks each item and price against the demo menu.",
      input: "Demo order (items, quantities)", output: "Valid order with total in NGN, or a rejection reason",
      tools: tools("order").filter(t => t !== "send_order_confirmation"), reads: ["products", "orders"], writes: ["orders"], next: {},
    });
    if (params.notify_customer && has("order", "confirm")) {
      chain({ id: "notify_customer", type: "notify", title: "Order confirmation to the customer", audience: "customer", agent: "order", task: "confirm",
        description: "Shown in the demo only; no real message is sent.", next: {} });
    } else if (params.notify_customer) {
      notes.push("Customer confirmation is off: the Order Agent's \"Confirms the order\" task is switched off.");
    }
  } else {
    notes.push("No order step: the Order Agent isn't on the approved team (or its order tasks are switched off).");
  }

  // ---- Inventory Agent + reorder decision
  const canDetect = has("inventory", "update_stock") || has("inventory", "detect_low");
  let endNoReorder: string | null = null;
  if (canDetect) {
    chain({
      id: "stock_update", type: "agent_task", title: "Inventory Agent updates stock", agent: "inventory",
      task: has("inventory", "detect_low") ? "detect_low" : "update_stock",
      description: "Deducts the order from demo stock and flags items below their reorder point.",
      input: "Order items", output: "Updated stock and any item below its reorder point, with a quantity to reach par level",
      tools: tools("inventory"), reads: ["stock", "orders"], writes: ["stock"], next: {},
    });
  } else {
    notes.push("No stock or reorder steps: the Inventory Agent isn't on the approved team, so nothing triggers a reorder.");
  }

  const reorderPossible = canDetect && has("inventory", "detect_low");
  if (canDetect && !has("inventory", "detect_low")) notes.push("No reorder decision: the Inventory Agent's \"Flags items below their reorder point\" task is switched off.");

  if (reorderPossible) {
    const cond: Step = { id: "reorder_needed", type: "condition", title: "Is anything below its reorder point?", expression: "reorder_needed",
      description: "Deterministic check against the demo reorder points.", next: {} };
    chain(cond, "yes");
    endNoReorder = add({ id: "end_no_reorder", type: "end", title: "No reorder needed", result: "no_reorder", description: "Stock is above every reorder point.", next: {} });
    cond.next.no = endNoReorder;

    // ---- Procurement Agent
    const procTask = has("procurement", "recommend") ? "recommend" : has("procurement", "compare") ? "compare" : null;
    if (procTask) {
      chain({
        id: "supplier_choice", type: "agent_task", title: "Procurement Agent recommends a supplier", agent: "procurement", task: procTask,
        description: "Compares demo quotes from approved suppliers only; unapproved suppliers are never recommended.",
        input: "Item and quantity to reorder", output: "Recommended approved supplier, quote in NGN and the reasons",
        tools: tools("procurement"), reads: ["suppliers", "stock"], writes: ["purchase_proposals"], next: {},
      });

      // ---- Finance Agent: request → security check → approval → payment request
      if (has("finance", "prepare_payments")) {
        chain({
          id: "payment_prepare", type: "agent_task", title: "Finance Agent prepares the payment request", agent: "finance", task: "prepare_payments",
          description: "Checks the amount against your limits and prepares a request. It cannot pay anyone directly.",
          input: "Recommended supplier and quote", output: "Payment request (beneficiary, amount in NGN, request ID)",
          tools: tools("finance").filter(t => t !== "request_payment"), reads: ["budget", "purchase_proposals"], writes: ["payment_requests"], next: {},
        });
        const sec: Step = { id: "security_check", type: "security_check", title: "Security check on the payment", subject: "payment",
          description: "Deterministic gate: ALLOW, WARN (needs your approval) or BLOCK. Built in M5; in test runs it is simulated and labelled.", next: {} };
        chain(sec, "allow");
        const appr: Step = { id: "owner_approval", type: "approval", title: "Your approval when needed", rule: "over_threshold_or_warn", subject: "payment",
          description: "Pauses for you when the amount is over your approval threshold or the security check says WARN.", next: {} };
        link(add(appr));
        sec.next.warn = "owner_approval";
        pending = [{ step: appr, outcome: "approved" }];
        const pay: Step = {
          id: "payment", type: "payment", title: "Payment request through the treasury contract", agent: "finance",
          description: "Requests payment to the approved supplier via the treasury contract. Test run only: no money moves.",
          beneficiary: { kind: "approved_supplier", from_step: "supplier_choice" },
          channel: { kind: "treasury_contract", method: "request_payment", network: "near-testnet", contract_account: null },
          amount: { source: "supplier_quote", currency: "NGN", illustrative: true },
          mode: "test_run", next: {},
        };
        chain(pay);
        const endBlocked = add({ id: "end_blocked", type: "end", title: "Payment blocked", result: "blocked", description: "Nothing is requested or paid.", next: {} });
        const endRejected = add({ id: "end_rejected", type: "end", title: "You declined the payment", result: "rejected", description: "Nothing is requested or paid.", next: {} });
        sec.next.block = endBlocked;
        appr.next.rejected = endRejected;
      } else {
        notes.push("No payment steps: the Finance Agent isn't on the approved team (or \"Prepares supplier payment requests\" is off). You place the order yourself.");
      }
    } else {
      notes.push("No supplier step: the Procurement Agent isn't on the approved team. You'll be told what to reorder.");
    }
  }

  // ---- Owner summary + end
  if (params.notify_owner) {
    const viaOrchestrator = has("orchestrator", "summarise");
    chain({ id: "notify_owner", type: "notify", title: "Summary for you", audience: "owner",
      agent: viaOrchestrator ? "orchestrator" : null, task: viaOrchestrator ? "summarise" : null,
      description: "A short summary of what happened in the run, shown in EmployAI.", next: {} });
  }
  const manual = reorderPossible && !steps.some(s => s.type === "payment");
  chain({ id: "end", type: "end", title: manual ? "Done: reorder handed to you" : "Done", result: manual ? "manual_order" : "completed",
    description: manual ? "EmployAI prepared what it could; you place the supplier order." : "The run is complete.", next: {} });
  pending = [];

  return {
    schema_version: 1,
    template: "restaurant_order_to_restock",
    name: "Order to restock",
    scenario: "restaurant_demo",
    coordinator: approved.has("orchestrator") ? "orchestrator" : "runner",
    start: "trigger",
    steps,
    params,
    notes,
    catalogue_version: CATALOGUE_VERSION,
  };
}
