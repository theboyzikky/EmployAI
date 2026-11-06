// M3.5 · P6 (understanding first): regression introductions and acceptance criteria AC-17 … AC-22, plus the
// revised AC-4, 5, 8, 11 and 13. Offline only: tests/setup.ts blocks fetch.
import { describe, expect, test } from "vitest";
import { discoveryReadiness } from "@/lib/discovery/casefile";
import { caseBasis, groundAnalysis } from "@/lib/discovery/analysis";
import type { ProfileDoc } from "@/lib/discovery/profile";
import { buildUnderstanding } from "@/lib/discovery/understanding";
import { proposeTeam } from "@/lib/catalogue/propose";
import { offlineAnalysis } from "@/lib/rules/analysis";
import { conversation } from "./helpers/converse";
import { RESTAURANT_HERO, referenceAnswer } from "./helpers/reference";

const ISAAC = "Hello, I'm Isaac and I'm into real estate. I want to automate my chat replies to my clients.";
const ADA = "Hi, I'm Ada. I run a bakery in Abuja and I spend hours every evening answering WhatsApp orders.";
const SALON = "I have a small hair salon and clients keep not showing up for appointments.";
const RETAIL = "We have a small grocery shop near the market and we keep running out of rice.";
const CONSULTANCY = "I run an accounting consultancy and I want to automate replies to client questions.";
const MIXED = "Hi, I'm Tunde. I run a restaurant called Bukka Hut with 4 staff. We keep missing WhatsApp orders on busy evenings. I want to automate order taking.";
const DRONES = "I'm into drone mapping for farms and construction sites. Our clients ask about pricing all the time.";

type Asking = ReturnType<typeof buildUnderstanding>["asking"];
const questions = (s: string) => (s.match(/\?/g) ?? []).length;
const drive = (hero: string, answer: (a: Asking) => string, max = 16) => {
  const c = conversation();
  c.say(hero);
  for (let i = 0; i < max && !discoveryReadiness(c.profile).ready; i++) c.say(answer(buildUnderstanding(c.profile).asking));
  return c;
};
const asked = (c: ReturnType<typeof conversation>) => c.log.filter(e => e.turn.plan.kind === "ask").map(e => e.turn.plan.kind === "ask" ? e.turn.plan.text : "");
const team = (p: ProfileDoc, owner: Set<string>) => {
  const a = caseBasis(groundAnalysis(offlineAnalysis(p), p, owner, "offline-demo"), p.case_file!);
  return { analysis: a, team: proposeTeam(a) };
};
const ownerIds = (c: ReturnType<typeof conversation>) => new Set(c.transcript.filter(m => m.role === "user").map(m => m.id));

/** Isaac answering what he's asked, cooperatively. */
const isaacAnswers = (a: Asking) =>
  a?.kind === "gap" && a.target.startsWith("customer_messaging:channel") ? "Mostly WhatsApp."
  : a?.kind === "opening" ? "Mostly the same questions about prices and whether a property is still available."
  : a?.kind === "confirm_cause" ? "Yes, exactly."
  : a?.kind === "gap" && a.target.startsWith("customer_messaging:topics") ? "Yes, that's right."
  : "I'd rather not say.";
const adaAnswers = (a: Asking) =>
  a?.kind === "opening" ? "The back and forth to confirm each order, the address and the payment."
  : a?.kind === "confirm_cause" ? "Yes."
  : a?.kind === "other_problems" ? "No, that's all."
  : a?.kind === "gap" && a.target.startsWith("order_intake:products") ? "Cakes, bread and meat pies."
  : "I'd rather not say.";

