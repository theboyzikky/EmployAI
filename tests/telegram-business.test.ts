// Telegram Business connection end to end through the real code paths, with Telegram's Bot API STUBBED:
// Connect → t.me deep link → /start code → pending → business_connection (Telegram's own authorization)
// → active → customer business_message → support employee → reply through business_connection_id.
// This proves EmployAI's flow and safeguards, not a real Telegram account.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { resetAiForTests } from "@/lib/ai";
import "@/lib/automation/handlers";
import { enqueueTaskIn } from "@/lib/automation/tasks";
import { runDueTasks } from "@/lib/automation/worker";
import { discoveryRepository, setDiscoveryRepository } from "@/lib/discovery/store";
import { setEmployeePermissions } from "@/lib/integrations/connections";
import { buildHubView } from "@/lib/integrations/hub";
import "@/lib/integrations/providers";
import { telegramNet } from "@/lib/integrations/providers/telegram";
import { handleTelegramUpdate, startTelegramLink, telegramSecretOk } from "@/lib/integrations/telegram-link";
import { MemoryKv, setKvForTests } from "@/lib/kv";
import { approveReply } from "@/lib/messaging/service";
import { approveWorkforce, planWorkforce } from "@/lib/workforce/service";
import { tempStore } from "./helpers/run-fixture";
import { sharedMode } from "./helpers/store";

const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status });
let calls: Array<{ method: string; body: Record<string, unknown> }> = [];

beforeEach(() => {
  vi.stubEnv("AI_PROVIDER", "mock"); vi.stubEnv("APP_ENCRYPTION_KEY", "t".repeat(40));
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "123456789:AAoperatortokenvalue_abcdefghijklmn"); vi.stubEnv("TELEGRAM_BOT_USERNAME", "EmployAIBot"); vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", "s3cret-webhook-token-123");
  resetAiForTests(); calls = [];
  if (!sharedMode) setKvForTests(new MemoryKv());
  vi.spyOn(telegramNet, "fetch").mockImplementation(async (url: string, init: RequestInit) => {
    const method = url.split("/").pop()!;
    calls.push({ method, body: JSON.parse(String(init.body ?? "{}")) });
    return method === "sendMessage" ? json({ ok: true, result: { message_id: 700 + calls.length } }) : json({ ok: true, result: true });
  });
});
afterEach(() => { vi.unstubAllEnvs(); resetAiForTests(); setDiscoveryRepository(null); setKvForTests(null); vi.restoreAllMocks(); });

const enqueue = (s: Parameters<NonNullable<Parameters<typeof handleTelegramUpdate>[1]>>[0], ev: { business_id: string; id: string }) => { enqueueTaskIn(s, ev.business_id, { kind: "process_event", ref: ev.id, dedupeKey: `event:${ev.id}` }); };

async function workspace(owner: string, shared?: ReturnType<typeof tempStore>) {
  const t = shared ?? tempStore();
  const b = await t.store.createBusiness({ ownerHash: owner, initialMessage: "Boutique" });
  await planWorkforce((await t.store.getBusiness(b.id))!, "Reply to customer enquiries on my messaging accounts.");
  await approveWorkforce(b.id);
  return { b, t, biz: async () => (await t.store.getBusiness(b.id))! };
}

