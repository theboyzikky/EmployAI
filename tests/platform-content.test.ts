// The platform's first operational vertical, end to end through the real code paths: workforce planning
// for different businesses, the fashion content pipeline, approval, scheduling, the background worker and
// the Instagram connector. AI is the labelled OFFLINE provider and Instagram's API is STUBBED here — these
// tests prove the code path and its safeguards, not a real publication (that is the external acceptance
// test, run with the owner's real account).
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { resetAiForTests } from "@/lib/ai";
import "@/lib/automation/handlers";
import { runDueTasks } from "@/lib/automation/worker";
import { addProduct, approveAndSchedule, cancelScheduled, draftCaption, editCaption, planContent } from "@/lib/content/service";
import { validateCaption } from "@/lib/content/model";
import { discoveryRepository, setDiscoveryRepository } from "@/lib/discovery/store";
import { createConnection } from "@/lib/integrations/connections";
import "@/lib/integrations/providers";
import { instagramNet } from "@/lib/integrations/providers/instagram";
import { MemoryKv, setKvForTests } from "@/lib/kv";
import { setKillSwitch } from "@/lib/runs/runner";
import { buildWorkforce, offlineWorkforceProposal } from "@/lib/workforce/plan";
import { approveWorkforce, planWorkforce, setEmployeeStatus } from "@/lib/workforce/service";
import { tempStore } from "./helpers/run-fixture";
import { sharedMode } from "./helpers/store";

const IMG = "https://cdn.example.com/dress-ankara.jpg";
let calls: string[] = [];
let publishMode: "ok" | "timeout" = "ok";
let alreadyLive: string | null = null;

function stubInstagram() {
  calls = [];
  vi.spyOn(instagramNet, "sleep").mockResolvedValue(undefined);
  vi.spyOn(instagramNet, "fetch").mockImplementation(async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname.replace(/^\/v\d+\.\d+/, "");
    calls.push(`${init.method} ${path}`);
    const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status });
    if (path === "/me") return json({ user_id: "17841400000000001", username: "adaeze.styles", account_type: "BUSINESS" });
    if (path.endsWith("/media") && init.method === "POST") return json({ id: "container-1" });
    if (path === "/container-1") return json({ status_code: "FINISHED" });
    if (path.endsWith("/media_publish")) { if (publishMode === "timeout") throw new Error("timeout"); return json({ id: "18000000000000001" }); }
    if (path === "/18000000000000001") return json({ permalink: "https://www.instagram.com/p/REALLOOKING/", timestamp: "2026-11-11T12:00:00+0000" });
    if (path.endsWith("/media") && init.method === "GET") return json({ data: alreadyLive ? [{ id: "18000000000000009", caption: alreadyLive, permalink: "https://www.instagram.com/p/FOUND/" }] : [] });
    return json({ error: { message: "unexpected" } }, 400);
  });
}

beforeEach(() => { vi.stubEnv("AI_PROVIDER", "mock"); vi.stubEnv("APP_ENCRYPTION_KEY", "f".repeat(40)); resetAiForTests(); publishMode = "ok"; alreadyLive = null; if (!sharedMode) setKvForTests(new MemoryKv()); });
afterEach(() => { vi.unstubAllEnvs(); resetAiForTests(); setDiscoveryRepository(null); setKvForTests(null); vi.restoreAllMocks(); });

