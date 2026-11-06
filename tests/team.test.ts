import { describe, expect, test } from "vitest";
import { AGENT_TEMPLATES } from "@/lib/catalogue/catalogue";
import { AgentPatchSchema, applyAgentPatch, proposeTeam, teamWarnings } from "@/lib/catalogue/propose";
import { groundAnalysis } from "@/lib/discovery/analysis";
import { emptyProfile, type ProfileDoc, type ProfileFieldKey } from "@/lib/discovery/profile";
import { offlineAnalysis } from "@/lib/rules/analysis";

function profileOf(values: Partial<Record<ProfileFieldKey, string>>): ProfileDoc {
  const p = emptyProfile();
  for (const [k, v] of Object.entries(values)) p.fields[k as ProfileFieldKey] = { value: v!, status: "confirmed", sources: ["m1"], updated_by: "consultant", updated_at: null };
  return p;
}
const teamFor = (p: ProfileDoc) => proposeTeam(groundAnalysis(offlineAnalysis(p), p, new Set(["m1"]), "offline-demo"));

describe("deterministic team proposal", () => {
  test("restaurant demo: Orchestrator + Order, Inventory, Procurement and Finance (FR-06 / AT-04)", () => {
    const team = teamFor(profileOf({
      industry: "Restaurant / food service", products_services: "Jollof rice", customers_channels: "WhatsApp, In person",
      suppliers: "I reorder from suppliers by phone", challenges: "we often run out of rice", goals: "stop running out",
    }));
    expect(team.map(a => a.key)).toEqual(["orchestrator", "order", "inventory", "procurement", "finance"]);
    expect(team.every(a => a.definition.active === false)).toBe(true);
    expect(team.every(a => a.definition.reasons.length > 0)).toBe(true);
  });

  test("not every agent for every business: a consultancy without stock or suppliers", () => {
    const team = teamFor(profileOf({
      industry: "Professional / local services", products_services: "Bookkeeping for small firms", customers_channels: "Email, Phone",
      challenges: "Chasing invoices and late payments", goals: "Get paid on time",
    }));
    const keys = team.map(a => a.key);
    expect(keys).not.toContain("inventory");
    expect(keys).not.toContain("procurement");
    expect(keys).toContain("finance");
    expect(keys).not.toContain("orchestrator"); // only one specialist
  });

  test("tools, scopes and money permissions come only from the catalogue", () => {
    for (const a of teamFor(profileOf({ industry: "Retail", products_services: "Phones", customers_channels: "In store, sales on WhatsApp", suppliers: "a wholesaler", challenges: "stock runs out" }))) {
      expect(a.definition.allowed_tools).toEqual(AGENT_TEMPLATES[a.key].allowed_tools);
      expect(a.definition.financial_permissions).toBe(AGENT_TEMPLATES[a.key].financial_permissions);
    }
  });
});

describe("owner configuration", () => {
  const def = proposeTeam(groundAnalysis(offlineAnalysis(profileOf({ industry: "Retail", customers_channels: "sales on WhatsApp", challenges: "x" })), profileOf({ industry: "Retail", customers_channels: "sales on WhatsApp", challenges: "x" }), new Set(), "offline-demo"))
    .find(a => a.key === "order")!.definition;

  test("tools and permissions can't be edited through the API schema", () => {
    expect(AgentPatchSchema.safeParse({ allowed_tools: ["transfer_funds"] }).success).toBe(false);
    expect(AgentPatchSchema.safeParse({ financial_permissions: "unlimited" }).success).toBe(false);
  });

  test("tasks can be switched off, but not all of them", () => {
    const r = applyAgentPatch(def, { tasks: { confirm: false } });
    expect("error" in r).toBe(false);
    const all = Object.fromEntries(def.tasks.map(t => [t.id, false]));
    expect(applyAgentPatch(def, { tasks: all })).toEqual({ error: "Keep at least one task, or remove the agent instead." });
    expect(applyAgentPatch(def, { tasks: { pay_everyone: true } })).toEqual({ error: "Unknown task for this agent." });
  });

  test("warnings explain dependencies before approval", () => {
    expect(teamWarnings([{ key: "procurement", status: "proposed" }, { key: "finance", status: "removed" }])).toContain("Procurement Agent relies on the Finance Agent to complete its work.");
    expect(teamWarnings([{ key: "orchestrator", status: "proposed" }, { key: "order", status: "proposed" }])[0]).toMatch(/two or more specialists/);
  });
});
