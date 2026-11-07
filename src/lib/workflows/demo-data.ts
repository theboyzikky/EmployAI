// Restaurant DEMO data (fictional). Stored in `businesses.scenario_data` (approved column), never in the
// owner's business profile, and always shown with a "Demo data — fictional" label. Amounts are
// illustrative NGN for the demo; they are not live prices and are never converted to NEAR.
//
// M4 · D5 (version 2): recipes, stock and par levels tuned so each scenario reliably hits its rule, each
// fictional supplier's payment history and availability, and a read-only demo spending policy. The new
// fields are optional in the type, so version-1 data already stored stays valid; test runs always copy
// the current definition into the run (never back into the business or profile).

export const RESTAURANT_INDUSTRY = "Restaurant / food service";
export const DEMO_DATA_VERSION = "restaurant-demo-2026-11-07-v2";

export type DemoScenario = {
  kind: "restaurant_demo";
  version: string;
  demo: true;
  label: string;
  currency: "NGN";
  menu: Array<{ item: string; price_ngn: number }>;
  inventory: Array<{ item: string; unit: string; on_hand: number; reorder_point: number; par_level: number }>;
  suppliers: Array<{
    name: string; approved: boolean; item: string; price_per_unit_ngn: number; delivery_days: number;
    /** v2: fictional payment history (the only "paid before" signal; test runs never add to it, D7). */
    prior_payments?: number;
    /** v2: whether the supplier can deliver today. */
    available_today?: boolean;
  }>;
  /** v2: how much stock one plate uses. */
  recipes?: Array<{ item: string; uses: Array<{ stock_item: string; qty: number }> }>;
  /** v2: read-only demo policy values (illustrative NGN). */
  policy?: { version: string; daily_limit_ngn: number };
};

export function restaurantDemoScenario(): DemoScenario {
  return {
    kind: "restaurant_demo",
    version: DEMO_DATA_VERSION,
    demo: true,
    label: "Demo data — fictional menu, stock and suppliers for the restaurant test run. Not your real business data.",
    currency: "NGN",
    menu: [
      { item: "Jollof rice", price_ngn: 3_500 },
      { item: "Fried rice", price_ngn: 3_500 },
      { item: "Pepper soup", price_ngn: 4_000 },
      { item: "Grilled chicken", price_ngn: 5_000 },
    ],
    inventory: [
      { item: "Rice", unit: "kg", on_hand: 26, reorder_point: 25, par_level: 55 },
      { item: "Cooking oil", unit: "L", on_hand: 15, reorder_point: 10, par_level: 40 },
      { item: "Chicken", unit: "kg", on_hand: 12, reorder_point: 8, par_level: 30 },
      { item: "Tomatoes", unit: "kg", on_hand: 14, reorder_point: 10, par_level: 30 },
    ],
    suppliers: [
      { name: "Mainland Grains (demo)", approved: true, item: "Rice", price_per_unit_ngn: 1_450, delivery_days: 1, prior_payments: 0, available_today: true },
      { name: "Lagos Fresh Foods (demo)", approved: true, item: "Rice", price_per_unit_ngn: 1_380, delivery_days: 2, prior_payments: 6, available_today: true },
      { name: "QuickSupply Express (demo)", approved: false, item: "Rice", price_per_unit_ngn: 1_150, delivery_days: 0, prior_payments: 0, available_today: true },
    ],
    recipes: [
      { item: "Jollof rice", uses: [{ stock_item: "Rice", qty: 0.2 }, { stock_item: "Cooking oil", qty: 0.02 }] },
      { item: "Fried rice", uses: [{ stock_item: "Rice", qty: 0.2 }, { stock_item: "Cooking oil", qty: 0.03 }] },
      { item: "Grilled chicken", uses: [{ stock_item: "Chicken", qty: 0.5 }] },
      { item: "Pepper soup", uses: [{ stock_item: "Chicken", qty: 0.25 }, { stock_item: "Tomatoes", qty: 0.1 }] },
    ],
    policy: { version: "demo-policy-v2", daily_limit_ngn: 500_000 },
  };
}

/** Restaurant is the only runnable workflow scenario in this prototype. */
export const isRunnableIndustry = (industry: string | null | undefined) => industry === RESTAURANT_INDUSTRY;
