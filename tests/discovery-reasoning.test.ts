// M3.5 acceptance tests (AC-1 … AC-15; AC-16 is the browser/build bar). Offline only: tests/setup.ts
// blocks fetch, and nothing here selects a live provider.
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { MAX_PROBES_PER_PROBLEM, MAX_QUESTIONS, caseReadiness, discoveryReadiness, fieldsView, isPreM35Discovery, migrateToCaseFile, revertCaseFileMigration, syncOwnerFields } from "@/lib/discovery/casefile";
import { DiscoveryTurnSchema } from "@/lib/discovery/merge";
import { caseBasis, groundAnalysis } from "@/lib/discovery/analysis";
import { PLAYBOOKS } from "@/lib/discovery/playbooks";
import { PROFILE_FIELDS, emptyProfile, type ProfileDoc } from "@/lib/discovery/profile";
import { buildUnderstanding } from "@/lib/discovery/understanding";
import { proposeTeam } from "@/lib/catalogue/propose";
import { offlineAnalysis } from "@/lib/rules/analysis";
import { conversation } from "./helpers/converse";
import { RESTAURANT_HERO, referenceAnswer } from "./helpers/reference";

const OVERBUY = "I run a small restaurant called Mama Nkechi's Kitchen in Lagos. Our restaurant keeps losing money because we buy too much stock.";
const questionCount = (s: string) => (s.match(/\?/g) ?? []).length;

/** Drive a conversation with an answer function until ready (or a hard stop). */
function drive(hero: string, answer: (asking: ReturnType<typeof buildUnderstanding>["asking"]) => string) {
  const c = conversation();
  c.say(hero);
  for (let i = 0; i < 20 && !discoveryReadiness(c.profile).ready; i++) c.say(answer(buildUnderstanding(c.profile).asking));
  return c;
}
const analyseTeam = (p: ProfileDoc, owner: Set<string>) => {
  const a = caseBasis(groundAnalysis(offlineAnalysis(p), p, owner, "offline-demo"), p.case_file!);
  return { analysis: a, team: proposeTeam(a) };
};
const ownerIds = (c: ReturnType<typeof conversation>) => new Set(c.transcript.filter(m => m.role === "user").map(m => m.id));

describe("AC-1 · causal statements are kept as the owner's unverified view", () => {
  test("“losing money because we buy too much stock”: symptom + stated cause, both cited, nothing confirmed", () => {
    const c = conversation();
    const ex = c.say(OVERBUY);
    const cf = c.caseFile;
    const sym = cf.claims.find(x => x.kind === "symptom")!;
    const cause = cf.claims.find(x => x.kind === "cause")!;
    expect(sym.text).toBe("Our restaurant keeps losing money");
    expect(cause.text).toBe("we buy too much stock");
    expect([sym.status, cause.status]).toEqual(["stated", "stated"]);
    expect(sym.sources).toEqual(["m1"]);
    expect(cf.problems[0]).toMatchObject({ playbook: "overbuying", resolution: "open", cause_claim: cause.id });
    expect(cf.problems[0].hypotheses.every(h => h.status === "open")).toBe(true);
    expect(ex.reply).toMatch(/you think it's because you buy too much stock\. I'll treat that as your view for now, not a conclusion/);
    // The panel shows it as the owner's view, not verified.
    expect(buildUnderstanding(c.profile).problems[0]).toMatchObject({ ownerView: "we buy too much stock", ownerViewStatus: "stated", resolution: "open" });
  });
});

