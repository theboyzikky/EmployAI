// Gmail and Outlook as customer channels through the real code paths, with Google's and Microsoft's APIs
// STUBBED: background polling (baseline first, never the old inbox), filtering of automated mail, the
// support employee, threaded replies, and revocation. Not a real mailbox.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { resetAiForTests } from "@/lib/ai";
import "@/lib/automation/handlers";
import { runDueTasks } from "@/lib/automation/worker";
import { discoveryRepository, setDiscoveryRepository } from "@/lib/discovery/store";
import { createConnection, setEmployeePermissions } from "@/lib/integrations/connections";
import "@/lib/integrations/providers";
import { emailNet } from "@/lib/integrations/providers/email";
import { MemoryKv, setKvForTests } from "@/lib/kv";
import { approveReply } from "@/lib/messaging/service";
import { approveWorkforce, planWorkforce } from "@/lib/workforce/service";
import { tempStore } from "./helpers/run-fixture";
import { sharedMode } from "./helpers/store";

const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status });
const b64u = (s: string) => Buffer.from(s, "utf8").toString("base64url");
let sentRaw: Array<{ raw: string; threadId: string }> = [];
let replies: Array<{ id: string; comment: string }> = [];
let gmailHistoryCalls = 0;
let revoked = false;

beforeEach(() => {
  vi.stubEnv("AI_PROVIDER", "mock"); vi.stubEnv("APP_ENCRYPTION_KEY", "e".repeat(40));
  resetAiForTests(); sentRaw = []; replies = []; gmailHistoryCalls = 0; revoked = false;
  if (!sharedMode) setKvForTests(new MemoryKv());
  vi.spyOn(emailNet, "fetch").mockImplementation(async (url: string, init: RequestInit) => {
    if (revoked) return json({ error: { message: "Invalid Credentials" } }, 401);
    const u = new URL(url);
    if (url.includes("userinfo")) return json({ email: "shop@ada-atelier.example" });
    if (u.pathname.endsWith("/me") && u.host === "graph.microsoft.com") return json({ mail: "shop@ada-atelier.example" });
    if (u.pathname.endsWith("/users/me/profile")) return json({ historyId: "1000" });
    if (u.pathname.endsWith("/users/me/history")) {
      gmailHistoryCalls++;
      return json({ historyId: "1010", history: [{ messagesAdded: [{ message: { id: "g1", labelIds: ["INBOX", "UNREAD"] } }, { message: { id: "g2", labelIds: ["INBOX"] } }, { message: { id: "g3", labelIds: ["INBOX", "CATEGORY_PROMOTIONS"] } }] }] });
    }
    if (u.pathname.endsWith("/messages/g1")) return json({ id: "g1", threadId: "t-1", internalDate: String(Date.now()), payload: { mimeType: "multipart/alternative", headers: [{ name: "From", value: "Kemi Ade <kemi@example.com>" }, { name: "Subject", value: "Wrap dress sizes" }, { name: "Message-ID", value: "<CAB123@mail.example.com>" }],
      parts: [{ mimeType: "text/plain", body: { data: b64u("Hello, do you have the Emerald wrap dress in size 12?\n\nOn Mon, someone wrote:\n> old text") } }] } });
    if (u.pathname.endsWith("/messages/g2")) return json({ id: "g2", threadId: "t-2", payload: { headers: [{ name: "From", value: "News <news@brand.example>" }, { name: "List-Unsubscribe", value: "<mailto:u@brand.example>" }], parts: [{ mimeType: "text/plain", body: { data: b64u("Big sale!") } }] } });
    if (u.pathname.endsWith("/messages/send")) { sentRaw.push(JSON.parse(String(init.body))); return json({ id: "sent-1" }); }
    if (u.pathname.includes("/mailFolders/inbox/messages/delta")) {
      if (!u.searchParams.has("$deltatoken")) return json({ value: [{ id: "old-1", receivedDateTime: "2020-01-01T00:00:00Z" }], "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=abc" });
      return json({ value: [
        { id: "AAMkAGI2TG93AAANew1=", subject: "Order question", from: { emailAddress: { address: "tobi@example.com", name: "Tobi" } }, body: { content: "Can I order two of the Emerald dress?" }, receivedDateTime: new Date(Date.now() + 1000).toISOString(), conversationId: "conv-9", inferenceClassification: "focused" },
        { id: "AAMkOld", subject: "old", from: { emailAddress: { address: "x@example.com" } }, body: { content: "edited old mail" }, receivedDateTime: "2020-01-01T00:00:00Z", conversationId: "c-old", inferenceClassification: "focused" },
      ], "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=def" });
    }
    if (u.pathname.endsWith("/reply")) { replies.push({ id: decodeURIComponent(u.pathname.split("/").at(-2)!), comment: JSON.parse(String(init.body)).comment }); return new Response(null, { status: 202 }); }
    return json({ error: { message: "unexpected " + u.pathname } }, 404);
  });
});
afterEach(() => { vi.unstubAllEnvs(); resetAiForTests(); setDiscoveryRepository(null); setKvForTests(null); vi.restoreAllMocks(); });

