import "server-only";
// REAL connectors for Meta messaging, all receiving through ONE app webhook (/api/hooks/meta, signed with
// X-Hub-Signature-256) and routed by the account's id:
//
//   instagram_dm  Instagram API with Instagram Login (instagram_business_manage_messages). Subscribes the
//                 account to "messages"; replies POST graph.instagram.com/v27.0/<IG_ID>/messages.
//   messenger     Facebook Login (pages_messaging, pages_manage_metadata). Subscribes the Page to
//                 "messages"; replies POST graph.facebook.com/v27.0/<PAGE_ID>/messages (RESPONSE).
//   whatsapp      WhatsApp Business Platform via Embedded Signup (Meta's own sign-up window). The code is
//                 exchanged for a business token, the WABA and number are verified against the token's
//                 granted assets, the app is subscribed to the WABA; replies POST /<PHONE_NUMBER_ID>/messages.
//
// Messaging windows: Instagram, Messenger and WhatsApp only allow free-form replies within 24 hours of
// the customer's last message (the messaging service checks first; the platform's refusal is mapped to
// WINDOW_CLOSED). No idempotency keys exist: an unknown outcome is escalated, never re-sent.
import { ReplyInput } from "../messaging-contract";
import type { ActionContext, ActionOutcome, Connector } from "../types";

export const metaNet = { fetch: (url: string, init: RequestInit) => fetch(url, init) };
type Res = { status: number; json: Record<string, unknown> };
async function call(method: "GET" | "POST", url: string, token: string | null, body?: unknown): Promise<Res> {
  try {
    const r = await metaNet.fetch(url, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20_000) });
    return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown> };
  } catch { return { status: 0, json: {} }; }
}
const err = (r: Res) => r.json.error as { message?: string; code?: number; error_subcode?: number } | undefined;
const errText = (r: Res) => String(err(r)?.message ?? `HTTP ${r.status || "no response"}`).slice(0, 200);
const IG = "https://graph.instagram.com/v27.0";
const FB = "https://graph.facebook.com/v27.0";
const env = (k: string) => (process.env[k] ?? "").trim();

/** Meta send outcome, honestly classified. */
function classify(r: Res, ok: (j: Record<string, unknown>) => string | null, platform: string): ActionOutcome {
  const id = r.status === 200 ? ok(r.json) : null;
  if (id) return { kind: "done", ref: id, detail: `Delivered to ${platform}`, data: { message_id: id } };
  if (r.status === 0 || r.status >= 500) return { kind: "unknown", detail: `${platform} didn't confirm the message; it may or may not have been delivered.` };
  const e = err(r);
  // Outside the 24-hour window: Messenger/Instagram code 10 subcode 2018278; WhatsApp 131047 (re-engagement).
  if ((e?.code === 10 && e.error_subcode === 2018278) || e?.code === 131047) return { kind: "rejected", retryable: false, code: "WINDOW_CLOSED", detail: `${platform} only allows replies within 24 hours of the customer's last message. Nothing was sent.` };
  if (r.status === 401 || e?.code === 190) return { kind: "rejected", retryable: false, code: "AUTH_REVOKED", detail: `${platform} refused EmployAI's access (${errText(r)}). Reconnect it. Nothing was sent.` };
  if (e?.code === 10 || e?.code === 200 || (e?.code ?? 0) >= 200 && (e?.code ?? 0) < 300) return { kind: "rejected", retryable: false, code: "INSUFFICIENT_SCOPE", detail: `${platform}: ${errText(r)}. Reconnect and allow messaging. Nothing was sent.` };
  if (r.status === 429 || e?.code === 4 || e?.code === 613 || e?.code === 130429) return { kind: "rejected", retryable: true, code: "RATE_LIMITED", detail: `${platform} asked us to slow down. Nothing was sent; it will be retried.` };
  return { kind: "rejected", retryable: false, code: "SEND_REFUSED", detail: `${platform} refused the message: ${errText(r)}. Nothing was sent.` };
}
const oauthToken = (input: unknown) => {
  const t = (input as { oauth?: { access_token?: unknown } } | null)?.oauth?.access_token;
  if (typeof t !== "string" || !t) throw new Error("Connect this account with the Connect button.");
  return t;
};

