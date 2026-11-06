// M3.5 pre-commit audit: regression tests for every probe example. Offline only (tests/setup.ts blocks fetch).
//   1 · evidence must support the specific cause; neutral statements don't open problems;
//   2 · summary approval of inferences is recorded, still as inferences;
//   3 · industry detection: original order restored; new industries only when they name the business.
import { describe, expect, test } from "vitest";
import { discoveryReadiness, syncOwnerFields } from "@/lib/discovery/casefile";
import { caseBasis, groundAnalysis } from "@/lib/discovery/analysis";
import type { ProfileDoc } from "@/lib/discovery/profile";
import { buildUnderstanding } from "@/lib/discovery/understanding";
import { proposeTeam } from "@/lib/catalogue/propose";
import { offlineAnalysis } from "@/lib/rules/analysis";
import { extractFacts } from "@/lib/rules/extract";
import { conversation } from "./helpers/converse";

const ISAAC = "Hello, I'm Isaac and I'm into real estate. I want to automate my chat replies to my clients.";
const MIXED = "Hi, I'm Tunde. I run a restaurant called Bukka Hut with 4 staff. We keep missing WhatsApp orders on busy evenings. I want to automate order taking.";
const supported = (c: ReturnType<typeof conversation>) => c.caseFile.problems.flatMap(p => p.hypotheses.filter(h => h.status === "supported" || h.status === "confirmed").map(h => h.key));
const teamOf = (c: ReturnType<typeof conversation>) => {
  const owner = new Set(c.transcript.filter(m => m.role === "user").map(m => m.id));
  return proposeTeam(caseBasis(groundAnalysis(offlineAnalysis(c.profile), c.profile, owner, "offline-demo"), c.profile.case_file!)).map(a => a.key);
};

describe("audit 1 · a passing mention is not evidence for a cause that wasn't asked about", () => {
  const cases: Array<[string, string, string, string[]]> = [
    // [introduction, answer to the cause question, the incidental cause that must NOT be supported, causes that may be]
    ["I run a restaurant. We keep missing WhatsApp orders on busy evenings.", "Actually it's just me now, and I also use Instagram.", "channel_overload", []],
    ["I run a restaurant and we often run out of rice.", "It can take a while, I usually call them in the evening.", "supplier_delay", ["manual_ordering"]],
    ["I run a restaurant and we often run out of rice.", "We're open every day including weekends.", "demand_spikes", []],
    ["I run a restaurant and customers wait too long for their food.", "I take orders on WhatsApp too.", "order_taking", []],
    [ISAAC, "WhatsApp, and I'm busy with viewings most of the day.", "after_hours", []],
    [ISAAC, "WhatsApp. Prices in Lekki are high this year.", "repetitive", []],
  ];
  for (const [hero, answer, notThis, allowed] of cases) {
    test(`“${answer}” does not support “${notThis}”`, () => {
      const c = conversation();
      c.say(hero);
      c.say(answer);
      expect(supported(c)).not.toContain(notThis);
      expect(supported(c).every(k => allowed.includes(k))).toBe(true);
    });
  }
  test("a direct statement of another cause still counts", () => {
    const c = conversation();
    c.say("I run a restaurant. We keep missing WhatsApp orders on busy evenings.");
    c.say("Orders get lost across WhatsApp and Instagram.");
    expect(supported(c)).toContain("channel_overload");
    const i = conversation();
    i.say(ISAAC);
    i.say("WhatsApp, and lots of messages come in late at night.");
    expect(supported(i)).toEqual(["after_hours"]);
  });
  test("the answer to the cause actually asked still uses its own evidence", () => {
    const c = conversation();
    c.say("I run a restaurant and we often run out of rice.");
    c.say("It can take hours, because I'm busy cooking and forget to call.");
    expect(supported(c)).toEqual(["manual_ordering"]);
  });
  test("the open question about a goal may still point to several causes", () => {
    const c = conversation();
    c.say(ISAAC);
    c.say("Mostly WhatsApp.");
    c.say("Mostly the same questions about prices and whether a property is still available, and a lot of them come in late at night.");
    expect(supported(c).sort()).toEqual(["after_hours", "repetitive"]);
  });
});

