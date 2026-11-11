// The connections hub: honest provider statuses, connect-once with least-privilege grants, owner-set
// permissions per employee, capability resolution, official OAuth flows (state, PKCE, scopes, refresh,
// revocation), email and Telegram connectors, disconnect and reconnect. Every provider API is STUBBED:
// these tests prove EmployAI's code paths, not a real connection to Google, Microsoft, Meta or Telegram.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { resetAiForTests } from "@/lib/ai";
import "@/lib/automation/handlers";
import { driveAction, requestAction } from "@/lib/integrations/actions";
import { PROVIDERS } from "@/lib/integrations/catalogue";
import { createConnection, disconnectConnection, loadConnectionForUse, ReconnectRequired, setEmployeePermissions } from "@/lib/integrations/connections";
import { buildHubView } from "@/lib/integrations/hub";
import { completeOAuth, oauthNet, peekState, startOAuth } from "@/lib/integrations/oauth";
import "@/lib/integrations/providers";
import { emailNet } from "@/lib/integrations/providers/email";
import { instagramNet } from "@/lib/integrations/providers/instagram";
import { telegramConnector, telegramNet } from "@/lib/integrations/providers/telegram";
import { connectorFor } from "@/lib/integrations/registry";
import { resolveCapability } from "@/lib/integrations/resolve";
import { discoveryRepository, setDiscoveryRepository } from "@/lib/discovery/store";
import { MemoryKv, setKvForTests } from "@/lib/kv";
import { approveWorkforce, planWorkforce } from "@/lib/workforce/service";
import { workforceReadiness } from "@/lib/workforce/readiness";
import { tempStore } from "./helpers/run-fixture";
import { sharedMode } from "./helpers/store";

const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status });
let gmailSends = 0;
let gmailMode: "ok" | "500" | "401" = "ok";
let tokenMode: "ok" | "no_send_scope" | "invalid_grant" = "ok";

function stubProviders() {
  gmailSends = 0;
  vi.spyOn(instagramNet, "sleep").mockResolvedValue(undefined);
  vi.spyOn(instagramNet, "fetch").mockImplementation(async (url: string) => new URL(url).pathname.endsWith("/me") ? json({ user_id: "1784", username: "ada.atelier", account_type: "BUSINESS" }) : json({ error: { message: "unexpected" } }, 400));
  vi.spyOn(telegramNet, "fetch").mockImplementation(async (url: string) => url.endsWith("/getMe") ? json({ ok: true, result: { id: 42, username: "ada_atelier_bot" } }) : url.endsWith("/sendMessage") ? json({ ok: true, result: { message_id: 7 } }) : json({ ok: true, result: true }));
  vi.spyOn(emailNet, "fetch").mockImplementation(async (url: string) => {
    if (url.includes("userinfo")) return json({ email: "owner@ada-atelier.example" });
    if (url.includes("/messages/send")) { gmailSends++; return gmailMode === "ok" ? json({ id: "msg-1" }) : gmailMode === "401" ? json({ error: { message: "Invalid Credentials" } }, 401) : json({}, 500); }
    return json({}, 404);
  });
  vi.spyOn(oauthNet, "fetch").mockImplementation(async (url: string, init: RequestInit) => {
    const body = new URLSearchParams(String(init.body ?? ""));
    if (url === "https://oauth2.googleapis.com/token" && body.get("grant_type") === "authorization_code")
      return json({ access_token: "ya29.access-1", refresh_token: "1//refresh-1", expires_in: 3600, scope: tokenMode === "no_send_scope" ? "openid https://www.googleapis.com/auth/userinfo.email" : "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/gmail.send" });
    if (url === "https://oauth2.googleapis.com/token" && body.get("grant_type") === "refresh_token")
      return tokenMode === "invalid_grant" ? json({ error: "invalid_grant" }, 400) : json({ access_token: "ya29.access-2", expires_in: 3600, scope: "https://www.googleapis.com/auth/gmail.send" });
    return json({ error: "unexpected" }, 400);
  });
}

