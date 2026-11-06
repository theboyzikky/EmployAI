// The M3.5 reference restaurant conversation: an owner answering what the consultant actually asks
// (by the question's purpose, not by keywords in the text). Used by the route tests and the demo.
import type { DiscoveryView } from "@/lib/discovery/view-types";

export const RESTAURANT_HERO = "I run a small restaurant called Mama Nkechi's Kitchen. We take orders at the counter and on WhatsApp, and we often run out of rice and cooking oil because I reorder from suppliers by phone.";

const FACTS: Record<string, string> = {
  industry: "A restaurant.",
  products_services: "Jollof rice, fried rice and grilled chicken.",
  goals: "I want to stop running out of ingredients and stop phoning suppliers every morning.",
  team_structure: "Me, my sister and two cooks.",
  current_tools: "A notebook and WhatsApp.",
  daily_operations: "We open at 11 and close at 9.",
  customers_channels: "Counter and WhatsApp orders.",
  challenges: "Running out of rice.",
  suppliers: "Two market suppliers, by phone.",
  business_name: "Mama Nkechi's Kitchen",
};

/** Owner answers to the diagnostic questions about each possible cause. */
const CAUSES: Record<string, string> = {
  manual_ordering: "It can take hours, because I'm busy cooking and forget to call.",
  peak_load: "Yes, mostly on busy evenings.",
  untracked_spending: "Not really, I pay cash and the receipts get lost.",
};

export const OTHER_PROBLEMS = "Sometimes we miss WhatsApp orders on busy evenings, and I lose track of supplier payments because I pay cash.";

export function referenceAnswer(asking: DiscoveryView["understanding"]["asking"]): string {
  if (!asking) return "Nothing else to add.";
  switch (asking.kind) {
    case "fact": return FACTS[asking.target] ?? "I'd rather not say.";
    case "gap": return FACTS[asking.target.split("|")[1]] ?? "I'd rather not say.";      // P6: "capability:gap|field"
    case "opening": return "Mostly the same questions, again and again.";
    case "hypothesis": return CAUSES[asking.target] ?? "I don't know.";
    case "confirm_cause": return "Yes, exactly.";
    case "other_problems": return OTHER_PROBLEMS;
    case "contradiction": return "It's the second one.";
    default: return "It happens most weeks.";
  }
}
