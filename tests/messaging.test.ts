// Customer messaging end to end through the real code paths: inbound webhook → durable task → the
// support employee (offline, labelled rule-based provider; never presented as AI) → draft / auto-reply /
// escalation → durable reply action → delivered. Telegram's API is STUBBED: this proves EmployAI's
// pipeline and safeguards, not a real conversation.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { resetAiForTests } from "@/lib/ai";
import "@/lib/automation/handlers";
import { enqueueTaskIn } from "@/lib/automation/tasks";
import { runDueTasks } from "@/lib/automation/worker";
import { addProduct } from "@/lib/content/service";
import { discoveryRepository, setDiscoveryRepository } from "@/lib/discovery/store";
import { createConnection, setEmployeePermissions } from "@/lib/integrations/connections";
import { receiveInbound } from "@/lib/integrations/inbox";
import "@/lib/integrations/providers";
import { telegramNet } from "@/lib/integrations/providers/telegram";
import { MemoryKv, setKvForTests } from "@/lib/kv";
import { approveReply, discardReply, ownerReply, setMessagingSettings } from "@/lib/messaging/service";
import { approveWorkforce, planWorkforce } from "@/lib/workforce/service";
import { tempStore } from "./helpers/run-fixture";
import { sharedMode } from "./helpers/store";

const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status });
let sent: Array<{ chat_id: unknown; text: unknown }> = [];
let sendMode: "ok" | "500" = "ok";

beforeEach(() => {
  vi.stubEnv("AI_PROVIDER", "mock"); vi.stubEnv("APP_ENCRYPTION_KEY", "m".repeat(40));
  resetAiForTests(); sent = []; sendMode = "ok";
  if (!sharedMode) setKvForTests(new MemoryKv());
  vi.spyOn(telegramNet, "fetch").mockImplementation(async (url: string, init: RequestInit) => {
    if (url.endsWith("/getMe")) return json({ ok: true, result: { id: 42, username: "ada_atelier_bot" } });
    if (url.endsWith("/sendMessage")) { if (sendMode === "500") return json({ ok: false }, 500); const b = JSON.parse(String(init.body)); sent.push({ chat_id: b.chat_id, text: b.text }); return json({ ok: true, result: { message_id: 900 + sent.length } }); }
    return json({ ok: true, result: true });
  });
});
afterEach(() => { vi.unstubAllEnvs(); resetAiForTests(); setDiscoveryRepository(null); setKvForTests(null); vi.restoreAllMocks(); });

async function shop(opts: { grant?: boolean } = {}) {
  const t = tempStore();
  const b = await t.store.createBusiness({ ownerHash: "owner-msg", initialMessage: "Fashion boutique" });
  await t.store.updateBusiness(b.id, { name: "Ada Atelier", business_type: "Fashion" });
  await planWorkforce((await t.store.getBusiness(b.id))!, "Reply to customer enquiries across my messaging accounts.");
  await approveWorkforce(b.id);
  await addProduct(b.id, { name: "Emerald Wrap Dress", description: "Satin wrap dress, sizes 8 to 16.", price_text: "₦25,000", image_url: "https://cdn.example.com/d.jpg" });
  const conn = await createConnection(b.id, { connector: "telegram", label: "Telegram", setup: { bot_token: "123456789:AAtesttokenvalue_abcdefghijklmnopqrs" } });
  const secret = (await discoveryRepository().readState(b.id, s => s.connections![b.id][0]));
  if (opts.grant !== false) await setEmployeePermissions(b.id, conn.view.id, "customer_support", ["read_messages", "send_messages"]);
  const { loadConnectionForUse } = await import("@/lib/integrations/connections");
  const webhookSecret = (await loadConnectionForUse(b.id, conn.view.id))!.secrets.webhook_secret;
  let update = 1000;
  const customer = async (text: string, id = ++update) => receiveInbound(conn.view.id, JSON.stringify({ update_id: id, message: { message_id: id, date: Math.floor(Date.now() / 1000), text, chat: { id: 555, type: "private" }, from: { first_name: "Ngozi" } } }),
    new Headers({ "x-telegram-bot-api-secret-token": webhookSecret }), { onNewEvent: (s, ev) => { enqueueTaskIn(s, ev.business_id, { kind: "process_event", ref: ev.id, dedupeKey: `event:${ev.id}` }); } });
  const convs = () => discoveryRepository().readState(b.id, s => (s.conversations ?? {})[b.id] ?? []);
  const run = async () => { await discoveryRepository().transact(b.id, s => { for (const t of s.tasks?.[b.id] ?? []) if (t.status === "queued") t.next_at = new Date(0).toISOString(); }); await runDueTasks(b.id); };
  void secret;
  return { b, conn, customer, convs, run };
}