describe("workforce planning is driven by the owner's goals, not a fixed list", () => {
  const plan = (request: string, industry: string | null = null) => buildWorkforce(offlineWorkforceProposal({ request, profile: { industry } }), { request, plannedBy: { provider: "mock", model: "offline", mode: "offline-demo" } });

  test("fashion / social media → Content Creator + Social Media Manager (+ analyst, orchestrator); publishing needs approval", () => {
    const w = plan("I sell dresses. I want my social media updated consistently to attract more customers.", "Fashion");
    expect(w.employees.map(e => e.template)).toEqual(["orchestrator", "content_creator", "social_media_manager", "marketing_analyst"]);
    const smm = w.employees.find(e => e.template === "social_media_manager")!;
    expect(smm.skills.find(s => s.id === "publish_social_post")).toMatchObject({ status: "operational", autonomy: "approval" });
    expect(smm.integrations.map(i => i.capability)).toContain("publish_social_post");
    expect(smm.integrations.find(i => i.capability === "publish_social_post")!.providers.filter(p => p.status === "available").map(p => p.name)).toEqual(["Instagram", "Facebook Pages"]);
    expect(w.approvals.some(a => a.includes("Publish approved posts"))).toBe(true);
  });

  test("restaurant → orders, stock, suppliers, payments; real estate → support and sales — the same planner", () => {
    expect(plan("I run a restaurant and want orders processed, stock monitored and suppliers contacted and paid.").employees.map(e => e.template)).toEqual(["orchestrator", "order_manager", "inventory_manager", "procurement_agent", "finance_agent"]);
    expect(plan("I sell property. I want enquiries handled and leads followed up for viewings.").employees.map(e => e.template)).toEqual(["customer_support", "sales_agent"]);
  });

  test("AI proposals are validated: invented skills are dropped; custom employees composed of real skills are allowed", () => {
    const w = buildWorkforce({ summary: "x", objectives: ["y"], employees: [
      { template: null, name: "Launch Coordinator", title: "Runs product launches", skills: ["plan_content", "draft_caption", "transfer_all_funds"], responsibilities: [], reason: "launches" },
      { template: null, name: "Ghost", title: "Does nothing real", skills: ["hack_competitors"], responsibilities: [], reason: "" },
    ] }, { request: "", plannedBy: { provider: "nearai", model: "m", mode: "live" } });
    expect(w.employees.map(e => [e.id, e.skills.map(s => s.id)])).toEqual([["launch_coordinator", ["plan_content", "draft_caption"]]]);
  });
});

describe("caption rules (deterministic)", () => {
  const product = { id: "p", name: "Ankara Wrap Dress", description: "", price_text: "₦45,000", offer_text: null, image: null, created_at: "" };
  test("invented prices, offers, claims and links fail; the owner's exact price passes", () => {
    const ok = validateCaption({ caption: "The Ankara Wrap Dress is here. ₦45,000. Message us to order.", hashtags: ["#ankara"] }, product);
    expect(ok.every(c => c.passed)).toBe(true);
    const bad = validateCaption({ caption: "Ankara Wrap Dress now ₦30,000! 20% off, guaranteed best in Nigeria. Shop www.shop.com", hashtags: ["#a b"] }, product);
    expect(bad.filter(c => !c.passed).map(c => c.code).sort()).toEqual(["CLAIMS", "HASHTAG_FORMAT", "NO_LINKS", "OFFER", "PRICE"]);
    expect(validateCaption({ caption: "Lovely dress, ₦45,000", hashtags: [] }, { ...product, price_text: null }).find(c => c.code === "PRICE")!.passed).toBe(false);
  });
});

