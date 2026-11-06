// Restaurant DEMO data (fictional). Stored in `businesses.scenario_data` (approved column), never in the
// owner's business profile, and always shown with a "Demo data — fictional" label. Amounts are
// illustrative NGN for the demo; they are not live prices and are never converted to NEAR.

export const RESTAURANT_INDUSTRY = "Restaurant / food service";
export const DEMO_DATA_VERSION = "restaurant-demo-2026-11-06";

export type DemoScenario = {
  kind: "restaurant_demo";
  version: string;
  demo: true;
  label: string;
  currency: "NGN";
  menu: Array<{ item: string; price_ngn: number }>;
  inventory: Array<{ item: string; unit: string; on_hand: number; reorder_point: number; par_level: number }>;
  suppliers: Array<{ name: string; approved: boolean; item: string; price_per_unit_ngn: number; delivery_days: number }>;
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
      { item: "Rice", unit: "kg", on_hand: 18, reorder_point: 25, par_level: 100 },
      { item: "Cooking oil", unit: "L", on_hand: 6, reorder_point: 10, par_level: 40 },
      { item: "Chicken", unit: "kg", on_hand: 12, reorder_point: 8, par_level: 30 },
      { item: "Tomatoes", unit: "kg", on_hand: 9, reorder_point: 10, par_level: 30 },
    ],
    suppliers: [
      { name: "Mainland Grains (demo)", approved: true, item: "Rice", price_per_unit_ngn: 1_450, delivery_days: 1 },
      { name: "Lagos Fresh Foods (demo)", approved: true, item: "Rice", price_per_unit_ngn: 1_380, delivery_days: 2 },
      { name: "QuickSupply Express (demo)", approved: false, item: "Rice", price_per_unit_ngn: 1_150, delivery_days: 0 },
    ],
  };
}

/** Restaurant is the only runnable workflow scenario in this prototype. */
export const isRunnableIndustry = (industry: string | null | undefined) => industry === RESTAURANT_INDUSTRY;