describe("audit 1 · neutral statements don't open a problem", () => {
  const NEUTRAL = [
    "We open late on Sundays.", "We're busy on weekends.", "I also use Instagram.", "We take orders on WhatsApp and by phone.",
    "I do the books manually in a notebook.", "Customers often call to ask about the menu.", "Prices change every week at the market.",
  ];
  for (const s of NEUTRAL) {
    test(`“${s}” opens no problem`, () => {
      const c = conversation();
      c.say(`I run a restaurant. ${s}`);
      expect(c.caseFile.problems).toEqual([]);
      expect(c.caseFile.claims.filter(x => x.kind === "symptom")).toEqual([]);
    });
  }
  test.each([
    ["I spend hours on WhatsApp every evening.", "enquiries"],
    ["We're always late with supplier payments.", null],
  ])("a stated burden still does: “%s”", (s, playbook) => {
    const c = conversation();
    c.say(`I run a restaurant. ${s}`);
    expect(c.caseFile.problems.map(p => p.playbook)).toEqual([playbook]);
  });
});

describe("audit 1 · the mixed message: Instagram adds no cause and no agent", () => {
  test("correction and new channel recorded; no extra supported cause; the team is the Order Agent alone", () => {
    const c = conversation();
    c.say(MIXED);
    c.say("Actually it's just me now, and I also use Instagram.");
    expect(c.caseFile.facts.team_size?.value).toBe("Just you (no staff)");
    expect(c.profile.fields.customers_channels.value).toBe("WhatsApp, Instagram");
    expect(supported(c)).toEqual([]);
    expect(buildUnderstanding(c.profile).solutions.map(s => s.agent)).toEqual(["Order Agent"]);
    // Through to readiness, answering only what's asked.
    for (let i = 0; i < 12 && !discoveryReadiness(c.profile).ready; i++) {
      const a = buildUnderstanding(c.profile).asking;
      c.say(a?.kind === "hypothesis" && a.target === "peak_load" ? "Yes, mostly at busy times." : a?.kind === "confirm_cause" ? "Yes." : a?.kind === "other_problems" ? "No, that's all." : a?.kind === "gap" ? "Jollof rice and chicken." : "I don't know.");
    }
    expect(supported(c)).toEqual(["peak_load"]);
    expect(teamOf(c)).toEqual(["order"]);
  });
  test("the same answer as in the audit (“Yes, mostly at busy times. I also use Instagram.”) keeps the team to the Order Agent", () => {
    const c = conversation();
    c.say("I run a restaurant called Bukka Hut. We keep missing WhatsApp orders on busy evenings.");
    c.say("Yes, mostly at busy times. I also use Instagram.");
    for (let i = 0; i < 12 && !discoveryReadiness(c.profile).ready; i++) {
      const a = buildUnderstanding(c.profile).asking;
      c.say(a?.kind === "confirm_cause" ? "Yes." : a?.kind === "other_problems" ? "No, that's all." : a?.kind === "gap" ? "Jollof rice and chicken." : "I don't know.");
    }
    expect(supported(c)).toEqual(["peak_load"]);
    expect(teamOf(c)).toEqual(["order"]);
  });
});