// ---- Instagram Direct Messages --------------------------------------------------------------------
export const instagramDmConnector: Connector = {
  key: "instagram_dm", name: "Instagram Direct Messages", kind: "communication", reality: "real", eventTypes: ["message.received"],
  async setup(input) {
    const token = oauthToken(input);
    const me = await call("GET", `${IG}/me?fields=user_id,username`, token);
    const id = me.json.user_id;
    if (me.status !== 200 || (typeof id !== "string" && typeof id !== "number")) throw new Error(`Instagram didn't confirm the account: ${errText(me)}`);
    return { config: { ig_user_id: String(id), username: String(me.json.username ?? "") }, secrets: { access_token: token }, revealOnce: {}, routeKeys: [`meta:ig:${id}`] };
  },
  async activate({ config, secrets }) {
    const r = await call("POST", `${IG}/${String(config.ig_user_id)}/subscribed_apps?subscribed_fields=messages`, secrets.access_token ?? null);
    return r.status === 200 && r.json.success !== false ? { ok: true, detail: "Instagram sends new direct messages to EmployAI." } : { ok: false, detail: `Instagram didn't subscribe the account to messages: ${errText(r)}` };
  },
  async checkAuth({ secrets }) {
    const r = await call("GET", `${IG}/me?fields=user_id,username`, secrets.access_token ?? null);
    return r.status === 200 ? { ok: true, detail: `Connected as @${String(r.json.username ?? "")}` } : { ok: false, reauth: r.status === 401 || err(r)?.code === 190, detail: `Instagram: ${errText(r)}` };
  },
  actions: {
    "instagram_dm.reply": {
      sideEffect: "external_message", capability: "reply_to_customer", permission: "send_messages", idempotency: "none",
      parse: i => ReplyInput.parse(i),
      async execute(ctx: ActionContext, input): Promise<ActionOutcome> {
        const r = await call("POST", `${IG}/${String(ctx.config.ig_user_id)}/messages`, ctx.secrets.access_token ?? null, { recipient: { id: input.thread }, message: { text: input.text } });
        return classify(r, j => typeof j.message_id === "string" ? j.message_id : null, "Instagram");
      },
    },
  },
};

// ---- Facebook Messenger ------------------------------------------------------------------------------
export const messengerConnector: Connector = {
  key: "messenger", name: "Facebook Messenger", kind: "communication", reality: "real", eventTypes: ["message.received"],
  async setup(input) {
    const token = oauthToken(input);
    const pages = await call("GET", `${FB}/me/accounts?fields=id,name,access_token`, token);
    const page = ((Array.isArray(pages.json.data) ? pages.json.data : []) as Array<{ id: string; name: string; access_token: string }>).find(p => p.id && p.access_token);
    if (!page) throw new Error(pages.status === 200 ? "No Facebook Page that you manage was shared with EmployAI. Reconnect and select your business Page." : `Facebook didn't list your Pages: ${errText(pages)}`);
    return { config: { page_id: page.id, username: page.name }, secrets: { access_token: page.access_token }, revealOnce: {}, routeKeys: [`meta:page:${page.id}`] };
  },
  async activate({ config, secrets }) {
    const r = await call("POST", `${FB}/${String(config.page_id)}/subscribed_apps?subscribed_fields=messages`, secrets.access_token ?? null);
    return r.status === 200 && r.json.success !== false ? { ok: true, detail: "Facebook sends new Messenger messages to EmployAI." } : { ok: false, detail: `Facebook didn't subscribe the Page to messages: ${errText(r)}` };
  },
  async checkAuth({ config, secrets }) {
    const r = await call("GET", `${FB}/${String(config.page_id ?? "")}?fields=name`, secrets.access_token ?? null);
    return r.status === 200 ? { ok: true, detail: `Connected to the Page ${String(r.json.name ?? "")}` } : { ok: false, reauth: err(r)?.code === 190, detail: `Facebook: ${errText(r)}` };
  },
  actions: {
    "messenger.reply": {
      sideEffect: "external_message", capability: "reply_to_customer", permission: "send_messages", idempotency: "none",
      parse: i => ReplyInput.parse(i),
      async execute(ctx: ActionContext, input): Promise<ActionOutcome> {
        const r = await call("POST", `${FB}/${String(ctx.config.page_id)}/messages`, ctx.secrets.access_token ?? null, { recipient: { id: input.thread }, messaging_type: "RESPONSE", message: { text: input.text } });
        return classify(r, j => typeof j.message_id === "string" ? j.message_id : null, "Messenger");
      },
    },
  },
};

