import { describe, expect, test } from "vitest";
import { extractFacts, extractFromAnswer, isSkipLike } from "@/lib/rules/extract";
import { nextQuestionField, questionFor } from "@/lib/rules/questions";
import { emptyProfile } from "@/lib/discovery/profile";
import { lowerFirst, normalizeBrands } from "@/lib/text";

const byField = (t: string) => Object.fromEntries(extractFacts(t).map(f => [f.field, f]));

describe("offline extraction", () => {
  test("restaurant: each fact comes from its own clause", () => {
    const f = byField("I run a small restaurant called Mama Nkechi's Kitchen. We take orders at the counter and on WhatsApp, and we often run out of rice and cooking oil because I reorder from suppliers by phone.");
    expect(f.industry.value).toBe("Restaurant / food service");
    expect(f.business_name.value).toBe("Mama Nkechi's Kitchen");
    expect(f.customers_channels.value).toBe("WhatsApp, In person");   // "by phone" belongs to suppliers, not customers
    expect(f.suppliers.value).toBe("I reorder from suppliers by phone");
    expect(f.challenges.value).toBe("we often run out of rice and cooking oil");
  });

  test("salon", () => {
    const f = byField("I own a hair salon in Lekki with 4 stylists. Clients book on Instagram and WhatsApp, and no-shows are killing us. I'd like fewer no-shows and automatic reminders.");
    expect(f.industry.value).toBe("Salon / beauty services");
    expect(f.team_structure.value).toBe("4 stylists");
    expect(f.customers_channels.value).toContain("Instagram");
    expect(f.challenges.value).toMatch(/no-shows/);
    expect(f.goals.value).toMatch(/fewer no-shows/);
  });

  test("retail and services, including accented and compound business words", () => {
    expect(byField("We have a small grocery shop near the market.").industry.value).toBe("Retail");
    expect(byField("I run a café & bar in Ibadan.").industry.value).toBe("Restaurant / food service");
    expect(byField("My barber shop is busy on Saturdays.").industry.value).toBe("Salon / beauty services");
    expect(byField("We are a small accounting firm, I mean an accounting consultancy.").industry.value).toBe("Professional / local services");
    expect(byField("We have a phone repair shop.").industry.value).toBe("Professional / local services");
  });

  test("never invents facts that weren't said", () => {
    const f = byField("I run a restaurant.");
    expect(Object.keys(f)).toEqual(["industry"]);
  });

  test("answer to a question goes to the asked field; 'skip' is a skip", () => {
    expect(extractFromAnswer("Jollof rice and grilled chicken", "products_services").facts).toEqual([{ field: "products_services", value: "Jollof rice and grilled chicken", status: "confirmed" }]);
    expect(extractFromAnswer("Skip this question.", "team_structure")).toEqual({ facts: [], skipped: true });
    expect(isSkipLike("I don't know")).toBe(true);
    expect(isSkipLike("No problem with stock")).toBe(false);
  });
});

describe("question bank", () => {
  test("asks essentials first and never a known or already-asked field", () => {
    const p = emptyProfile();
    p.fields.industry = { value: "Restaurant / food service", status: "confirmed", sources: ["m1"], updated_by: "consultant", updated_at: null };
    p.fields.products_services = { value: "Jollof", status: "confirmed", sources: ["m1"], updated_by: "consultant", updated_at: null };
    expect(nextQuestionField(p)).toBe("customers_channels");
    p.asked = ["customers_channels"];
    expect(nextQuestionField(p)).toBe("challenges");
    p.skipped = ["challenges"];
    expect(nextQuestionField(p)).toBe("goals");
  });

  test("follow-ups refer back to earlier answers", () => {
    const p = emptyProfile();
    p.fields.challenges = { value: "we run out of rice", status: "confirmed", sources: [], updated_by: "consultant", updated_at: null };
    expect(questionFor("suppliers", p)).toContain("we run out of rice");
  });
});

test("products stop where the ordering details begin", () => {
  expect(byField("I run a bakery called Crumbs. We sell bread and cakes at the counter and take cake orders on WhatsApp.").products_services.value).toBe("bread and cakes");
});

describe("review fixes: no introductions in products, one clause per field, brand casing", () => {
  test("an answer that starts with the business name keeps the name out of products", () => {
    const r = extractFromAnswer("It's called Mama Nkechi's Kitchen. We serve rice and other meals.", "products_services");
    const f = Object.fromEntries(r.facts.map(x => [x.field, x.value]));
    expect(f.business_name).toBe("Mama Nkechi's Kitchen");
    expect(f.products_services).toBe("Rice and other meals");
    expect(f.daily_operations).toBeUndefined();     // "we serve" is not a daily routine
  });

  test("the same text as a description: name and products, nothing else invented", () => {
    const f = byField("It's called Mama Nkechi's Kitchen. We serve rice and other meals.");
    expect(f.business_name.value).toBe("Mama Nkechi's Kitchen");
    expect(f.products_services.value).toBe("rice and other meals");
    expect(Object.keys(f).sort()).toEqual(["business_name", "industry", "products_services"]);
  });

  test("a sentence is never copied into two unrelated fields", () => {
    const f = byField("I want to stop running out of ingredients and stop calling suppliers every morning.");
    expect(Object.keys(f)).toEqual(["goals"]);
    const direct = extractFromAnswer("We open at 11 and close at 9. Customers order on whatsapp.", "daily_operations").facts;
    expect(direct.filter(x => x.field === "daily_operations")).toHaveLength(1);
    expect(direct.find(x => x.field === "customers_channels")?.value).toBe("WhatsApp"); // labels are still recognised
    expect(direct.find(x => x.field === "challenges")).toBeUndefined();
  });

  test("brand names keep their official capitalisation", () => {
    expect(byField("Customers order on whatsapp and instagram.").customers_channels.value).toBe("WhatsApp, Instagram");
    expect(extractFromAnswer("a notebook, whatsapp business and quickbooks", "current_tools").facts.find(x => x.field === "current_tools")!.value)
      .toBe("a notebook, WhatsApp Business and QuickBooks");
    expect(normalizeBrands("we use excel, paypal and uber eats")).toBe("we use Excel, PayPal and Uber Eats");
    expect(lowerFirst("WhatsApp and a notebook")).toBe("WhatsApp and a notebook");
    expect(lowerFirst("A notebook and WhatsApp")).toBe("a notebook and WhatsApp");
    expect(lowerFirst("POS / till")).toBe("POS / till");
  });
});

test("a name and a team size in the same clause are both recognised", () => {
  const f = byField("I own a hair salon called Glow Studio with 4 stylists.");
  expect(f.business_name.value).toBe("Glow Studio");
  expect(f.team_structure.value).toBe("4 stylists");
});