describe("fashion vertical: plan → draft → approve → scheduled publish by the background worker → verified", () => {
  async function fashion() {
    stubInstagram();
    const t = tempStore();
    const b = await t.store.createBusiness({ ownerHash: "owner-fashion", initialMessage: "I sell dresses and want my social media handled." });
    await t.store.updateBusiness(b.id, { name: "Adaeze Styles", business_type: "Fashion" });
    const planned = await planWorkforce((await t.store.getBusiness(b.id))!, "I sell dresses. I want my social media updated consistently to attract customers.");
    expect("workforce" in planned && planned.workforce.planned_by.mode).toBe("offline-demo");   // labelled, never passed off as live AI
    await approveWorkforce(b.id);
    const conn = await createConnection(b.id, { connector: "instagram", label: "Instagram", setup: { access_token: "IGAAtest_token_value_0123456789" }, grants: [{ agent: "social_media_manager", actions: ["instagram.publish_image"] }] });
    expect(conn.view.config).toMatchObject({ ig_user_id: "17841400000000001", username: "adaeze.styles" });
    expect(JSON.stringify(conn.view)).not.toContain("IGAAtest_token_value");
    await addProduct(b.id, { name: "Ankara Wrap Dress", description: "A hand-cut Ankara wrap dress in sizes 8–16.", price_text: "₦45,000", image_url: IMG });
    const biz = async () => (await t.store.getBusiness(b.id))!;
    expect(await planContent(await biz(), 3)).toMatchObject({ created: expect.any(Number) });
    const items = async () => discoveryRepository().readState(b.id, s => (s.content_items ?? {})[b.id] ?? []);
    const first = (await items())[0];
    const d = await draftCaption(await biz(), first.id);
    expect("item" in d && d.item.status).toBe("draft");
    return { b, t, biz, items, itemId: first.id };
  }
  const due = async (bid: string) => { await discoveryRepository().transact(bid, s => { for (const a of (s.action_attempts ?? {})[bid] ?? []) a.retry_at = null; for (const t of (s.tasks ?? {})[bid] ?? []) if (t.status === "queued") t.next_at = new Date(0).toISOString(); }); };

  test("nothing is published before the scheduled time; at the time the worker publishes once and records the real media id and permalink", async () => {
    const f = await fashion();
    const scheduled = await approveAndSchedule(await f.biz(), f.itemId, new Date(Date.now() + 3_600_000).toISOString(), "approve-key-1");
    expect(scheduled.status).toBe("scheduled");
    await runDueTasks(f.b.id);                                          // too early
    expect(calls.filter(c => c.includes("media_publish"))).toEqual([]);
    await due(f.b.id);
    await runDueTasks(f.b.id);
    const done = (await f.items()).find(i => i.id === f.itemId)!;
    expect(done).toMatchObject({ status: "published", media_id: "18000000000000001", permalink: "https://www.instagram.com/p/REALLOOKING/" });
    expect(calls.filter(c => c.includes("media_publish"))).toHaveLength(1);
    const events = await discoveryRepository().readState(f.b.id, s => (s.activity_events ?? {})[f.b.id]!.map(e => e.type));
    expect(events).toEqual(expect.arrayContaining(["workforce.planned", "workforce.approved", "connection.created", "product.added", "content.planned", "content.drafted", "content.approved", "action.sending", "action.done", "content.published"]));
    // The same approval click again: no second action.
    await expect(approveAndSchedule(await f.biz(), f.itemId, new Date(Date.now() + 3_600_000).toISOString(), "approve-key-1")).resolves.toMatchObject({ status: "published" });
  });

  test("cancelled, edited, paused or kill-switched before the time: nothing is published", async () => {
    const f = await fashion();
    await approveAndSchedule(await f.biz(), f.itemId, new Date(Date.now() + 3_600_000).toISOString(), "approve-key-2");
    await cancelScheduled(f.b.id, f.itemId);
    await due(f.b.id); await runDueTasks(f.b.id);
    expect(calls.filter(c => c.includes("/media"))).toEqual([]);
    expect((await f.items()).find(i => i.id === f.itemId)!.status).toBe("draft");

    await approveAndSchedule(await f.biz(), f.itemId, new Date(Date.now() + 3_600_000).toISOString(), "approve-key-3");
    await setEmployeeStatus(f.b.id, "social_media_manager", "paused");
    await due(f.b.id); await runDueTasks(f.b.id);
    expect(calls.filter(c => c.includes("/media"))).toEqual([]);
    expect((await f.items()).find(i => i.id === f.itemId)!.status).toBe("failed");

    const g = await fashion();
    await approveAndSchedule(await g.biz(), g.itemId, new Date(Date.now() + 3_600_000).toISOString(), "approve-key-4");
    await setKillSwitch(g.b.id, true);
    await due(g.b.id); await runDueTasks(g.b.id);
    expect(calls.filter(c => c.includes("media_publish"))).toEqual([]);
  });

  test("only a draft that passes every check can be approved; an owner edit is re-checked", async () => {
    const f = await fashion();
    await editCaption(await f.biz(), f.itemId, "Ankara Wrap Dress — now only ₦20,000, guaranteed!", ["#ankara"]);
    await expect(approveAndSchedule(await f.biz(), f.itemId, new Date(Date.now() + 3_600_000).toISOString(), "approve-key-5")).rejects.toMatchObject({ code: "STATE_CONFLICT" });
    expect(calls.filter(c => c.includes("/media"))).toEqual([]);
  });

  test("Instagram doesn't confirm the publication: never re-published blindly; found by reconciliation, or escalated", async () => {
    const f = await fashion();
    await approveAndSchedule(await f.biz(), f.itemId, new Date(Date.now() + 3_600_000).toISOString(), "approve-key-6");
    publishMode = "timeout";
    await due(f.b.id); await runDueTasks(f.b.id);
    expect((await f.items()).find(i => i.id === f.itemId)!.status).toBe("publishing");
    alreadyLive = (await discoveryRepository().readState(f.b.id, s => (s.action_attempts ?? {})[f.b.id]![0].input.caption)) as string;
    await due(f.b.id); await runDueTasks(f.b.id);
    expect((await f.items()).find(i => i.id === f.itemId)!).toMatchObject({ status: "published", media_id: "18000000000000009", permalink: "https://www.instagram.com/p/FOUND/" });
    expect(calls.filter(c => c.includes("media_publish"))).toHaveLength(1);       // never a second publish
  });
});