// ---- WhatsApp Business (Embedded Signup) -------------------------------------------------------------
export const whatsappConnector: Connector = {
  key: "whatsapp", name: "WhatsApp Business", kind: "communication", reality: "real", eventTypes: ["message.received"],
  // input: { signup: { code, waba_id, phone_number_id } } from Meta's Embedded Signup window (untrusted until verified here)
  async setup(input) {
    const su = (input as { signup?: { code?: unknown; waba_id?: unknown; phone_number_id?: unknown } } | null)?.signup;
    const code = typeof su?.code === "string" ? su.code : "", waba = String(su?.waba_id ?? ""), phone = String(su?.phone_number_id ?? "");
    if (!code || !/^\d{5,25}$/.test(waba) || !/^\d{5,25}$/.test(phone)) throw new Error("Connect WhatsApp with the Connect button.");
    // 1 · exchange the code (30-second lifetime) for a business integration system user token
    const t = await call("GET", `${FB}/oauth/access_token?${new URLSearchParams({ client_id: env("FACEBOOK_APP_ID"), client_secret: env("FACEBOOK_APP_SECRET"), code })}`, null);
    const token = typeof t.json.access_token === "string" ? t.json.access_token : "";
    if (!token) throw new Error(`Meta didn't issue a WhatsApp token: ${errText(t)}`);
    // 2 · the WABA must be one this token was actually granted (the window's message is not trusted)
    const dbg = await call("GET", `${FB}/debug_token?${new URLSearchParams({ input_token: token, access_token: `${env("FACEBOOK_APP_ID")}|${env("FACEBOOK_APP_SECRET")}` })}`, null);
    const scopes = ((dbg.json.data as { granular_scopes?: Array<{ scope: string; target_ids?: string[] }> } | undefined)?.granular_scopes ?? []);
    if (!scopes.some(s => s.scope.startsWith("whatsapp_business") && (s.target_ids ?? []).includes(waba))) throw new Error("Meta didn't grant EmployAI access to that WhatsApp Business account.");
    // 3 · the number must belong to that WABA
    const nums = await call("GET", `${FB}/${waba}/phone_numbers?fields=id,display_phone_number,verified_name`, token);
    const num = ((nums.json.data ?? []) as Array<{ id: string; display_phone_number?: string; verified_name?: string }>).find(n => n.id === phone);
    if (!num) throw new Error("That phone number isn't part of the WhatsApp Business account you authorised.");
    return { config: { waba_id: waba, phone_number_id: phone, username: num.display_phone_number ?? phone, verified_name: num.verified_name ?? null }, secrets: { access_token: token }, revealOnce: {}, routeKeys: [`meta:wa:${phone}`] };
  },
  async activate({ config, secrets }) {
    const r = await call("POST", `${FB}/${String(config.waba_id)}/subscribed_apps`, secrets.access_token ?? null);
    return r.status === 200 && r.json.success !== false ? { ok: true, detail: "WhatsApp sends new messages to EmployAI. If WhatsApp Manager shows the number as pending, finish its registration there." } : { ok: false, detail: `Meta didn't subscribe EmployAI to the WhatsApp account: ${errText(r)}` };
  },
  async checkAuth({ config, secrets }) {
    const r = await call("GET", `${FB}/${String(config.phone_number_id ?? "")}?fields=display_phone_number,verified_name`, secrets.access_token ?? null);
    return r.status === 200 ? { ok: true, detail: `Connected: ${String(r.json.display_phone_number ?? "")}` } : { ok: false, reauth: err(r)?.code === 190, detail: `WhatsApp: ${errText(r)}` };
  },
  actions: {
    "whatsapp.reply": {
      sideEffect: "external_message", capability: "reply_to_customer", permission: "send_messages", idempotency: "none",
      parse: i => ReplyInput.parse(i),
      async execute(ctx: ActionContext, input): Promise<ActionOutcome> {
        const r = await call("POST", `${FB}/${String(ctx.config.phone_number_id)}/messages`, ctx.secrets.access_token ?? null, { messaging_product: "whatsapp", recipient_type: "individual", to: input.thread, type: "text", text: { preview_url: false, body: input.text } });
        return classify(r, j => (Array.isArray(j.messages) && typeof (j.messages[0] as { id?: unknown })?.id === "string") ? (j.messages[0] as { id: string }).id : null, "WhatsApp");
      },
    },
  },
};