async function mailbox(connector: "gmail" | "outlook") {
  const t = tempStore();
  const b = await t.store.createBusiness({ ownerHash: `owner-${connector}`, initialMessage: "Boutique" });
  await planWorkforce((await t.store.getBusiness(b.id))!, "Reply to customer enquiries by email.");
  await approveWorkforce(b.id);
  const c = await createConnection(b.id, { connector, label: connector, setup: { oauth: { access_token: "tok", refresh_token: "rt" } }, auth: { method: "oauth", account: null, scopes: [], expires_at: new Date(Date.now() + 3_600_000).toISOString(), refreshable: true } });
  await setEmployeePermissions(b.id, c.view.id, "customer_support", ["read_messages", "send_messages"]);
  const due = async () => { await discoveryRepository().transact(b.id, s => { for (const x of s.tasks?.[b.id] ?? []) if (x.status === "queued") x.next_at = new Date(0).toISOString(); }); await runDueTasks(b.id); };
  return { b, c, due, convs: () => discoveryRepository().readState(b.id, s => s.conversations?.[b.id] ?? []), tasks: () => discoveryRepository().readState(b.id, s => s.tasks?.[b.id] ?? []) };
}

describe("email as a customer channel, checked by the background worker", () => {
  test("Gmail: first check sets a baseline; then a customer email (not the newsletter or promotion) is answered in its thread", async () => {
    const f = await mailbox("gmail");
    await f.due();                                                                   // baseline: nothing read
    expect(gmailHistoryCalls).toBe(0);
    expect(await f.convs()).toEqual([]);
    await f.due();                                                                   // next check: new mail
    const convs = await f.convs();
    expect(convs.map(c => [c.channel, c.thread, c.contact])).toEqual([["gmail", "t-1", "Kemi Ade <kemi@example.com>"]]);
    expect(convs[0].messages[0].text).toBe("Hello, do you have the Emerald wrap dress in size 12?");   // quoted history dropped
    const draft = convs[0].messages.find(m => m.direction === "out")!;
    await approveReply(f.b.id, convs[0].id, draft.id, "Hi Kemi, yes, size 12 is in stock.", "approve-gm-0001");
    await f.due();
    expect(sentRaw).toHaveLength(1);
    expect(sentRaw[0].threadId).toBe("t-1");
    const raw = Buffer.from(sentRaw[0].raw, "base64url").toString("utf8");
    expect(raw).toContain("To: kemi@example.com");
    expect(raw).toContain("In-Reply-To: <CAB123@mail.example.com>");
    expect(Buffer.from(raw.split("\r\n\r\n")[1], "base64").toString("utf8")).toBe("Hi Kemi, yes, size 12 is in stock.");
    // The poll keeps itself scheduled.
    expect((await f.tasks()).filter(t => t.kind === "poll_mailbox" && t.status === "queued")).toHaveLength(1);
  });

  test("Outlook: the delta baseline skips the existing inbox and edited old mail; the reply goes to the original message", async () => {
    const f = await mailbox("outlook");
    await f.due(); await f.due();
    const convs = await f.convs();
    expect(convs.map(c => [c.channel, c.thread, c.contact])).toEqual([["outlook", "conv-9", "Tobi"]]);
    const draft = convs[0].messages.find(m => m.direction === "out")!;
    await approveReply(f.b.id, convs[0].id, draft.id, "Hi Tobi, yes, two are available.", "approve-ol-0001");
    await f.due();
    expect(replies).toEqual([{ id: "AAMkAGI2TG93AAANew1=", comment: "Hi Tobi, yes, two are available." }]);
  });

  test("a revoked mailbox stops being checked and asks the owner to reconnect", async () => {
    const f = await mailbox("gmail");
    await f.due();
    revoked = true;
    await f.due();
    const conn = await discoveryRepository().readState(f.b.id, s => s.connections![f.b.id][0]);
    expect(conn.status).toBe("reauth_required");
    expect((await f.tasks()).filter(t => t.kind === "poll_mailbox" && t.status === "queued")).toHaveLength(0);
  });
});