describe("Telegram: Connect → Telegram's own authorization → back to EmployAI, connected", () => {
  test("deep link, Start, chatbot authorization; then a customer message is answered through the business connection", async () => {
    const f = await workspace("owner-tg");
    const link = new URL(await startTelegramLink(f.b.id, `/w/${f.b.id}/integrations`));
    expect(link.origin + link.pathname).toBe("https://t.me/EmployAIBot");
    const code = link.searchParams.get("start")!;
    expect(code).toMatch(/^[A-Za-z0-9_-]{32}$/);
    // Owner taps Start in Telegram.
    await handleTelegramUpdate({ update_id: 1, message: { message_id: 1, date: 1, text: `/start ${code}`, chat: { id: 4242, type: "private" }, from: { id: 4242, first_name: "Ada", username: "ada_owner" } } });
    let hub = await buildHubView(await f.biz());
    expect(hub.providers.find(p => p.key === "telegram")!.status).toBe("pending");
    expect(calls.at(-1)!.body.text).toMatch(/Telegram Business → Chatbots/);
    // The link code is single use.
    await handleTelegramUpdate({ update_id: 2, message: { message_id: 2, date: 1, text: `/start ${code}`, chat: { id: 4242, type: "private" }, from: { id: 4242 } } });
    expect(calls.at(-1)!.body.text).toMatch(/expired or was already used/);
    // Telegram confirms the owner added the chatbot with permission to reply.
    await handleTelegramUpdate({ update_id: 3, business_connection: { id: "BC-1", user: { id: 4242, username: "ada_owner" }, user_chat_id: 4242, date: 2, is_enabled: true, rights: { can_reply: true } } });
    hub = await buildHubView(await f.biz());
    const tg = hub.providers.find(p => p.key === "telegram")!;
    expect(tg).toMatchObject({ status: "connected", checklist: { accountConnected: true } });
    expect(tg.connections[0].account).toBe("@ada_owner");
    // Explicit permission for the support employee, then a customer writes to Ada's account.
    const conn = (await discoveryRepository().readState(f.b.id, s => s.connections![f.b.id])).find(c => c.connector === "telegram_business")!;
    expect(conn.grants).toEqual([]);
    await setEmployeePermissions(f.b.id, conn.id, "customer_support", ["read_messages", "send_messages"]);
    const msg = { update_id: 10, business_message: { business_connection_id: "BC-1", message_id: 77, date: Math.floor(Date.now() / 1000), text: "Hello, are you open on Sunday?", chat: { id: 9001, type: "private" }, from: { id: 9001, first_name: "Tunde" } } };
    expect(await handleTelegramUpdate(msg, enqueue)).toBe(f.b.id);
    expect(await handleTelegramUpdate(msg, enqueue)).toBeNull();                       // Telegram retry: stored once
    // The owner's own message in that chat is not a customer message.
    expect(await handleTelegramUpdate({ update_id: 11, business_message: { ...msg.business_message, message_id: 78, from: { id: 4242 } } }, enqueue)).toBeNull();
    await runDueTasks(f.b.id);
    const [c] = await discoveryRepository().readState(f.b.id, s => s.conversations![f.b.id]);
    expect(c).toMatchObject({ channel: "telegram", thread: "9001", contact: "Tunde", context: { business_connection_id: "BC-1" } });
    const draft = c.messages.find(m => m.direction === "out")!;
    await approveReply(f.b.id, c.id, draft.id, "Yes, we're open 10am to 4pm on Sundays.", "approve-tg-0001");
    await discoveryRepository().transact(f.b.id, s => { for (const t of s.tasks![f.b.id]) if (t.status === "queued") t.next_at = new Date(0).toISOString(); });
    await runDueTasks(f.b.id);
    const send = calls.filter(x => x.method === "sendMessage" && x.body.business_connection_id === "BC-1");
    expect(send.map(x => x.body)).toEqual([{ business_connection_id: "BC-1", chat_id: "9001", text: "Yes, we're open 10am to 4pm on Sundays." }]);
    // The owner turns the chatbot off in Telegram: the connection needs reconnecting and nothing more is sent.
    await handleTelegramUpdate({ update_id: 20, business_connection: { id: "BC-1", user: { id: 4242 }, user_chat_id: 4242, date: 3, is_enabled: false } });
    hub = await buildHubView(await f.biz());
    expect(hub.providers.find(p => p.key === "telegram")!.status).toBe("reauth_required");
  });

  test("the webhook secret is required, and one Telegram account can't be attached to two workspaces", async () => {
    expect(telegramSecretOk("s3cret-webhook-token-123")).toBe(true);
    expect(telegramSecretOk("wrong")).toBe(false);
    expect(telegramSecretOk(null)).toBe(false);
    const store = tempStore();
    const a = await workspace("owner-a", store);
    const codeA = new URL(await startTelegramLink(a.b.id, "/")).searchParams.get("start")!;
    await handleTelegramUpdate({ update_id: 1, message: { message_id: 1, date: 1, text: `/start ${codeA}`, chat: { id: 5, type: "private" }, from: { id: 5 } } });
    const b = await workspace("owner-b", store);
    const codeB = new URL(await startTelegramLink(b.b.id, "/")).searchParams.get("start")!;
    await handleTelegramUpdate({ update_id: 2, message: { message_id: 2, date: 1, text: `/start ${codeB}`, chat: { id: 5, type: "private" }, from: { id: 5 } } });
    expect(calls.at(-1)!.body.text).toMatch(/already connected to another EmployAI workspace/);
    expect(await discoveryRepository().readState(b.b.id, s => s.connections?.[b.b.id] ?? [])).toEqual([]);
  });
});