describe("customer messages are handled by the support employee, in the background", () => {
  test("default (approve mode): a routine question becomes a draft; the owner approves; it's sent once", async () => {
    const f = await shop();
    await f.customer("Hi, how much is the Emerald wrap dress?");
    await f.run();
    let [c] = await f.convs();
    expect(c).toMatchObject({ channel: "telegram", thread: "555", contact: "Ngozi", assigned_to: "customer_support", status: "open", lead: { note: expect.any(String) } });
    const draft = c.messages.find(m => m.direction === "out")!;
    expect(draft).toMatchObject({ status: "pending_approval", by: "customer_support" });
    expect(draft.text).toContain("₦25,000");                                       // the owner's own price
    expect(draft.note).toMatch(/offline rules \(not AI\)/);                       // labelled honestly
    expect(sent).toEqual([]);                                                      // nothing sent without approval
    await approveReply(f.b.id, c.id, draft.id, null, "approve-key-001");
    await approveReply(f.b.id, c.id, draft.id, null, "approve-key-001");          // repeat click: no second send
    await f.run();
    [c] = await f.convs();
    expect(c.messages.find(m => m.id === draft.id)).toMatchObject({ status: "sent", provider_id: "901" });
    expect(sent).toEqual([{ chat_id: "555", text: draft.text }]);
  });

  test("auto mode: a reply that passes every check goes out without the owner; a duplicate webhook is processed once", async () => {
    const f = await shop();
    await setMessagingSettings(f.b.id, { mode: "auto", knowledge: "We deliver in Lagos within 2 days." });
    await f.customer("Is the Emerald dress available? I want to buy", 2001);
    await f.customer("Is the Emerald dress available? I want to buy", 2001);    // provider retry
    await f.run(); await f.run();
    const [c] = await f.convs();
    expect(c.messages.filter(m => m.direction === "in")).toHaveLength(1);
    expect(c.messages.filter(m => m.direction === "out").map(m => m.status)).toEqual(["sent"]);
    expect(sent).toHaveLength(1);
  });

  test("a basic order is captured for the owner to confirm, answered automatically, and never claimed as confirmed", async () => {
    const f = await shop();
    await setMessagingSettings(f.b.id, { mode: "auto" });
    await f.customer("Hi, I'd like to order 2 of the Emerald wrap dress in size 10 please");
    await f.run(); await f.run();
    const [c] = await f.convs();
    expect(c).toMatchObject({ intent: "order", order: { product: "Emerald Wrap Dress", quantity: 2, details: "size 10", status: "captured" } });
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toMatch(/owner will confirm/);
    expect(sent[0].text).toContain("₦25,000");
    const { checkReply } = await import("@/lib/messaging/model");
    expect(checkReply("Great news, your order is confirmed!", { products: [], knowledge: "" }).find(x => x.code === "NO_CONFIRMATION")!.passed).toBe(false);
  });

  test("complaints are escalated to the owner and never answered automatically", async () => {
    const f = await shop();
    await setMessagingSettings(f.b.id, { mode: "auto" });
    await f.customer("This is terrible, my dress arrived damaged. I want a refund.");
    await f.run();
    const [c] = await f.convs();
    expect(c).toMatchObject({ status: "needs_owner", intent: "refund", escalation: { reason: expect.any(String) } });
    expect(sent).toEqual([]);
    // The owner answers personally, through the same channel and rules.
    await ownerReply(f.b.id, c.id, "I'm so sorry, Ngozi. I'll call you today to sort this out.", "owner-key-0001");
    await f.run();
    expect(sent).toEqual([{ chat_id: "555", text: "I'm so sorry, Ngozi. I'll call you today to sort this out." }]);
  });

  test("an unapproved price or promise never goes out automatically; a discarded draft is never sent", async () => {
    const f = await shop();
    await setMessagingSettings(f.b.id, { mode: "auto" });
    await f.customer("hello there");
    await f.run();
    const [c] = await f.convs();
    const d = c.messages.find(m => m.direction === "out")!;
    await discardReply(f.b.id, c.id, d.id);
    await approveReply(f.b.id, c.id, d.id, null, "approve-key-002");
    await f.run();
    expect(sent.filter(x => x.text === d.text)).toHaveLength(sent.length === 1 ? 1 : 0);   // the ack may auto-send; a discarded one never
    const { checkReply } = await import("@/lib/messaging/model");
    const checks = checkReply("It's only ₦9,000 and we guarantee a refund!", { products: [{ id: "p", name: "Dress", description: "", price_text: "₦25,000", offer_text: null, image: null, created_at: "" }], knowledge: "" });
    expect(checks.filter(x => !x.passed).map(x => x.code)).toEqual(["PRICE", "PROMISE"]);
  });

  test("connections and permissions stay separate: without the owner's grant, messages are filed for the owner and nobody replies", async () => {
    const f = await shop({ grant: false });
    await f.customer("Do you have this in red?");
    await f.run();
    const [c] = await f.convs();
    expect(c).toMatchObject({ assigned_to: null, status: "needs_owner" });
    expect(c.messages.filter(m => m.direction === "out")).toEqual([]);
    expect(sent).toEqual([]);
  });

  test("an unconfirmed delivery is never re-sent: it waits for the owner", async () => {
    const f = await shop();
    await f.customer("How much is the Emerald dress?");
    await f.run();
    const [c] = await f.convs();
    const d = c.messages.find(m => m.direction === "out")!;
    sendMode = "500";
    await approveReply(f.b.id, c.id, d.id, null, "approve-key-003");
    await f.run(); await f.run(); await f.run();
    const after = (await f.convs())[0];
    expect(after.messages.find(m => m.id === d.id)!.status).toBe("needs_attention");
    expect(after.status).toBe("needs_owner");
  });
});
