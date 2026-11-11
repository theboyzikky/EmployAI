// Meta messaging (Instagram DMs, Messenger, WhatsApp) through the real code paths, with Meta's Graph API
// STUBBED: webhook handshake and signature, routing to the owning business only, the support employee,
// replies on the right endpoint, Embedded Signup verification, and the 24-hour window. Not a real account.
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { resetAiForTests } from "@/lib/ai";
import "@/lib/automation/handlers";
import { enqueueTaskIn } from "@/lib/automation/tasks";
import { runDueTasks } from "@/lib/automation/worker";
import { discoveryRepository, setDiscoveryRepository } from "@/lib/discovery/store";
import { createConnection, setEmployeePermissions } from "@/lib/integrations/connections";
import { deliverToRouteKey } from "@/lib/integrations/inbox";
import { metaSignatureOk, parseMetaNotification, verifyMetaHandshake } from "@/lib/integrations/meta-webhook";
import "@/lib/integrations/providers";
import { metaNet } from "@/lib/integrations/providers/meta-messaging";
import { MemoryKv, setKvForTests } from "@/lib/kv";
import { approveReply } from "@/lib/messaging/service";
import { approveWorkforce, planWorkforce } from "@/lib/workforce/service";
import { tempStore } from "./helpers/run-fixture";
import { sharedMode } from "./helpers/store";

const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status });
let posts: Array<{ url: string; body: unknown }> = [];
let grantedWaba = "102290129340398";

beforeEach(() => {
  vi.stubEnv("AI_PROVIDER", "mock"); vi.stubEnv("APP_ENCRYPTION_KEY", "q".repeat(40));
  vi.stubEnv("FACEBOOK_APP_ID", "fb-app"); vi.stubEnv("FACEBOOK_APP_SECRET", "fb-secret"); vi.stubEnv("INSTAGRAM_APP_SECRET", "ig-secret"); vi.stubEnv("META_WEBHOOK_VERIFY_TOKEN", "verify-me-123");
  resetAiForTests(); posts = []; grantedWaba = "102290129340398";
  if (!sharedMode) setKvForTests(new MemoryKv());
  vi.spyOn(metaNet, "fetch").mockImplementation(async (url: string, init: RequestInit) => {
    const u = new URL(url);
    if (init.method === "POST") posts.push({ url: u.origin + u.pathname + (u.search ? u.search : ""), body: init.body ? JSON.parse(String(init.body)) : null });
    if (u.pathname.endsWith("/me") && u.host === "graph.instagram.com") return json({ user_id: "17841400000000777", username: "ada.atelier" });
    if (u.pathname.endsWith("/subscribed_apps")) return json({ success: true });
    if (u.pathname.endsWith("/messages") && u.host === "graph.instagram.com") return json({ recipient_id: "IGSID-1", message_id: "aWdfZAG1-ig-reply" });
    if (u.pathname.endsWith("/oauth/access_token")) return json({ access_token: "EAAbusiness" });
    if (u.pathname.endsWith("/debug_token")) return json({ data: { granular_scopes: [{ scope: "whatsapp_business_management", target_ids: [grantedWaba] }, { scope: "whatsapp_business_messaging", target_ids: [grantedWaba] }] } });
    if (u.pathname.endsWith("/phone_numbers")) return json({ data: [{ id: "106540352242922", display_phone_number: "+234 800 000 0000", verified_name: "Ada Atelier" }] });
    if (u.pathname.endsWith("/106540352242922/messages")) return json({ messaging_product: "whatsapp", messages: [{ id: "wamid.REPLY1" }] });
    return json({ error: { message: "unexpected", code: 100 } }, 400);
  });
});
afterEach(() => { vi.unstubAllEnvs(); resetAiForTests(); setDiscoveryRepository(null); setKvForTests(null); vi.restoreAllMocks(); });

