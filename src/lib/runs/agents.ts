// M4 · The five rule-based agents (D22): deterministic handlers with templated reasoning, no model.
// A handler receives a broker (tools and data, both gated) over a COPY of the run's data and returns
// a result. It has no repository and no I/O: only the runner commits what a handler produced, in one
// atomic write (plan §5.7). Every external-sounding action is a labelled simulation.
import type { DemoScenario } from "@/lib/workflows/demo-data";
import type { Params } from "@/lib/workflows/schema";
import { chooseSupplier, reorderFor } from "./scenarios";
import { BrokerRefusal, type Broker } from "./tools";

export type HandlerResult = { output: Record<string, unknown>; reasoning: string };
export type HandlerInput = { broker: Broker; runId: string; params: Params };

type Order = { id: string; items: Array<{ item: string; qty: number; unit_price_ngn?: number }>; status: string; total_ngn?: number; rejection?: string };
type Stock = { inventory: DemoScenario["inventory"]; recipes: NonNullable<DemoScenario["recipes"]>; reorder: ReturnType<typeof reorderFor> };
type Proposal = { supplier: string; item: string; quantity: number; unit: string; unit_price_ngn: number; total_ngn: number; delivery_days: number };

const naira = (n: number) => `₦${n.toLocaleString("en-NG")}`;
const round = (n: number) => Math.round(n * 100) / 100;

/** Order Agent · validate (or capture) the demo order against the demo menu. */
export function orderCheck({ broker }: HandlerInput): HandlerResult {
  broker.use("read_catalogue");
  const menu = broker.read<DemoScenario["menu"]>("products");
  const orders = broker.read<Order[]>("orders");
  const order = orders[orders.length - 1];
  if (!order) throw new Error("NO_ORDER");
  const unknown = order.items.filter(l => !menu.some(m => m.item === l.item));
  broker.use("create_order");
  if (unknown.length) {
    order.status = "rejected"; order.rejection = `Not on the menu: ${unknown.map(u => u.item).join(", ")}`;
    broker.write("orders", orders);
    return { output: { order_id: order.id, valid: false, reason: order.rejection }, reasoning: `The order can't be accepted. ${order.rejection}.` };
  }
  for (const l of order.items) l.unit_price_ngn = menu.find(m => m.item === l.item)!.price_ngn;
  order.total_ngn = order.items.reduce((t, l) => t + l.qty * (l.unit_price_ngn ?? 0), 0);
  order.status = "confirmed";
  broker.write("orders", orders);
  const lines = order.items.map(l => `${l.qty} × ${l.item}`).join(", ");
  return { output: { order_id: order.id, valid: true, lines, total_ngn: order.total_ngn }, reasoning: `Every item is on the demo menu at its listed price: ${lines}, total ${naira(order.total_ngn)} (illustrative).` };
}

/** Order Agent · confirm the order to the customer: SIMULATED, nothing is sent. */
export function confirmToCustomer({ broker }: HandlerInput): HandlerResult {
  const orders = broker.read<Order[]>("orders");
  const order = orders[orders.length - 1];
  broker.use("send_order_confirmation");
  const text = order?.total_ngn ? `Thanks! Your order of ${order.items.map(l => `${l.qty} × ${l.item}`).join(", ")} is confirmed: ${naira(order.total_ngn)}.` : "Order received.";
  return { output: { message: text, sent: false }, reasoning: "Demo confirmation (not sent): no message goes to anyone in a test run." };
}