describe("AC-2 · regression: the four misfiled answers from the diagnosis", () => {
  test("“I want to make more profit” to the channels question → a goal; channels stay open and are asked once more", () => {
    const c = conversation();
    c.say("I run a restaurant called Mama Nkechi's Kitchen.");
    c.pend("fact", "customers_channels");
    const ex = c.say("I want to make more profit.");
    expect(c.profile.fields.customers_channels.value).toBeNull();
    expect(c.profile.fields.goals.value).toBe("I want to make more profit");
    expect(ex.turn.plan.kind === "ask" && ex.turn.plan.item.key).toBe("fact:customers_channels");  // rephrased once
    expect(ex.turn.plan.kind === "ask" && ex.turn.plan.rephrase).toBe(true);
  });
  test("“We have 4 staff” to the goals question → team size, not a goal", () => {
    const c = conversation();
    c.say("I run a restaurant called Mama Nkechi's Kitchen.");
    c.pend("fact", "goals");
    c.say("We have 4 staff.");
    expect(c.profile.fields.goals.value).toBeNull();
    expect(c.caseFile.facts.team_size?.value).toBe("4 staff");
  });
  test("“Actually it's just me” to the suppliers question → a team correction, not a supplier", () => {
    const c = conversation();
    c.say("I run a restaurant called Mama Nkechi's Kitchen. We have 4 staff.");
    c.pend("fact", "suppliers");
    c.say("Actually it's just me, I do everything myself.");
    expect(c.profile.fields.suppliers.value).toBeNull();
    expect(c.caseFile.facts.team_size?.value).toBe("Just you (no staff)");
  });
  test("the stated cause (“because we buy too much stock”) is no longer dropped", () => {
    const c = conversation();
    c.say(OVERBUY);
    expect(c.caseFile.claims.map(x => x.text)).toContain("we buy too much stock");
  });
  test("found in the browser check: two facts in one answer are filed separately and both are acknowledged", () => {
    const c = conversation();
    c.say("I run a restaurant called Mama Nkechi's Kitchen.");
    c.pend("fact", "products_services");
    const ex = c.say("We have 4 staff and customers order at the counter and on WhatsApp.");
    expect(c.profile.fields.team_structure.value).toBe("4 staff");
    expect(c.profile.fields.customers_channels.value).toMatch(/WhatsApp/);
    expect(c.profile.fields.products_services.value).toBeNull();
    expect(ex.reply).toMatch(/Noted: .*team size “4 staff”/);
    expect(ex.reply).toMatch(/Noted: .*how your customers reach you “WhatsApp/);
  });
  test("found in the browser check: a menu given to the goals question is not filed as a goal", () => {
    const c = conversation();
    c.say("I run a restaurant called Mama Nkechi's Kitchen.");
    c.pend("fact", "goals");
    const ex = c.say("Jollof rice, fried rice and grilled chicken.");
    expect(c.profile.fields.goals.value).toBeNull();
    expect(c.caseFile.claims.some(x => x.kind === "goal")).toBe(false);
    expect(ex.reply).toMatch(/I'm not sure how that fits yet/);
    const again = c.say("I want to stop wasting food.");
    expect(c.profile.fields.goals.value).toBe("I want to stop wasting food");
    expect(again.reply).toMatch(/your goal is/);
  });
  test("found in the demo: “Me, my sister and two cooks” is four people including the owner, not “2 staff”", () => {
    const c = conversation();
    c.say("I run a restaurant called Mama Nkechi's Kitchen.");
    c.pend("fact", "team_structure");
    c.say("Me, my sister and two cooks.");
    expect(c.caseFile.facts.team_size?.value).toBe("4 people including you");
    expect(c.profile.fields.team_structure.value).toBe("Me, my sister and two cooks");
  });
  test("a reply that doesn't plausibly answer the field is not filed under it", () => {
    const c = conversation();
    c.say("I run a restaurant called Mama Nkechi's Kitchen.");
    c.pend("fact", "products_services");
    c.say("Every few months someone leaves after a few weeks.");
    expect(c.profile.fields.products_services.value).toBeNull();
  });
  test("a genuine answer is still filed (no over-correction)", () => {
    const c = conversation();
    c.say("I run a restaurant called Mama Nkechi's Kitchen.");
    c.pend("fact", "products_services");
    c.say("Jollof rice, fried rice and grilled chicken.");
    expect(c.profile.fields.products_services.value).toBe("Jollof rice, fried rice and grilled chicken");
  });
});

describe("AC-3 · contradictions are raised, not overwritten; corrections are recorded", () => {
  test("“4 staff” then “just me”: one clarifying question, the first value kept until resolved", () => {
    const c = conversation();
    c.say("I run a restaurant called Bukka Hut. Customers order at the counter.");
    c.say("We have 4 staff.");
    const ex = c.say("It's just me, I do everything.");
    expect(c.caseFile.contradictions).toHaveLength(1);
    expect(c.caseFile.contradictions[0]).toMatchObject({ slot: "team_size", status: "open", kind: "contradiction" });
    expect(c.caseFile.facts.team_size?.value).toBe("4 staff");            // not silently overwritten
    expect(c.profile.fields.team_structure.status).not.toBe("confirmed"); // shown as unconfirmed
    expect(ex.reply).toMatch(/Earlier you mentioned “4 staff”, and now “Just you \(no staff\)”\. Which is right\?/);
    expect(questionCount(ex.reply)).toBe(1);
    const fix = c.say("It's just me now.");
    expect(c.caseFile.contradictions[0]).toMatchObject({ status: "resolved", resolution: "Just you (no staff)" });
    expect(fix.reply).toMatch(/Got it: team size is “Just you \(no staff\)”/);
  });
  test("found in the browser check: a contradiction raised while another question is re-asked is still acknowledged", () => {
    const c = conversation();
    c.say("I run a restaurant called Bukka Hut. We have 4 staff and we keep running out of ingredients.");
    const ex = c.say("Rice and oil mostly. It's just me, I do everything.");
    expect(c.caseFile.contradictions[0]).toMatchObject({ status: "open" });
    expect(ex.reply).toMatch(/I've noted “Just you \(no staff\)”, which differs from the “4 staff” you mentioned earlier/);
    expect(questionCount(ex.reply)).toBe(1);
  });
  test("“Actually…” is a correction: applied, kept in history and shown", () => {
    const c = conversation();
    c.say("I run a restaurant. We have 4 staff.");
    c.say("Actually it's just me.");
    expect(c.caseFile.facts.team_size).toMatchObject({ value: "Just you (no staff)", history: [{ value: "4 staff" }] });
    expect(buildUnderstanding(c.profile).contradictions[0]).toMatchObject({ kind: "correction", status: "resolved", a: "4 staff", resolution: "Just you (no staff)" });
  });
});

describe("AC-4, AC-5, AC-6 · one question, no repetition, limits", () => {
  const scripts: Array<[string, Parameters<typeof drive>[1]]> = [
    ["reference", referenceAnswer],
    ["overbuying", a => a?.kind === "confirm_cause" ? "Yes." : a?.kind === "fact" ? "I'd rather not say." : "Tomatoes go bad and we buy the same amount every day."],
    ["skip-heavy", () => "I don't know."],
  ];
  for (const [name, answer] of scripts) {
    test(`${name}: every question is single and has a purpose; nothing is asked a third time; limits hold`, () => {
      const c = drive(name === "reference" ? RESTAURANT_HERO : OVERBUY, answer);
      for (const ex of c.log) {
        if (ex.turn.plan.kind === "ask") {
          expect(questionCount(ex.reply)).toBe(1);
          expect(ex.turn.plan.item.key).toMatch(/^(fact|hyp|confirm|contra|other_problems|describe|gap|opening|clarify)/);
        } else expect(questionCount(ex.reply)).toBe(0);
      }
      expect(c.caseFile.agenda.every(a => a.asked <= 2)).toBe(true);
      expect(c.caseFile.questions_asked).toBeLessThanOrEqual(MAX_QUESTIONS);
      expect(c.caseFile.problems.every(p => p.probes <= MAX_PROBES_PER_PROBLEM)).toBe(true);
      const texts = c.log.filter(e => e.turn.plan.kind === "ask").map(e => e.turn.plan.kind === "ask" ? e.turn.plan.text : "");
      expect(new Set(texts).size).toBe(texts.length);                       // never the same wording twice
    });
  }
  test("skip / “I don't know” marks it declined and it is never asked again", () => {
    const c = conversation();
    c.say("I run a restaurant called Mama Nkechi's Kitchen.");
    c.pend("fact", "products_services");
    const ex = c.say("Skip this question.");
    expect(c.caseFile.agenda.find(a => a.key === "fact:products_services")!.status).toBe("declined");
    expect(ex.turn.plan.kind === "ask" && ex.turn.plan.item.key).not.toBe("fact:products_services");
    expect(c.profile.skipped).toContain("products_services");
  });
  test("the limits never force certainty: unanswered causes end as UNKNOWN with what remains uncertain", () => {
    const c = drive("I own a restaurant and we keep running out of ingredients.", () => "I don't know.");
    const p = c.caseFile.problems[0];
    expect(p.resolution).toBe("unknown");
    expect(p.hypotheses.some(h => h.status === "confirmed" || h.status === "supported")).toBe(false);
    expect(p.uncertainty).toMatch(/still unknown\. Measure first: record when each item runs out/);
    expect(c.log.at(-1)!.reply).toMatch(/still unknown/);
    expect(c.log.at(-1)!.reply).not.toMatch(/clear enough picture/);          // no claim of certainty it doesn't have
    expect(c.log.at(-1)!.reply).toMatch(/as far as I can get by asking/);
  });
});

describe("AC-7 · facts, views and unknowns stay separate; only the owner confirms a cause", () => {
  test("a supported cause is not confirmed until the owner answers the confirmation question", () => {
    const c = conversation();
    c.say(OVERBUY);
    c.say("Tomatoes and peppers go bad a lot.");
    const spoil = () => c.caseFile.problems[0].hypotheses.find(h => h.key === "spoilage")!;
    expect(spoil().status).toBe("supported");
    expect(buildUnderstanding(c.profile).problems[0].causes.find(x => x.label.startsWith("stock spoils"))!.status).toBe("supported");
    c.say("Yes, that's right.");
    expect(spoil().status).toBe("confirmed");
  });
  test("a “yes” to a question that isn't a confirmation question confirms nothing", () => {
    const c = conversation();
    c.say("I run a restaurant and we keep running out of rice.");
    c.say("Yes.");
    expect(c.caseFile.problems[0].hypotheses.some(h => h.status === "confirmed")).toBe(false);
  });
  test("confirming the summary confirms reviewed facts, never possible causes", () => {
    const c = conversation();
    c.say(OVERBUY);
    c.say("Tomatoes and peppers go bad a lot.");
    const after = syncOwnerFields(c.profile, [], true);
    expect(after.case_file!.problems[0].hypotheses.find(h => h.key === "spoilage")!.status).toBe("supported");
  });
});

describe("AC-8 · the five restaurant playbooks reach a cause or an explicit unknown", () => {
  const cases: Array<[string, string, string, string]> = [
    ["overbuying", OVERBUY, "spoilage", "Tomatoes and peppers go bad a lot."],
    ["running_out", RESTAURANT_HERO, "manual_ordering", "It can take hours, because I'm busy cooking and forget to call."],
    ["missed_orders", "I run a restaurant. We keep missing WhatsApp orders.", "peak_load", "Yes, mostly at busy times in the evening."],
    ["slow_service", "I run a restaurant and customers wait too long for their food.", "understaffed_peak", "Yes, at lunch we are short-staffed."],
    ["low_profit", "I run a restaurant and we're not making any profit.", "untracked_spending", "Not really, I pay cash and lose the receipts."],
  ];
  for (const [pb, hero, cause, evidence] of cases) {
    test(`${pb}: investigated, then confirmed by the owner`, () => {
      const c = conversation();
      c.say(hero);
      expect(c.caseFile.problems[0].playbook).toBe(pb);
      // Answer the playbook's questions until the intended cause is asked about, then give evidence and confirm.
      for (let i = 0; i < 4; i++) {
        const asking = buildUnderstanding(c.profile).asking!;
        if (asking.kind === "confirm_cause") { c.say("Yes."); break; }
        c.say(asking.target === cause ? evidence : "I don't know.");
      }
      const p = c.caseFile.problems[0];
      expect(p.hypotheses.find(h => h.key === cause)!.status).toBe("confirmed");
      expect(p.resolution).toBe("cause_confirmed");
      expect(p.probes).toBeLessThanOrEqual(MAX_PROBES_PER_PROBLEM);
    });
  }
  test("all five restaurant playbooks exist, each with 4–5 possible causes and a single question per cause", () => {
    const restaurant = PLAYBOOKS.filter(p => p.industries !== "any" && p.industries.includes("Restaurant / food service"));
    expect(restaurant.map(p => p.key).sort()).toEqual(["low_profit", "missed_orders", "overbuying", "running_out", "slow_service"]);
    for (const p of restaurant) {
      expect(p.causes.length).toBeGreaterThanOrEqual(4);
      for (const k of p.causes) for (const q of [k.question, k.rephrase]) expect(questionCount(q)).toBe(1);
    }
  });
});

describe("AC-9 · honest fallback for problems it doesn't recognise", () => {
  test("“my staff keep quitting”: no invented causes; asks for a description; closes as unknown", () => {
    const c = conversation();
    const first = c.say("I run a restaurant. My staff keep quitting.");
    expect(first.reply).toMatch(/I don't recognise that kind of problem yet, so I won't guess at its causes/);
    expect(c.caseFile.problems[0]).toMatchObject({ playbook: null, hypotheses: [] });
    c.say("Every few months someone leaves after a few weeks.");
    expect(c.caseFile.problems[0].resolution).toBe("unknown");
    expect(c.caseFile.problems[0].hypotheses).toEqual([]);
  });
});

describe("AC-10 · explains its reasoning; reflects only what was recorded", () => {
  test("the first probe gives the reason; the owner's own explanation is checked first", () => {
    const c = conversation();
    const ex = c.say(RESTAURANT_HERO);
    expect(ex.reply).toMatch(/you think it's because you reorder from suppliers by phone\. I'll treat that as your view for now, not a conclusion\.\n\nLet me check your explanation first, along with other possible causes\./);
    expect(ex.reply.match(/because you reorder from suppliers by phone/g)).toHaveLength(1);   // said once, not twice
    expect(ex.turn.plan.kind === "ask" && ex.turn.plan.item.target).toBe("manual_ordering");
    const b = conversation().say(OVERBUY);
    expect(b.reply).toContain(PLAYBOOKS.find(p => p.key === "overbuying")!.reason);
  });
});

describe("AC-11 · knows when to move on", () => {
  test("the reference conversation becomes ready without the budget, and the summary lists confirmed causes", () => {
    const c = drive(RESTAURANT_HERO, referenceAnswer);
    const r = discoveryReadiness(c.profile);
    expect(r).toMatchObject({ ready: true, byBudget: false });
    expect(c.log.at(-1)!.reply).toMatch(/I think I have a clear enough picture/);
    expect(c.caseFile.problems.map(p => p.resolution)).toEqual(["cause_confirmed", "cause_confirmed", "cause_confirmed"]);
  });
  test("not ready while a problem is still being investigated or a question is waiting", () => {
    const c = conversation();
    c.say(OVERBUY);
    expect(caseReadiness(c.caseFile, c.profile.fields).ready).toBe(false);
  });
});

describe("AC-12, AC-13 · grounded analysis and agents traceable to problems and causes", () => {
  test("reference conversation: five agents, each specialist traced to a problem and its confirmed cause", () => {
    const c = drive(RESTAURANT_HERO, referenceAnswer);
    const { analysis, team } = analyseTeam(c.profile, ownerIds(c));
    expect(team.map(a => a.key)).toEqual(["orchestrator", "order", "inventory", "procurement", "finance"]);
    for (const a of team.filter(x => x.key !== "orchestrator")) {
      expect(a.definition.reasons.length).toBeGreaterThan(0);
      for (const r of a.definition.reasons) {
        expect(r.detail).toMatch(/^Addresses “.+”, caused, as you confirmed, by: /);
        expect(r.evidence.every(e => e.kind === "message")).toBe(true);
        expect(r.basis).toBe("confirmed");
      }
    }
    // Bottlenecks are cause chains.
    expect(analysis.bottlenecks.map(b => b.detail)).toEqual(expect.arrayContaining([expect.stringMatching(/^Cause, confirmed by you: reordering by phone/)]));
  });
  test("a supported (unconfirmed) cause is labelled as such; an unknown cause only yields “measure first”", () => {
    const sup = conversation();
    sup.say(OVERBUY);
    sup.say("Tomatoes and peppers go bad a lot.");
    sup.say("Partly.");
    for (let i = 0; i < 6; i++) sup.say("I don't know.");
    const s = analyseTeam(sup.profile, ownerIds(sup));
    const spoil = s.analysis.opportunities.find(o => o.title.startsWith("Track perishable stock"))!;
    expect(spoil.basis).toBe("supported");

    const unk = drive("I own a restaurant and we keep running out of ingredients.", () => "I don't know.");
    const u = analyseTeam(unk.profile, ownerIds(unk));
    expect(u.analysis.opportunities.map(o => o.title)).toEqual(["Measure first: record when each item runs out and when it was reordered"]);
    expect(u.analysis.opportunities[0].basis).toBe("assumed");
    expect(u.team.map(a => a.key)).toEqual(["inventory"]);              // only to measure; nothing else is justified
  });
  test("no keyword-only recommendations: facts alone (WhatsApp orders, suppliers) justify no agent", () => {
    const c = conversation();
    c.say("I run a restaurant called Mama Nkechi's Kitchen. Customers order on WhatsApp and we buy from two suppliers.");
    const { team } = analyseTeam(c.profile, ownerIds(c));
    expect(team).toEqual([]);
  });
});

describe("AC-14 · compatibility and safe, reversible migration", () => {
  const v1 = (): ProfileDoc => {
    const p = emptyProfile();
    const f = (value: string, status: "confirmed" | "assumed") => ({ value, status, sources: ["m1"], updated_by: "consultant" as const, updated_at: "2026-11-05T10:00:00.000Z" });
    p.fields.industry = f("Restaurant / food service", "confirmed");
    p.fields.products_services = f("Jollof rice", "confirmed");
    p.fields.daily_operations = f("We open at 11", "assumed");
    p.fields.challenges = f("We run out of rice", "confirmed");
    p.fields.goals = f("Stop phoning suppliers", "confirmed");
    p.asked = ["goals"]; p.stage = "summary";
    return p;
  };
  test("migration only adds a case file; assumptions stay assumptions; the owner's problem stays their view", () => {
    const before = v1();
    const after = migrateToCaseFile(structuredClone(before));
    expect(revertCaseFileMigration(after)).toEqual(before);          // reversible, exactly
    expect(after.fields).toEqual(before.fields);                      // the stored view is untouched
    const cf = after.case_file!;
    expect(cf.origin).toBe("migrated");
    expect(cf.facts.daily_operations!.status).toBe("assumed");        // never upgraded
    expect(cf.claims.find(c => c.kind === "symptom")).toMatchObject({ text: "We run out of rice", status: "stated" });
    expect(isPreM35Discovery(after)).toBe(true);
    expect(migrateToCaseFile(after)).toBe(after);                     // idempotent
  });
  test("the ten-field view is complete and keeps M2 statuses", () => {
    const after = migrateToCaseFile(v1());
    const view = fieldsView(after.case_file!, after.fields);
    expect(Object.keys(view).sort()).toEqual([...PROFILE_FIELDS].sort());
    for (const k of PROFILE_FIELDS) expect({ k, value: view[k].value, status: view[k].status }).toEqual({ k, value: after.fields[k].value, status: after.fields[k].status });
  });
  test("an unmigrated profile keeps the M2 readiness rule", () => {
    const p = v1();
    p.stage = "discovery";
    expect(discoveryReadiness(p).byBudget).toBe(false);
  });
  test("a new conversation is native, not pre-M3.5", () => {
    const c = conversation();
    c.say(OVERBUY);
    expect(isPreM35Discovery(c.profile)).toBe(false);
  });
});

describe("AC-15 · offline, and the live request is unchanged", () => {
  test("the live discovery schema (sent to models as JSON schema) still has exactly the M2 shape", () => {
    const shape = z.toJSONSchema(DiscoveryTurnSchema) as { properties: Record<string, unknown>; required: string[] };
    expect(Object.keys(shape.properties).sort()).toEqual(["facts", "question_field", "reply", "skipped_fields"]);
  });
});
