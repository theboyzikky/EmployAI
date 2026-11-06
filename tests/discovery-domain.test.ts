import { describe, expect, test } from "vitest";
import { mergeFacts } from "@/lib/discovery/merge";
import { emptyProfile, readiness, type ProfileDoc } from "@/lib/discovery/profile";
import { groundAnalysis, type RawAnalysis } from "@/lib/discovery/analysis";
import { offlineDiscoveryTurn } from "@/lib/rules/consultant";
import { offlineAnalysis } from "@/lib/rules/analysis";

const known = (value: string, status: "confirmed" | "assumed" = "confirmed") => ({ value, status, sources: ["m1"], updated_by: "consultant" as const, updated_at: null });

describe("merging facts (code-enforced rules)", () => {
  const owner = new Set(["m1", "m2"]);

  test("a fact must cite one of the owner's messages in THIS session", () => {
    const r = mergeFacts(emptyProfile(), [
      { field: "industry", value: "Restaurant", status: "confirmed", source_message_ids: ["m1"] },
      { field: "goals", value: "Invented goal", status: "confirmed", source_message_ids: ["not-a-real-message"] },
    ], owner);
    expect(r.profile.fields.industry.value).toBe("Restaurant");
    expect(r.profile.fields.goals.status).toBe("unknown");
    expect(r.rejected).toBe(1);
  });

  test("owner edits are never overwritten; assumptions never replace confirmed answers; lists accumulate", () => {
    const p = emptyProfile();
    p.fields.business_name = { value: "Owner's Name", status: "confirmed", sources: [], updated_by: "owner", updated_at: null };
    p.fields.suppliers = known("Market traders");
    p.fields.customers_channels = known("WhatsApp");
    const r = mergeFacts(p, [
      { field: "business_name", value: "AI's guess", status: "confirmed", source_message_ids: ["m2"] },
      { field: "suppliers", value: "Probably a wholesaler", status: "assumed", source_message_ids: ["m2"] },
      { field: "customers_channels", value: "Phone, WhatsApp", status: "confirmed", source_message_ids: ["m2"] },
    ], owner);
    expect(r.profile.fields.business_name.value).toBe("Owner's Name");
    expect(r.profile.fields.suppliers.value).toBe("Market traders");
    expect(r.profile.fields.customers_channels.value).toBe("WhatsApp, Phone");
  });
});

describe("readiness is decided by code", () => {
  test("the question waiting for an answer is not resolved", () => {
    const p = emptyProfile();
    for (const k of ["industry", "products_services", "customers_channels", "challenges", "goals", "business_name", "suppliers"] as const) p.fields[k] = known("x");
    p.asked = ["team_structure"];
    p.last_question_field = "team_structure";
    expect(readiness(p).ready).toBe(false);
    p.last_question_field = null; // the owner replied (without answering it)
    expect(readiness(p).ready).toBe(true);
  });
});

describe("offline consultant turn", () => {
  const transcript = [{ id: "m1", role: "user" as const, content: "I run a small restaurant called Mama Nkechi's Kitchen. We take orders at the counter and on WhatsApp, and we often run out of rice because I reorder from suppliers by phone." }];

  test("first turn: acknowledges what it understood and asks exactly one question about an unknown field", () => {
    const t = offlineDiscoveryTurn({ profile: emptyProfile(), transcript, newOwnerMessageIds: ["m1"], firstTurn: true });
    expect(t.facts.every(f => f.source_message_ids[0] === "m1")).toBe(true);
    expect(t.question_field).toBe("products_services");
    expect(t.reply.match(/\?/g)?.length).toBe(1);
    expect(t.reply).toContain("Mama Nkechi's Kitchen");
  });

  test("a side mention never overwrites an earlier direct answer", () => {
    const p = emptyProfile();
    p.fields.industry = known("Restaurant / food service");
    p.fields.suppliers = known("I reorder from suppliers by phone");
    p.last_question_field = "goals"; p.asked = ["goals"];
    const t = offlineDiscoveryTurn({
      profile: p,
      transcript: [...transcript, { id: "m2", role: "user", content: "I want to stop calling suppliers every morning." }],
      newOwnerMessageIds: ["m2"], firstTurn: false,
    });
    expect(t.facts.find(f => f.field === "suppliers")).toBeUndefined();
    expect(t.facts.find(f => f.field === "goals")?.value).toMatch(/stop calling suppliers/);
  });
});

describe("analysis grounding", () => {
  const profile: ProfileDoc = emptyProfile();
  profile.fields.industry = known("Restaurant / food service");
  profile.fields.challenges = known("we run out of rice");
  profile.fields.daily_operations = known("We open at 11", "assumed");

  test("items without real evidence are dropped; basis is computed by code", () => {
    const raw: RawAnalysis = {
      processes: [
        { title: "Invented process", detail: "", evidence: [{ kind: "message", message_id: "other-session-msg" }], capability: null },
        { title: "Managing stock", detail: "", evidence: [{ kind: "field", field: "industry" }], capability: null },
        { title: "Daily routine", detail: "", evidence: [{ kind: "field", field: "daily_operations" }], capability: null },
      ],
      repetitive_tasks: [],
      bottlenecks: [{ title: "Rice runs out", detail: "", evidence: [{ kind: "field", field: "challenges" }, { kind: "field", field: "goals" }], capability: null }],
      opportunities: [],
    };
    const a = groundAnalysis(raw, profile, new Set(["m1"]), "offline-demo");
    expect(a.rejected_items).toBe(1);
    expect(a.processes.map(i => [i.title, i.basis])).toEqual([["Managing stock", "assumed"], ["Daily routine", "assumed"]]);
    expect(a.bottlenecks[0].basis).toBe("confirmed");
    expect(a.bottlenecks[0].evidence).toEqual([{ kind: "field", field: "challenges" }]); // unknown "goals" evidence removed
  });

  test("offline analysis of a salon proposes bookings, not order taking", () => {
    const p = emptyProfile();
    p.fields.industry = known("Salon / beauty services");
    p.fields.customers_channels = known("Instagram, WhatsApp, Bookings / appointments");
    p.fields.challenges = known("no-shows are killing us");
    const caps = offlineAnalysis(p).opportunities.map(o => o.capability);
    expect(caps).toContain("bookings");
    expect(caps).not.toContain("order_intake");
    expect(caps).not.toContain("inventory_tracking");
  });
});

test("merged values (including live AI output) get official brand casing", () => {
  const r = mergeFacts(emptyProfile(), [{ field: "current_tools", value: "whatsapp and google sheets", status: "confirmed", source_message_ids: ["m1"] }], new Set(["m1"]));
  expect(r.profile.fields.current_tools.value).toBe("WhatsApp and Google Sheets");
});