describe("AC-17 · one-pass understanding of natural introductions", () => {
  test("Isaac: name, industry, goal, need and a possible solution from one sentence, all cited", () => {
    const c = conversation();
    c.say(ISAAC);
    const cf = c.caseFile;
    expect(cf.owner?.name?.value).toBe("Isaac");
    expect(cf.facts.industry).toMatchObject({ value: "Real estate / property", status: "confirmed", sources: ["m1"] });
    expect(cf.claims).toEqual([expect.objectContaining({ kind: "goal", text: "I want to automate my chat replies to my clients", status: "stated", sources: ["m1"] })]);
    expect(cf.needs).toEqual([expect.objectContaining({ capability: "customer_messaging", label: "Automated customer communication", status: "stated", sources: ["m1"] })]);
    expect(cf.solutions).toEqual([expect.objectContaining({ agent: "Customer Messages Agent", status: "considering" })]);
    expect(cf.facts.business_name).toBeUndefined();                     // "Isaac" is the owner, not the business
    expect(cf.unrecognised).toEqual([]);
  });
  test("Ada: name, business in her words, channel and the problem (time spent on WhatsApp orders)", () => {
    const c = conversation();
    c.say(ADA);
    const cf = c.caseFile;
    expect(cf.owner).toMatchObject({ name: expect.objectContaining({ value: "Ada" }), business: expect.objectContaining({ phrase: "a bakery in Abuja" }) });
    expect(c.profile.fields.industry.value).toBe("Restaurant / food service");
    expect(c.profile.fields.customers_channels.value).toBe("WhatsApp");
    expect(cf.claims).toEqual([expect.objectContaining({ kind: "symptom", text: "I spend hours every evening answering WhatsApp orders" })]);
    expect(cf.problems[0]).toMatchObject({ playbook: "enquiries", resolution: "open" });
    expect(cf.needs).toEqual([expect.objectContaining({ capability: "order_intake", status: "implied" })]);
  });
  test("the reference restaurant: name, industry, channels, supplier routine, problem and the owner's cause", () => {
    const c = conversation();
    c.say(RESTAURANT_HERO);
    const f = c.profile.fields;
    expect([f.business_name.value, f.industry.value, f.customers_channels.value]).toEqual(["Mama Nkechi's Kitchen", "Restaurant / food service", "WhatsApp, In person"]);
    expect(f.suppliers.value).toMatch(/reorder from suppliers by phone/);
    expect(c.caseFile.claims.map(x => `${x.kind}: ${x.text}`)).toEqual(["symptom: we often run out of rice and cooking oil", "cause: I reorder from suppliers by phone"]);
  });
  test.each([
    [SALON, "Salon / beauty services", "no_shows", "clients keep not showing up for appointments"],
    [RETAIL, "Retail", "running_out", "we keep running out of rice"],
  ])("%s → industry and problem in one pass", (hero, industry, playbook, symptom) => {
    const c = conversation();
    c.say(hero);
    expect(c.profile.fields.industry.value).toBe(industry);
    expect(c.caseFile.problems[0].playbook).toBe(playbook);
    expect(c.caseFile.claims[0].text).toBe(symptom);
  });
  test("a consultancy with a goal: professional services, the goal and the messaging need", () => {
    const c = conversation();
    c.say(CONSULTANCY);
    expect(c.profile.fields.industry.value).toBe("Professional / local services");
    expect(c.caseFile.needs?.map(n => `${n.capability}/${n.status}`)).toEqual(["customer_messaging/stated"]);
  });
  test("a message mixing a name, a team, a problem and a goal; then a correction and a new channel", () => {
    const c = conversation();
    c.say(MIXED);
    expect(c.caseFile.owner?.name?.value).toBe("Tunde");
    expect(c.profile.fields.business_name.value).toBe("Bukka Hut");
    expect(c.caseFile.facts.team_size?.value).toBe("4 staff");
    expect(c.caseFile.problems.map(p => p.playbook)).toEqual(["missed_orders"]);   // no duplicate problem for the goal
    expect(c.caseFile.needs?.map(n => `${n.capability}/${n.status}`)).toEqual(["order_intake/stated"]);
    const ex = c.say("Actually it's just me now, and I also use Instagram.");
    expect(c.caseFile.facts.team_size?.value).toBe("Just you (no staff)");
    expect(c.profile.fields.customers_channels.value).toBe("WhatsApp, Instagram");
    expect(ex.reply).toMatch(/Thanks for the correction: team size is now “Just you \(no staff\)”/);
  });
});