describe("audit 2 · summary approval of inferences: recorded, still inferences", () => {
  /** What the service's confirmSummary does: shown fields become confirmed, then the case file is synced. */
  const confirmSummary = (p: ProfileDoc) => syncOwnerFields({ ...p, fields: Object.fromEntries(Object.entries(p.fields).map(([k, f]) => [k, f.status === "assumed" ? { ...f, status: "confirmed" } : f])) as ProfileDoc["fields"] }, [], true);
  test("approved inferences are marked approved in the summary review, keep kind “implied”, and don't become facts", () => {
    const c = conversation();
    c.say(ISAAC);
    const after = confirmSummary(c.profile);
    const inf = after.case_file!.inferences!;
    expect(inf.filter(i => i.kind === "implied").map(i => [i.key, i.status, i.settled_by])).toEqual([["channel_messages", "confirmed", "summary_review"], ["offer", "confirmed", "summary_review"]]);
    expect(after.case_file!.facts.products_services).toBeUndefined();          // not converted into an owner-stated fact
    expect(after.case_file!.facts.customers_channels).toBeUndefined();
    // Typical industry knowledge is never confirmed by the summary, and no cause is confirmed either.
    expect(inf.find(i => i.key === "typical_topics")).toMatchObject({ kind: "typical", status: "inferred" });
    expect(after.case_file!.problems.flatMap(p => p.hypotheses).some(h => h.status === "confirmed")).toBe(false);
    // The panel says what happened.
    expect(buildUnderstanding(after).inferences.filter(i => i.kind === "implied").map(i => i.settledBy)).toEqual(["summary_review", "summary_review"]);
  });
  test("an inferred field the owner corrects in the summary is recorded as a rejected inference", () => {
    const c = conversation();
    c.say(ISAAC);
    const edited = { ...c.profile, fields: { ...c.profile.fields, products_services: { value: "Short-let apartments", status: "confirmed" as const, sources: [], updated_by: "owner" as const, updated_at: null } } };
    const after = syncOwnerFields(edited, ["products_services"]);
    expect(after.case_file!.inferences!.find(i => i.key === "offer")).toMatchObject({ status: "rejected", settled_by: "summary_review" });
    expect(after.case_file!.facts.products_services).toMatchObject({ value: "Short-let apartments", updated_by: "owner" });
  });
  test("an inference confirmed by the owner's own words says so", () => {
    const c = conversation();
    c.say(ISAAC);
    c.say("Mostly WhatsApp.");
    expect(c.caseFile.inferences!.find(i => i.key === "channel_messages")).toMatchObject({ kind: "implied", status: "confirmed", settled_by: "owner_words" });
  });
});

describe("audit 3 · industry: original order restored; new industries only when they name the business", () => {
  test.each([
    ["Mama Nkechi's Kitchen serves lunch to construction workers.", "Restaurant / food service"],
    ["Our restaurant is next to a school.", "Restaurant / food service"],
    ["We serve farm-fresh food at our restaurant in Ikeja.", "Restaurant / food service"],
    ["My salon is above a garage.", "Salon / beauty services"],
    ["I run a restaurant next to a school.", "Restaurant / food service"],
  ])("“%s” → %s (consultant and the M2 extractor)", (s, industry) => {
    const c = conversation();
    c.say(s);
    expect(c.profile.fields.industry.value).toBe(industry);
    expect(extractFacts(s).find(f => f.field === "industry")?.value).toBe(industry);
  });
  test("a passing word alone names no industry", () => {
    expect(extractFacts("We sell phones and accessories; most customers are tutors and students.").find(f => f.field === "industry")).toBeUndefined();
  });
  test.each([
    ["Hello, I'm Isaac and I'm into real estate.", "Real estate / property"],
    ["We're a real estate agency in Lekki.", "Real estate / property"],
    ["I run a travel agency.", "Travel"],
    ["We are a digital agency.", "Technology / IT services"],
    ["We run a hotel in Calabar.", "Hospitality / accommodation"],
    ["Our tailoring business makes school uniforms.", "Fashion / tailoring"],
    ["I'm in construction.", "Construction / trades"],
    ["Real estate.", "Real estate / property"],
  ])("wording that names the business still works: “%s” → %s", (s, industry) => {
    expect(extractFacts(s).find(f => f.field === "industry")?.value).toBe(industry);
  });
});
