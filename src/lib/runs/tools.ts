// M4 · Tool registry and broker (plan §6, D19, C1, C2, C4).
// Every tool is LOCAL. Nothing here (or anywhere in src/lib/runs and src/lib/security) can make a network
// request, send a message, contact a supplier, sign, call a contract or move money: a static test
// enforces it. "simulated_external" tools stand in for an outside action and are labelled as such.
// Agents reach tools and data only through the broker, which asks the gate before every tool call.
import { evaluate, type GateContext } from "@/lib/security/gate";

export type ToolClass = "read" | "run_local" | "simulated_external" | "payment_request";

export const TOOLS: Record<string, { agent: string; class: ToolClass; label: string | null }> = {
  delegate_task: { agent: "orchestrator", class: "run_local", label: null },
  read_run_status: { agent: "orchestrator", class: "read", label: null },
  notify_owner: { agent: "orchestrator", class: "simulated_external", label: "Shown in EmployAI (no message sent)" },
  read_catalogue: { agent: "order", class: "read", label: null },
  create_order: { agent: "order", class: "run_local", label: "Demo order" },
  send_order_confirmation: { agent: "order", class: "simulated_external", label: "Demo confirmation (not sent)" },
  read_stock: { agent: "inventory", class: "read", label: null },
  update_stock: { agent: "inventory", class: "run_local", label: null },
  flag_reorder: { agent: "inventory", class: "run_local", label: null },
  read_suppliers: { agent: "procurement", class: "read", label: null },
  request_quote: { agent: "procurement", class: "simulated_external", label: "Simulated quote from demo data (no supplier contacted)" },
  propose_purchase: { agent: "procurement", class: "run_local", label: null },
  read_budget: { agent: "finance", class: "read", label: null },
  request_payment: { agent: "finance", class: "payment_request", label: "Payment request (test run)" },
  record_ledger: { agent: "finance", class: "run_local", label: "Test run — no transaction" },
};

/** A refusal from the gate or the data scopes. Fails the step at once; never retried. */
export class BrokerRefusal extends Error {
  constructor(readonly reason: string, readonly what: string) { super(`${reason}: ${what}`); }
}

/** Data the run's agents can reach, by scope name (all run-local copies). */
export type Work = { snapshot: Record<string, unknown>; records: Record<string, unknown> };

export type BrokerAgent = { key: string; status: string; allowedTools: readonly string[]; readScopes: readonly string[]; writeScopes: readonly string[] };

/**
 * One broker per step execution. `use(tool)` asks the gate (rules 1–3) first; `read`/`write` are allowed
 * only for scopes in BOTH the step's declaration AND the agent's approved definition.
 */
export function makeBroker(args: {
  agent: BrokerAgent | null;
  step: { id: string; tools: readonly string[]; reads: readonly string[]; writes: readonly string[] };
  gate: Omit<GateContext, "agent" | "stepTools">;
  scopes: { read: (scope: string) => unknown; write: (scope: string, value: unknown) => void };
}) {
  const toolsUsed: string[] = [], reads: string[] = [], writes: string[] = [], simulated: string[] = [];
  const agentForGate = args.agent ? { status: args.agent.status, allowedTools: args.agent.allowedTools } : null;
  return {
    toolsUsed, reads, writes, simulated,
    use(tool: string): void {
      if (!TOOLS[tool]) throw new BrokerRefusal("NOT_AUTHORISED", `unknown tool ${tool}`);
      const r = evaluate({ kind: "tool_call", agentKey: args.agent?.key ?? "none", tool, stepId: args.step.id }, { ...args.gate, agent: agentForGate, stepTools: args.step.tools });
      if (r.decision !== "ALLOW") throw new BrokerRefusal(r.reasons[0] ?? "NOT_AUTHORISED", `tool ${tool}`);
      if (!toolsUsed.includes(tool)) toolsUsed.push(tool);
      const label = TOOLS[tool].label;
      if (TOOLS[tool].class === "simulated_external" && label && !simulated.includes(label)) simulated.push(label);
    },
    read<T>(scope: string): T {
      if (!args.step.reads.includes(scope) || !args.agent?.readScopes.includes(scope)) throw new BrokerRefusal("NOT_AUTHORISED", `read ${scope}`);
      if (!reads.includes(scope)) reads.push(scope);
      return structuredClone(args.scopes.read(scope)) as T;
    },
    write(scope: string, value: unknown): void {
      if (!args.step.writes.includes(scope) || !args.agent?.writeScopes.includes(scope)) throw new BrokerRefusal("NOT_AUTHORISED", `write ${scope}`);
      if (!writes.includes(scope)) writes.push(scope);
      args.scopes.write(scope, structuredClone(value));
    },
  };
}
export type Broker = ReturnType<typeof makeBroker>;

/** How scope names map onto the run's working copy. */
export function scopeAccess(work: Work, extra: { budget: unknown }) {
  const rec = work.records as Record<string, unknown>;
  const snap = work.snapshot as Record<string, unknown>;
  return {
    read(scope: string): unknown {
      switch (scope) {
        case "products": return snap.menu;
        case "orders": return rec.orders ?? [];
        case "stock": return { inventory: snap.inventory, recipes: snap.recipes ?? [], reorder: rec.reorder ?? null };
        case "suppliers": return snap.suppliers;
        case "purchase_proposals": return rec.purchase_proposals ?? [];
        case "budget": return extra.budget;
        case "payment_requests": return rec.payment_requests ?? [];
        case "agent_results": return rec.handoffs ?? [];
        case "business_profile": return null;   // the case file is never given to agents in M4
        default: throw new BrokerRefusal("NOT_AUTHORISED", `unknown scope ${scope}`);
      }
    },
    write(scope: string, value: unknown): void {
      switch (scope) {
        case "orders": rec.orders = value; return;
        case "stock": { const v = value as { inventory: unknown; reorder: unknown }; snap.inventory = v.inventory; rec.reorder = v.reorder; return; }
        case "purchase_proposals": rec.purchase_proposals = value; return;
        case "payment_requests": rec.payment_requests = value; return;
        case "run_log": rec.run_log = value; return;
        default: throw new BrokerRefusal("NOT_AUTHORISED", `unknown scope ${scope}`);
      }
    },
  };
}