const sign = (body: string, secret: string) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
const enqueue = (s: Parameters<NonNullable<Parameters<typeof deliverToRouteKey>[2]>>[0], ev: { business_id: string; id: string }) => { enqueueTaskIn(s, ev.business_id, { kind: "process_event", ref: ev.id, dedupeKey: `event:${ev.id}` }); };
async function workspace(store = tempStore(), owner = "owner-meta") {
  const b = await store.store.createBusiness({ ownerHash: owner, initialMessage: "Boutique" });
  await planWorkforce((await store.store.getBusiness(b.id))!, "Reply to customer enquiries on Instagram and WhatsApp.");
  await approveWorkforce(b.id);
  const due = async () => { await discoveryRepository().transact(b.id, s => { for (const t of s.tasks?.[b.id] ?? []) if (t.status === "queued") t.next_at = new Date(0).toISOString(); }); await runDueTasks(b.id); };
  return { b, store, due, convs: () => discoveryRepository().readState(b.id, s => s.conversations?.[b.id] ?? []) };
}

describe("Meta's webhook: verified, and routed only to the business that owns the account", () => {
  test("handshake needs the verify token; notifications need a valid signature from a Meta app secret", () => {
    expect(verifyMetaHandshake(new URLSearchParams({ "hub.mode": "subscribe", "hub.verify_token": "verify-me-123", "hub.challenge": "1158201444" }))).toBe("1158201444");
    expect(verifyMetaHandshake(new URLSearchParams({ "hub.mode": "subscribe", "hub.verify_token": "nope", "hub.challenge": "1" }))).toBeNull();
    const body = JSON.stringify({ object: "instagram", entry: [] });
    expect(metaSignatureOk(body, sign(body, "ig-secret"))).toBe(true);
    expect(metaSignatureOk(body, sign(body, "fb-secret"))).toBe(true);
    expect(metaSignatureOk(body, sign(body, "attacker"))).toBe(false);
    expect(metaSignatureOk(body, null)).toBe(false);
  });

  test("Instagram DM: connected account subscribed; a customer DM is answered on Instagram; echoes and unknown accounts are ignored", async () => {
    const f = await workspace();
    const c = await createConnection(f.b.id, { connector: "instagram_dm", label: "Instagram Direct Messages", setup: { oauth: { access_token: "IGAAtoken" } }, auth: { method: "oauth", account: null, scopes: ["instagram_business_manage_messages"], expires_at: null, refreshable: true } });
    expect(posts.some(p => p.url.includes("/17841400000000777/subscribed_apps?subscribed_fields=messages"))).toBe(true);
    await setEmployeePermissions(f.b.id, c.view.id, "customer_support", ["read_messages", "send_messages"]);
    const note = { object: "instagram", entry: [{ id: "17841400000000777", time: Date.now(), messaging: [
      { sender: { id: "IGSID-1" }, recipient: { id: "17841400000000777" }, timestamp: Date.now(), message: { mid: "m_1", text: "Hi! Do you ship to Abuja?" } },
      { sender: { id: "17841400000000777" }, recipient: { id: "IGSID-1" }, timestamp: Date.now(), message: { mid: "m_echo", text: "our own reply", is_echo: true } },
    ] }, { id: "999999", messaging: [{ sender: { id: "X" }, message: { mid: "m_other", text: "not ours" } }] }] };
    const groups = parseMetaNotification(note);
    expect([...groups.keys()]).toEqual(["meta:ig:17841400000000777", "meta:ig:999999"]);
    for (const [key, events] of groups) await deliverToRouteKey(key, events, enqueue);
    await deliverToRouteKey("meta:ig:17841400000000777", groups.get("meta:ig:17841400000000777")!, enqueue);   // Meta retry
    await f.due();
    const [conv] = await f.convs();
    expect(conv).toMatchObject({ channel: "instagram", thread: "IGSID-1" });
    expect(conv.messages.filter(m => m.direction === "in").map(m => m.text)).toEqual(["Hi! Do you ship to Abuja?"]);
    const draft = conv.messages.find(m => m.direction === "out")!;
    await approveReply(f.b.id, conv.id, draft.id, "Yes, we deliver to Abuja in 3 to 5 days.", "approve-ig-0001");
    await f.due();
    expect(posts.filter(p => p.url.endsWith("/17841400000000777/messages")).map(p => p.body)).toEqual([{ recipient: { id: "IGSID-1" }, message: { text: "Yes, we deliver to Abuja in 3 to 5 days." } }]);
    expect((await f.convs())[0].messages.find(m => m.id === draft.id)).toMatchObject({ status: "sent", provider_id: "aWdfZAG1-ig-reply" });
  });

  test("WhatsApp Embedded Signup: the account must really be granted to EmployAI; then messages are answered within the 24-hour window", async () => {
    const f = await workspace();
    grantedWaba = "555";                                                         // Meta granted a different account
    await expect(createConnection(f.b.id, { connector: "whatsapp", label: "WhatsApp Business", setup: { signup: { code: "AQBcode-1234567890", waba_id: "102290129340398", phone_number_id: "106540352242922" } } })).rejects.toThrow(/didn't grant EmployAI access/);
    grantedWaba = "102290129340398";
    const c = await createConnection(f.b.id, { connector: "whatsapp", label: "WhatsApp Business", setup: { signup: { code: "AQBcode-1234567890", waba_id: "102290129340398", phone_number_id: "106540352242922" } } });
    expect(c.view.config).toMatchObject({ waba_id: "102290129340398", phone_number_id: "106540352242922", username: "+234 800 000 0000" });
    expect(posts.some(p => p.url.endsWith("/102290129340398/subscribed_apps"))).toBe(true);
    expect(JSON.stringify(c.view)).not.toContain("EAAbusiness");
    await setEmployeePermissions(f.b.id, c.view.id, "customer_support", ["read_messages", "send_messages"]);
    const wa = { object: "whatsapp_business_account", entry: [{ id: "102290129340398", changes: [{ field: "messages", value: { metadata: { phone_number_id: "106540352242922" }, contacts: [{ wa_id: "2348011112222", profile: { name: "Chioma" } }],
      messages: [{ id: "wamid.IN1", from: "2348011112222", timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: "Good morning, is the wrap dress available in size 10?" } }] } }] }] };
    for (const [key, events] of parseMetaNotification(wa)) await deliverToRouteKey(key, events, enqueue);
    await f.due();
    let [conv] = await f.convs();
    expect(conv).toMatchObject({ channel: "whatsapp", thread: "2348011112222", contact: "Chioma" });
    const draft = conv.messages.find(m => m.direction === "out")!;
    await approveReply(f.b.id, conv.id, draft.id, "Good morning Chioma! Yes, size 10 is available.", "approve-wa-0001");
    await f.due();
    expect(posts.filter(p => p.url.endsWith("/106540352242922/messages")).map(p => p.body)).toEqual([{ messaging_product: "whatsapp", recipient_type: "individual", to: "2348011112222", type: "text", text: { preview_url: false, body: "Good morning Chioma! Yes, size 10 is available." } }]);
    // 25 hours later the window is closed: the owner can't send a free-form reply, and nothing goes out.
    await discoveryRepository().transact(f.b.id, s => { const x = s.conversations![f.b.id][0]; x.last_inbound_at = new Date(Date.now() - 25 * 3_600_000).toISOString(); });
    const { ownerReply } = await import("@/lib/messaging/service");
    await expect(ownerReply(f.b.id, conv.id, "Following up!", "owner-wa-00001")).rejects.toMatchObject({ code: "WINDOW_CLOSED" });
    [conv] = await f.convs();
    expect(posts.filter(p => p.url.endsWith("/106540352242922/messages"))).toHaveLength(1);
  });
});
