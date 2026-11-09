// M4 · D6: the five demo scenarios. A scenario changes ONLY the fictional demo inputs (the order, a
// supplier's availability or quotes); security rules and the owner's settings are identical in every
// scenario. Pure functions: no I/O.
import { restaurantDemoScenario, type DemoScenario } from "@/lib/workflows/demo-data";
import type { ScenarioKey } from "./types";

export type DemoOrder = { items: Array<{ item: string; qty: number }> };

export type ScenarioDef = {
  key: ScenarioKey;
  title: string;
  description: string;
  order: DemoOrder;
  /** What the scenario changes in the demo data, shown on its card. */
  changes: string;
  adjust: (d: DemoScenario) => void;
};

export const SCENARIO_DEFS: Record<ScenarioKey, ScenarioDef> = {
  standard: {
    key: "standard", title: "Standard order", description: "A normal demo order that brings rice below its reorder point.",
    order: { items: [{ item: "Jollof rice", qty: 10 }] }, changes: "10 plates of jollof rice.", adjust: () => {},
  },
  large_catering: {
    key: "large_catering", title: "Large catering order", description: "A big order, so the reorder costs more than your approval threshold.",
    order: { items: [{ item: "Jollof rice", qty: 60 }] }, changes: "60 plates of jollof rice.", adjust: () => {},
  },
  new_supplier: {
    key: "new_supplier", title: "New supplier", description: "Your usual supplier can't deliver today, so an approved supplier you've never paid is chosen.",
    order: { items: [{ item: "Jollof rice", qty: 10 }] }, changes: "Lagos Fresh Foods (demo) can't deliver today.",
    adjust: d => { for (const s of d.suppliers) if (s.name === "Lagos Fresh Foods (demo)") s.available_today = false; },
  },
  price_spike: {
    key: "price_spike", title: "Price spike", description: "Approved suppliers quote far more than usual, so the payment is over your maximum.",
    order: { items: [{ item: "Jollof rice", qty: 10 }] }, changes: "Approved suppliers quote ₦8,500/kg for rice.",
    // The testnet price list spikes too (0.004 NEAR/kg), so the outcome is BLOCK in both currencies (§8.2).
    adjust: d => { for (const s of d.suppliers) if (s.approved) { s.price_per_unit_ngn = 8_500; if (s.near_per_unit_yocto) s.near_per_unit_yocto = "4000000000000000000000"; } },
  },
  quiet_day: {
    key: "quiet_day", title: "Quiet day", description: "A small order that leaves every item above its reorder point.",
    order: { items: [{ item: "Grilled chicken", qty: 2 }] }, changes: "2 plates of grilled chicken.", adjust: () => {},
  },
};

/** The run's own copy of the demo data with the scenario's changes applied. */
export function scenarioSnapshot(key: ScenarioKey): DemoScenario {
  const d = restaurantDemoScenario();
  SCENARIO_DEFS[key].adjust(d);
  return d;
}

const round = (n: number) => Math.round(n * 100) / 100;

/** Stock used by an order (pure). */
export function stockAfterOrder(d: DemoScenario, order: DemoOrder): DemoScenario["inventory"] {
  const inv = structuredClone(d.inventory);
  for (const line of order.items) {
    const recipe = (d.recipes ?? []).find(r => r.item === line.item);
    for (const u of recipe?.uses ?? []) {
      const s = inv.find(i => i.item === u.stock_item);
      if (s) s.on_hand = round(s.on_hand - u.qty * line.qty);
    }
  }
  return inv;
}

/** The first item below its reorder point, with the quantity that brings it back to par (pure). */
export function reorderFor(inv: DemoScenario["inventory"]): { item: string; unit: string; quantity: number; on_hand: number; reorder_point: number } | null {
  const low = inv.find(i => i.on_hand < i.reorder_point);
  return low ? { item: low.item, unit: low.unit, quantity: Math.ceil(low.par_level - low.on_hand), on_hand: low.on_hand, reorder_point: low.reorder_point } : null;
}

/**
 * The cheapest APPROVED supplier that can deliver today (ties: faster delivery). Unapproved and
 * unavailable suppliers are excluded, each with a reason (pure).
 */
export function chooseSupplier(d: DemoScenario, item: string) {
  const candidates = d.suppliers.filter(s => s.item === item);
  const excluded = candidates.filter(s => !s.approved || s.available_today === false)
    .map(s => ({ name: s.name, reason: !s.approved ? "not an approved supplier" : "can't deliver today" }));
  const eligible = candidates.filter(s => s.approved && s.available_today !== false)
    .sort((a, b) => a.price_per_unit_ngn - b.price_per_unit_ngn || a.delivery_days - b.delivery_days);
  return { chosen: eligible[0] ?? null, excluded, considered: candidates.length };
}