describe("AC-18 · shows what it understood before asking, without repeating itself", () => {
  test("Isaac: reflects, suggests tentatively, then asks only the platform", () => {
    const ex = conversation().say(ISAAC);
    expect(ex.reply).toMatch(/^Hi Isaac! You're in real estate, and you'd like to automate your chat replies to your clients\./);
    expect(ex.reply).toMatch(/I'm thinking of a customer messages agent that answers the questions your clients ask most/);
    expect(ex.reply).toMatch(/Which platform do most of your clients message you on\?$/);
    expect(questions(ex.reply)).toBe(1);
  });
  test("Ada: reflects her own words and investigates before suggesting", () => {
    const ex = conversation().say(ADA);
    expect(ex.reply).toMatch(/^Hi Ada! You run a bakery in Abuja, and you spend hours every evening answering WhatsApp orders\./);
    expect(ex.reply).toMatch(/an order agent could take on, but first I'd like to see where the time actually goes/);
    expect(questions(ex.reply)).toBe(1);
  });
  test("later replies acknowledge what's new; the opening summary isn't repeated", () => {
    const c = drive(ISAAC, isaacAnswers);
    for (const ex of c.log.slice(1)) expect(ex.reply).not.toMatch(/You're in real estate|Hi Isaac/);
    expect(c.log[1].reply).toMatch(/^Got it: your clients reach you on WhatsApp\./);
  });
});

describe("AC-19 · inferences kept apart from facts, and the two kinds kept apart from each other", () => {
  test("Isaac: implied inferences are unconfirmed; typical knowledge never fills a field; nothing invented", () => {
    const c = conversation();
    c.say(ISAAC);
    const f = c.profile.fields;
    expect(f.customers_channels).toMatchObject({ value: "Messages / chat (platform not stated)", status: "assumed" });
    expect(f.products_services.status).toBe("assumed");
    const inf = c.caseFile.inferences!;
    expect(inf.find(i => i.key === "typical_topics")).toMatchObject({ kind: "typical", slot: null, value: null, status: "inferred" });
    expect(inf.every(i => i.kind === "typical" ? i.slot === null : true)).toBe(true);
    // Never inferred: platforms, quantities, team size, names.
    for (const i of inf) expect(`${i.statement} ${i.value ?? ""}`).not.toMatch(/WhatsApp|Instagram|Facebook|\d|staff|agents?\b/);
    expect(f.team_structure.value).toBeNull();
    // The panel shows them apart.
    const u = buildUnderstanding(c.profile);
    expect(u.inferences.filter(i => i.kind === "implied").length).toBe(2);
    expect(u.inferences.filter(i => i.kind === "typical").map(i => i.reason)).toEqual(["General knowledge about real estate, not something you told me"]);
  });
  test("an inference is confirmed only by the owner's words, and can be rejected", () => {
    const c = conversation();
    c.say(ISAAC);
    c.say("Mostly WhatsApp.");
    expect(c.caseFile.inferences!.find(i => i.key === "channel_messages")!.status).toBe("confirmed");
    expect(c.profile.fields.customers_channels).toMatchObject({ value: "WhatsApp", status: "confirmed" });
    const r = drive(ISAAC, a => a?.kind === "gap" && a.target.startsWith("customer_messaging:topics") ? "No, mostly about payment plans and mortgages."
      : a?.kind === "opening" ? "Mostly the same questions, again and again." : isaacAnswers(a));
    expect(r.caseFile.inferences!.find(i => i.key === "typical_topics")!.status).toBe("rejected");
    expect(r.caseFile.gap_answers!["customer_messaging:topics"].text).toBe("mostly about payment plans and mortgages");
  });
  test("found in the browser check: when the owner already said what clients ask, that question isn't asked; the typical view stays typical", () => {
    const c = drive(ISAAC, isaacAnswers);       // his opening answer mentions prices and availability
    expect(asked(c).some(q => /usually ask about/.test(q))).toBe(false);
    expect(c.caseFile.questions_asked).toBe(3);
    expect(c.caseFile.inferences!.find(i => i.key === "typical_topics")!.status).toBe("inferred");   // never upgraded to a fact
    expect(buildUnderstanding(c.profile).inferences.find(i => i.kind === "typical")!.ownerWords).toBe("Mostly the same questions about prices and whether a property is still available");
  });
});

describe("AC-20 · needs and possible solutions: considered, never committed, can be dropped", () => {
  test("Isaac: the need and a Preview agent being considered, linked to the need", () => {
    const c = conversation();
    c.say(ISAAC);
    expect(buildUnderstanding(c.profile).solutions).toEqual([{ agent: "Customer Messages Agent", for: "Automated customer communication", preview: true }]);
  });
  test("a later answer drops it", () => {
    const c = conversation();
    c.say(ISAAC);
    const ex = c.say("Actually, I don't want a bot replying to my clients.");
    expect(c.caseFile.needs![0].status).toBe("rejected");
    expect(c.caseFile.solutions![0].status).toBe("dropped");
    expect(buildUnderstanding(c.profile).solutions).toEqual([]);
    expect(ex.reply).toMatch(/Understood, I won't suggest a customer messages agent/);
  });
});

describe("AC-21 · understanding updates on every message, whatever was asked", () => {
  test("volunteered evidence about the problem is used straight away", () => {
    const c = conversation();
    c.say(ISAAC);
    c.say("Mostly WhatsApp, and a lot of messages come in late at night.");
    expect(c.caseFile.problems[0].hypotheses.find(h => h.key === "after_hours")!.status).toBe("supported");
    expect(c.profile.fields.customers_channels.value).toBe("WhatsApp");
  });
  test("a changed goal replaces the old one in the view, and is said back", () => {
    const c = conversation();
    c.say(ISAAC);
    const ex = c.say("Actually, what I really want is to stop losing leads at night.");
    expect(buildUnderstanding(c.profile).goals).toEqual(["what I really want is to stop losing leads at night"]);
    expect(c.profile.fields.goals.value).toMatch(/stop losing leads at night/);
    expect(c.profile.fields.goals.value).not.toMatch(/automate my chat replies/);
    expect(ex.reply).toMatch(/Got it: what you really want is to stop losing leads at night. I.ll work from that instead/);
  });
});

describe("AC-22 · unfamiliar input is kept, not lost", () => {
  test("a business outside the vocabulary is kept in the owner's words; an unclear sentence is kept verbatim and clarified", () => {
    const c = conversation();
    const ex = c.say(DRONES);
    expect(c.profile.fields.industry.value).toBe("Drone mapping for farms and construction sites");   // not "Construction / trades"
    expect(c.caseFile.unrecognised!.map(u => u.text)).toEqual(["Our clients ask about pricing all the time"]);
    expect(ex.reply).toMatch(/kept a note of it as you said it: “Our clients ask about pricing all the time”/);
    // Asked about later, and the owner's explanation is stored with it.
    const d = drive(DRONES, a => a?.kind === "clarify" ? "They want a quote before every job, and I write each one by hand." : "I'd rather not say.");
    const clar = d.caseFile.agenda.find(a => a.kind === "clarify");
    expect(clar).toBeDefined();
    expect(d.caseFile.unrecognised![0]).toMatchObject({ status: "clarified", clarification: "They want a quote before every job, and I write each one by hand" });
  });
  test("nothing the owner said is silently dropped: every sentence is understood or kept", () => {
    const c = conversation();
    c.say("Hello. I run a small print shop. We print banners and flyers. Our biggest headache is the generator.");
    const kept = c.caseFile.unrecognised!.map(u => u.text);
    expect(kept).toContain("Our biggest headache is the generator");
  });
  test("found in the demo: an unrecognised problem keeps its whole sentence, not a fragment", () => {
    const c = conversation();
    c.say(DRONES);
    c.say("Quotes. Everyone wants a quote before a job and I write each one by hand.");
    expect(c.caseFile.claims.filter(x => x.kind === "symptom").map(x => x.text)).toEqual(["Everyone wants a quote before a job and I write each one by hand"]);
  });
});

describe("AC-4, AC-5 · one question chosen by materiality; never asks what's stated or inferable", () => {
  const FORBIDDEN: Array<[string, (a: Asking) => string, RegExp]> = [
    [ISAAC, isaacAnswers, /what kind of business|what does the business (?:sell|do)|what do you sell|main things customers buy|what's on the menu|your name|how many people/i],
    [ADA, adaAnswers, /what kind of business|how do (?:customers|most customers) (?:order|place)|what platform|your name/i],
    [RESTAURANT_HERO, referenceAnswer, /what kind of business|what's the restaurant called|how do customers order/i],
  ];
  for (const [hero, answer, forbidden] of FORBIDDEN) {
    test(`${hero.slice(0, 40)}…: one question per turn, each with a purpose, none forbidden`, () => {
      const c = drive(hero, answer);
      for (const q of asked(c)) expect(q).not.toMatch(forbidden);
      for (const ex of c.log) if (ex.turn.plan.kind === "ask") expect(questions(ex.reply)).toBe(1);
      expect(c.caseFile.agenda.every(a => a.asked <= 2)).toBe(true);
    });
  }
  test("Isaac's first question is the platform (the detail that changes the solution most)", () => {
    const ex = conversation().say(ISAAC);
    expect(ex.turn.plan.kind === "ask" && ex.turn.plan.item.key).toBe("gap:customer_messaging:channel");
  });
});

describe("AC-8 (revised) · the problem behind a goal is investigated", () => {
  test("Isaac's goal: why he wants it is asked, a cause is confirmed by him, the summary says so", () => {
    const c = drive(ISAAC, isaacAnswers);
    const p = c.caseFile.problems[0];
    expect(p).toMatchObject({ playbook: "enquiries", from_goal: true, resolution: "cause_confirmed" });
    expect(p.hypotheses.find(h => h.key === "repetitive")!.status).toBe("confirmed");
    expect(c.log.at(-1)!.reply).toMatch(/Behind “I want to automate my chat replies to my clients”: most messages are the same routine questions, as you confirmed/);
  });
  test("if he can't say why, it stays unknown, and his request is still honoured honestly", () => {
    const c = drive(ISAAC, a => a?.kind === "gap" && a.target.startsWith("customer_messaging:channel") ? "WhatsApp." : "I don't know.");
    expect(c.caseFile.problems[0].resolution).toBe("unknown");
    const { analysis } = team(c.profile, ownerIds(c));
    expect(analysis.opportunities.map(o => o.title)).toEqual(["Automated customer communication, as you asked"]);
    expect(analysis.opportunities[0].detail).toMatch(/What's behind it is still unknown/);
  });
});

describe("AC-11 (revised) · ready by need, in 5 questions or fewer for goal-led introductions", () => {
  test.each([[ISAAC, isaacAnswers], [ADA, adaAnswers], [CONSULTANCY, isaacAnswers]])("%s", (hero, answer) => {
    const c = drive(hero, answer as (a: Asking) => string);
    expect(discoveryReadiness(c.profile)).toMatchObject({ ready: true, byBudget: false });
    expect(c.caseFile.questions_asked).toBeLessThanOrEqual(5);
    expect(c.log.at(-1)!.reply).toMatch(/I think I have a clear enough picture/);
  });
  test("products aren't required when the business makes them clear (real estate), but are asked when they matter (an order agent)", () => {
    const isaac = drive(ISAAC, isaacAnswers);
    expect(asked(isaac).some(q => /sell|menu|products/i.test(q))).toBe(false);
    expect(isaac.profile.fields.products_services.status).toBe("assumed");
    const ada = drive(ADA, adaAnswers);
    expect(asked(ada).some(q => /What are the main things you sell/.test(q))).toBe(true);
  });
  test("the reference restaurant still reaches readiness without the budget", () => {
    const c = drive(RESTAURANT_HERO, referenceAnswer);
    expect(discoveryReadiness(c.profile)).toMatchObject({ ready: true, byBudget: false });
    expect(c.caseFile.questions_asked).toBeLessThanOrEqual(10);
  });
});

describe("AC-13 (revised) · agents traceable to a stated need or a confirmed cause", () => {
  test("Isaac → only the Customer Messages Agent (Preview), justified by his goal and the confirmed reason", () => {
    const c = drive(ISAAC, isaacAnswers);
    const { analysis, team: t } = team(c.profile, ownerIds(c));
    expect(t.map(a => a.key)).toEqual(["messaging"]);
    expect(t[0].executable).toBe(false);                                // Preview: only the restaurant is runnable
    expect(t[0].definition.reasons[0].detail).toMatch(/^Serves your goal “I want to automate my chat replies to my clients”; the reason behind it, as you confirmed, is that most messages are the same routine questions/);
    expect(analysis.bottlenecks.map(b => b.title)).toEqual(["Most messages are the same routine questions", "Messages arrive when no one is free to reply"].slice(0, analysis.bottlenecks.length));
  });
  test("Ada → only the Order Agent, traced to her problem and the cause she confirmed", () => {
    const c = drive(ADA, adaAnswers);
    const { team: t } = team(c.profile, ownerIds(c));
    expect(t.map(a => a.key)).toEqual(["order"]);
    expect(t[0].definition.reasons[0].detail).toMatch(/^Addresses “I spend hours every evening answering WhatsApp orders”, caused, as you confirmed, by: each one takes a lot of back and forth to settle/);
  });
  test("an inference alone never justifies an agent", () => {
    const c = conversation();
    c.say("Hello, I'm Isaac and I'm into real estate.");
    expect(c.caseFile.solutions).toEqual([]);
    expect(team(c.profile, ownerIds(c)).team).toEqual([]);
  });
});