beforeEach(() => {
  vi.stubEnv("AI_PROVIDER", "mock"); vi.stubEnv("APP_ENCRYPTION_KEY", "e".repeat(40));
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", ""); vi.stubEnv("GOOGLE_OAUTH_CLIENT_SECRET", ""); vi.stubEnv("INSTAGRAM_APP_ID", ""); vi.stubEnv("INSTAGRAM_APP_SECRET", "");
  vi.stubEnv("MICROSOFT_OAUTH_CLIENT_ID", ""); vi.stubEnv("MICROSOFT_OAUTH_CLIENT_SECRET", ""); vi.stubEnv("EMPLOYAI_PUBLIC_URL", "");
  resetAiForTests(); gmailMode = "ok"; tokenMode = "ok";
  if (!sharedMode) setKvForTests(new MemoryKv());
  stubProviders();
});
afterEach(() => { vi.unstubAllEnvs(); resetAiForTests(); setDiscoveryRepository(null); setKvForTests(null); vi.restoreAllMocks(); });

/** The owner's example request: social media, promotional posts, customer enquiries. */
async function boutique() {
  const t = tempStore();
  const b = await t.store.createBusiness({ ownerHash: "owner-hub", initialMessage: "Fashion boutique" });
  await planWorkforce((await t.store.getBusiness(b.id))!, "Manage my social media, publish promotional posts and reply to customer enquiries.");
  const state = () => discoveryRepository().readState(b.id, s => s);
  const biz = async () => (await t.store.getBusiness(b.id))!;
  return { b, t, state, biz };
}
const conns = (bid: string) => discoveryRepository().readState(bid, s => (s.connections ?? {})[bid] ?? []);