/** Inventory Agent · deduct what the order uses and flag the first item below its reorder point. */
export function stockUpdate({ broker }: HandlerInput, flag: boolean): HandlerResult {
  broker.use("read_stock");
  const stock = broker.read<Stock>("stock");
  const orders = broker.read<Order[]>("orders");
  const order = orders.filter(o => o.status === "confirmed").at(-1);
  broker.use("update_stock");
  const used: string[] = [];
  for (const line of order?.items ?? []) {
    const recipe = stock.recipes.find(r => r.item === line.item);
    for (const u of recipe?.uses ?? []) {
      const s = stock.inventory.find(i => i.item === u.stock_item);
      if (s) { s.on_hand = round(s.on_hand - u.qty * line.qty); used.push(`${round(u.qty * line.qty)} ${s.unit} ${s.item.toLowerCase()}`); }
    }
  }
  let reorder: Stock["reorder"] = null;
  if (flag) { broker.use("flag_reorder"); reorder = reorderFor(stock.inventory); }
  broker.write("stock", { inventory: stock.inventory, reorder });
  const usedText = used.length ? `Used ${used.join(", ")}.` : "Nothing used (no confirmed order).";
  const flagText = !flag ? "" : reorder
    ? ` ${reorder.item} is at ${reorder.on_hand} ${reorder.unit}, below its reorder point of ${reorder.reorder_point}: reorder ${reorder.quantity} ${reorder.unit} to reach par.`
    : " Every item is above its reorder point.";
  return { output: { reorder, inventory: stock.inventory.map(i => ({ item: i.item, on_hand: i.on_hand, unit: i.unit })) }, reasoning: `${usedText}${flagText}` };
}

/** Procurement Agent · recommend the cheapest APPROVED supplier that can deliver today. */
export function supplierChoice({ broker }: HandlerInput): HandlerResult {
  broker.use("read_suppliers");
  const suppliers = broker.read<DemoScenario["suppliers"]>("suppliers");
  const stock = broker.read<Stock>("stock");
  const need = stock.reorder;
  if (!need) throw new Error("NO_REORDER");
  broker.use("request_quote");                          // simulated: quotes come from the demo data
  const { chosen, excluded } = chooseSupplier({ suppliers } as DemoScenario, need.item);
  if (!chosen) throw new Error("NO_APPROVED_SUPPLIER");
  broker.use("propose_purchase");
  const proposal: Proposal = { supplier: chosen.name, item: need.item, quantity: need.quantity, unit: need.unit, unit_price_ngn: chosen.price_per_unit_ngn, total_ngn: chosen.price_per_unit_ngn * need.quantity, delivery_days: chosen.delivery_days };
  broker.write("purchase_proposals", [proposal]);
  const why = `${chosen.name} is the cheapest approved supplier that can deliver today: ${naira(chosen.price_per_unit_ngn)}/${need.unit} × ${need.quantity} ${need.unit} = ${naira(proposal.total_ngn)} (illustrative), delivery in ${chosen.delivery_days} day${chosen.delivery_days === 1 ? "" : "s"}.`;
  const ex = excluded.length ? ` Excluded: ${excluded.map(e => `${e.name} (${e.reason})`).join("; ")}.` : "";
  return { output: { proposal, excluded }, reasoning: `${why}${ex} Quotes are simulated from demo data; no supplier was contacted.` };
}

/** Finance Agent · prepare the payment REQUEST (it never pays). */
export function paymentPrepare({ broker, runId }: HandlerInput): HandlerResult {
  broker.use("read_budget");
  const budget = broker.read<{ max_payment_ngn: number; approval_threshold_ngn: number; daily_limit_ngn: number }>("budget");
  const [p] = broker.read<Proposal[]>("purchase_proposals");
  if (!p) throw new Error("NO_PROPOSAL");
  const request = {
    request_id: `${runId}:payment`, beneficiary: p.supplier, amount_ngn: p.total_ngn,
    channel: { kind: "treasury_contract", method: "request_payment", network: "near-testnet", mode: "test_run" }, item: p.item, quantity: p.quantity,
  };
  broker.write("payment_requests", [request]);
  return {
    output: { request },
    reasoning: `Prepared a payment request of ${naira(p.total_ngn)} to ${p.supplier} through the treasury contract (test run). Your limits: approval above ${naira(budget.approval_threshold_ngn)}, maximum ${naira(budget.max_payment_ngn)} per payment. The security check decides next; Finance can't pay anyone directly.`,
  };
}

/** Business Orchestrator · write the owner's summary, shown in EmployAI only (simulated notification). */
export function ownerSummary({ broker }: HandlerInput, facts: string): HandlerResult {
  const handoffs = broker.read<Array<{ assignee: string; task: string }>>("agent_results");
  broker.use("notify_owner");
  broker.write("run_log", { summary: facts });
  return { output: { summary: facts, handoffs: handoffs.length, sent: false }, reasoning: "Summary shown in EmployAI (no message sent)." };
}

export { BrokerRefusal };