describe("the catalogue never shows a provider as more than it is", () => {
  test("every implemented provider has a registered connector; unbuilt ones don't; statuses are honest", async () => {
    for (const p of PROVIDERS) expect([p.key, p.support === "implemented" ? !!connectorFor(p.connector ?? "") : p.connector === null]).toEqual([p.key, true]);
    const f = await boutique();
    const v = await buildHubView(await f.biz());
    const st = (k: string) => v.providers.find(p => p.key === k)!;
    expect(["facebook", "tiktok", "linkedin", "x", "youtube", "whatsapp_business", "webchat", "imap_smtp"].map(k => st(k).status)).toEqual(Array(8).fill("not_implemented"));
    expect(st("whatsapp_personal").status).toBe("unsupported");
    expect(st("gmail")).toMatchObject({ status: "not_connected", canOAuth: true, setupMissing: ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET"] });
    expect(st("telegram")).toMatchObject({ status: "not_connected", canToken: true, canOAuth: false });
    await expect(startOAuth(f.b.id, "gmail", { origin: "http://localhost:3101", returnTo: "/" })).rejects.toMatchObject({ code: "SETUP_REQUIRED" });
    await expect(startOAuth(f.b.id, "facebook", { origin: "http://localhost:3101", returnTo: "/" })).rejects.toMatchObject({ code: "NOT_SUPPORTED" });
  });
});

describe("connect once: the workforce reuses connections with least privilege, and the owner controls permissions", () => {
  test("missing connections are named, with why; connected ones are reused; unbuilt skills are never shown as ready", async () => {
    const f = await boutique();
    let r = workforceReadiness(await f.state(), f.b.id)!;
    const publish = r.missing.find(m => m.capability === "publish_social_post")!;
    expect(publish.providers.map(p => p.key)).toEqual(["instagram"]);
    expect(publish.why).toMatch(/Social Media Manager/);
    expect(r.notYet.map(n => n.skill)).toContain("answer_enquiry");          // replying to enquiries isn't built: said so
    await approveWorkforce(f.b.id);
    await createConnection(f.b.id, { connector: "instagram", label: "Instagram", setup: { access_token: "IGAAtest_token_value_0123456789" } });
    r = workforceReadiness(await f.state(), f.b.id)!;
    expect(r.missing.find(m => m.capability === "publish_social_post")).toBeUndefined();
    expect(r.ready.filter(x => x.capability === "publish_social_post").map(x => x.via)).toEqual(expect.arrayContaining([expect.stringContaining("Instagram (ada.atelier)")]));
  });

  test("a new connection grants each action only to employees whose skills need it; the owner can grant and revoke per employee", async () => {
    const f = await boutique();
    await approveWorkforce(f.b.id);
    const ig = await createConnection(f.b.id, { connector: "instagram", label: "Instagram", setup: { access_token: "IGAAtest_token_value_0123456789" } });
    const tg = await createConnection(f.b.id, { connector: "telegram", label: "Telegram", setup: { bot_token: "123456789:AAtesttokenvalue_abcdefghijklmnopqrs" } });
    const all = await conns(f.b.id);
    expect(all.find(c => c.id === ig.view.id)!.grants.map(g => g.agent)).toEqual(["social_media_manager"]);
    expect(all.find(c => c.id === tg.view.id)!.grants.map(g => g.agent)).toEqual(["customer_support"]);
    // Not granted → refused, even though the account is connected.
    await expect(requestAction(f.b.id, { connectionId: tg.view.id, action: "telegram.send_message", agent: "content_creator", idempotencyKey: "tg-test-0001", input: { chat_id: "555", text: "Hi" }, correlationId: "t" })).rejects.toMatchObject({ code: "NOT_AUTHORISED" });
    await setEmployeePermissions(f.b.id, tg.view.id, "content_creator", ["send_messages", "read_messages"]);
    let c = (await conns(f.b.id)).find(x => x.id === tg.view.id)!;
    expect(c.routes).toEqual([{ event_type: "message.received", agent: "content_creator" }]);
    expect((await requestAction(f.b.id, { connectionId: tg.view.id, action: "telegram.send_message", agent: "content_creator", idempotencyKey: "tg-test-0002", input: { chat_id: "555", text: "Hi" }, correlationId: "t" })).created).toBe(true);
    await setEmployeePermissions(f.b.id, tg.view.id, "content_creator", []);
    c = (await conns(f.b.id)).find(x => x.id === tg.view.id)!;
    expect(c.grants.some(g => g.agent === "content_creator")).toBe(false);
    await expect(requestAction(f.b.id, { connectionId: tg.view.id, action: "telegram.send_message", agent: "content_creator", idempotencyKey: "tg-test-0003", input: { chat_id: "555", text: "Hi" }, correlationId: "t" })).rejects.toMatchObject({ code: "NOT_AUTHORISED" });
    // The resolver is provider-independent: the capability resolves to whichever connection is granted.
    expect(resolveCapability(await f.state(), f.b.id, "social_media_manager", "publish_social_post")).toMatchObject({ state: "ready", connector: "instagram", action: "instagram.publish_image" });
    expect(resolveCapability(await f.state(), f.b.id, "content_creator", "publish_social_post")).toMatchObject({ state: "needs_permission" });
  });

  test("disconnect deletes credentials and grants; reconnect keeps the same connection and re-applies least-privilege grants", async () => {
    const f = await boutique();
    await approveWorkforce(f.b.id);
    const tg = await createConnection(f.b.id, { connector: "telegram", label: "Telegram", setup: { bot_token: "123456789:AAtesttokenvalue_abcdefghijklmnopqrs" } });
    await disconnectConnection(f.b.id, tg.view.id);
    const gone = (await conns(f.b.id))[0];
    expect(gone).toMatchObject({ status: "disconnected", secrets: null, grants: [], routes: [] });
    await expect(requestAction(f.b.id, { connectionId: tg.view.id, action: "telegram.send_message", agent: "customer_support", idempotencyKey: "tg-test-0004", input: { chat_id: "555", text: "Hi" }, correlationId: "t" })).rejects.toMatchObject({ code: "CONNECTION_NOT_ACTIVE" });
    const again = await createConnection(f.b.id, { connector: "telegram", label: "Telegram", setup: { bot_token: "123456789:AAtesttokenvalue_abcdefghijklmnopqrs" }, replaceId: tg.view.id });
    expect(again.view.id).toBe(tg.view.id);
    expect((await conns(f.b.id))).toHaveLength(1);
    expect((await conns(f.b.id))[0]).toMatchObject({ status: "active", grants: [{ agent: "customer_support", actions: ["telegram.send_message"] }] });
  });
});

describe("official OAuth: state, PKCE, minimum scopes, encrypted tokens, refresh and revocation", () => {
  async function gmail() {
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "client-123.apps.googleusercontent.com"); vi.stubEnv("GOOGLE_OAUTH_CLIENT_SECRET", "test-secret");
    const f = await boutique();
    await approveWorkforce(f.b.id);
    const url = new URL(await startOAuth(f.b.id, "gmail", { origin: "http://localhost:3101", returnTo: `/w/${f.b.id}/workforce` }));
    const state = url.searchParams.get("state")!;
    return { ...f, url, state };
  }

  test("the authorization request is Google's official one, with PKCE and only the send scope; the state is single use", async () => {
    const g = await gmail();
    expect(g.url.origin + g.url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(g.url.searchParams.get("scope")!.split(" ")).toEqual(["openid", "email", "https://www.googleapis.com/auth/gmail.send"]);
    expect(g.url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(g.url.searchParams.get("access_type")).toBe("offline");
    expect(g.url.searchParams.get("redirect_uri")).toBe("http://localhost:3101/api/oauth/google/callback");
    const pending = (await peekState(g.state))!;
    expect(pending).toMatchObject({ b: g.b.id, p: "gmail", ret: `/w/${g.b.id}/workforce` });
    const r = await completeOAuth("google", g.state, pending, { code: "auth-code", error: null });
    expect(r).toEqual({ returnTo: `/w/${g.b.id}/workforce`, outcome: "connected" });
    expect(await peekState(g.state)).toBeNull();                                 // used once
    const c = (await conns(g.b.id)).find(x => x.connector === "gmail")!;
    expect(c).toMatchObject({ status: "active", auth: { method: "oauth", account: "owner@ada-atelier.example", refreshable: true } });
    expect(JSON.stringify(c)).not.toMatch(/ya29|refresh-1/);                    // stored encrypted only
    const used = await loadConnectionForUse(g.b.id, c.id);
    expect(used!.secrets).toMatchObject({ access_token: "ya29.access-1", refresh_token: "1//refresh-1" });
  });

  test("a return target outside this workspace is ignored (no open redirect)", async () => {
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "client-123"); vi.stubEnv("GOOGLE_OAUTH_CLIENT_SECRET", "s");
    const f = await boutique();
    const url = new URL(await startOAuth(f.b.id, "gmail", { origin: "http://localhost:3101", returnTo: "https://evil.example/steal" }));
    expect((await peekState(url.searchParams.get("state")!))!.ret).toBe(`/w/${f.b.id}/integrations`);
  });

  test("a consent without the send permission is never shown as working", async () => {
    tokenMode = "no_send_scope";
    const g = await gmail();
    expect((await completeOAuth("google", g.state, (await peekState(g.state))!, { code: "c", error: null })).outcome).toBe("insufficient");
    expect((await conns(g.b.id)).find(x => x.connector === "gmail")).toMatchObject({ status: "reauth_required", auth: { problem: expect.stringContaining("gmail.send") } });
  });

  test("an expiring token is renewed before use; a revoked one stops everything until the owner reconnects", async () => {
    const g = await gmail();
    await completeOAuth("google", g.state, (await peekState(g.state))!, { code: "c", error: null });
    const id = (await conns(g.b.id)).find(x => x.connector === "gmail")!.id;
    await setEmployeePermissions(g.b.id, id, "customer_support", ["send_messages"]);
    const expire = () => discoveryRepository().transact(g.b.id, s => { const c = s.connections![g.b.id].find(x => x.id === id)!; c.auth!.expires_at = new Date(Date.now() - 1000).toISOString(); });
    await expire();
    expect((await loadConnectionForUse(g.b.id, id))!.secrets.access_token).toBe("ya29.access-2");
    // Revoked: the queued email is refused BEFORE sending, and the connection asks for reconnection.
    const { attemptId } = await requestAction(g.b.id, { connectionId: id, action: "gmail.send_email", agent: "customer_support", idempotencyKey: "mail-test-0001", input: { to: "customer@example.com", subject: "Your order", body: "Thanks!" }, correlationId: "t" });
    await expire(); tokenMode = "invalid_grant";
    expect(await driveAction(g.b.id, attemptId)).toBe("rejected");
    expect(gmailSends).toBe(0);
    const c = (await conns(g.b.id)).find(x => x.id === id)!;
    expect(c.status).toBe("reauth_required");
    await expect(loadConnectionForUse(g.b.id, id).then(x => x)).resolves.toBeTruthy();   // status gates use, not loading
    await expect(requestAction(g.b.id, { connectionId: id, action: "gmail.send_email", agent: "customer_support", idempotencyKey: "mail-test-0002", input: { to: "customer@example.com", subject: "x", body: "y" }, correlationId: "t" })).rejects.toMatchObject({ code: "CONNECTION_NOT_ACTIVE" });
    expect(new ReconnectRequired("x")).toBeInstanceOf(Error);
  });
});

describe("email and Telegram connectors classify outcomes honestly", () => {
  async function mailbox() {
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "client-123"); vi.stubEnv("GOOGLE_OAUTH_CLIENT_SECRET", "s");
    const f = await boutique();
    await approveWorkforce(f.b.id);
    const url = new URL(await startOAuth(f.b.id, "gmail", { origin: "http://localhost:3101", returnTo: "/" }));
    const st = url.searchParams.get("state")!;
    await completeOAuth("google", st, (await peekState(st))!, { code: "c", error: null });
    const id = (await conns(f.b.id)).find(x => x.connector === "gmail")!.id;
    await setEmployeePermissions(f.b.id, id, "customer_support", ["send_messages"]);
    const send = (key: string) => requestAction(f.b.id, { connectionId: id, action: "gmail.send_email", agent: "customer_support", idempotencyKey: key, input: { to: "customer@example.com", subject: "Your order", body: "Thanks!" }, correlationId: "t" });
    return { ...f, id, send };
  }

  test("sent → done with Gmail's message id; a server error is unknown and escalated, never re-sent", async () => {
    const m = await mailbox();
    const a = await m.send("mail-ok-00001");
    expect(await driveAction(m.b.id, a.attemptId)).toBe("done");
    gmailMode = "500";
    const b = await m.send("mail-500-0001");
    expect(await driveAction(m.b.id, b.attemptId)).toBe("unknown");          // can't know whether it went out
    expect(await driveAction(m.b.id, b.attemptId)).toBe("escalated");        // no idempotency key → the owner decides
    expect(await driveAction(m.b.id, b.attemptId)).toBe("escalated");
    expect(gmailSends).toBe(2);                                                    // one each; no blind retry
  });

  test("Gmail refusing the credentials marks the connection for reconnection", async () => {
    const m = await mailbox();
    gmailMode = "401";
    const a = await m.send("mail-401-0001");
    expect(await driveAction(m.b.id, a.attemptId)).toBe("rejected");
    expect((await conns(m.b.id)).find(x => x.id === m.id)!.status).toBe("reauth_required");
  });

  test("Telegram inbound needs the secret header; message content arrives as an untrusted event", async () => {
    const setup = await telegramConnector.setup({ bot_token: "123456789:AAtesttokenvalue_abcdefghijklmnopqrs" });
    const body = JSON.stringify({ update_id: 1001, message: { message_id: 5, date: 1_762_000_000, text: "Do you have the dress in size 12?", chat: { id: 555, type: "private" }, from: { first_name: "Ngozi" } } });
    const verdict = (secret: string) => telegramConnector.inbound!({ rawBody: body, headers: new Headers({ "x-telegram-bot-api-secret-token": secret }), config: setup.config, secrets: setup.secrets, now: Date.now() });
    expect(verdict("wrong-secret")).toMatchObject({ ok: false, status: 401 });
    expect(verdict(setup.secrets.webhook_secret)).toMatchObject({ ok: true, events: [{ externalId: "1001", type: "message.received", subject: "555", payload: { text: "Do you have the dress in size 12?", from: "Ngozi" } }] });
    expect(setup.secrets.bot_token).toBeDefined();
    expect(JSON.stringify(setup.config)).not.toContain("AAtesttokenvalue");
  });
});
