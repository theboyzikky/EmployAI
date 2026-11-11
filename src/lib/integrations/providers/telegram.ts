import "server-only";
// REAL connector: Telegram Bot API. The owner creates a bot with @BotFather and pastes its token (Telegram
// has no OAuth for bots). The token is checked with getMe, stored encrypted and never shown or logged —
// it is part of every API URL, so URLs are never logged either.
//
// Inbound: Telegram POSTs updates to /api/hooks/<connectionId> (registered with setWebhook when the app
// has a public https address) with the header X-Telegram-Bot-Api-Secret-Token, which must equal the
// secret generated at setup. Message content is UNTRUSTED and authorises nothing.
// Outbound: telegram.send_message. No idempotency key exists, so an unknown outcome is escalated.
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { newSecret } from "../credentials";
import type { ActionContext, ActionOutcome, Connector, InboundVerdict } from "../types";

export const telegramNet = { fetch: (url: string, init: RequestInit) => fetch(url, init) };
const TOKEN = /^\d{5,12}:[A-Za-z0-9_-]{30,64}$/;

async function api(token: string, method: string, body?: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> {
  try {
    const r = await telegramNet.fetch(`https://api.telegram.org/bot${token}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}), signal: AbortSignal.timeout(15_000) });
    return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown> };
  } catch { return { status: 0, json: {} }; }
}
const describe = (r: { status: number; json: Record<string, unknown> }) => String(r.json.description ?? `HTTP ${r.status || "no response"}`).slice(0, 200);

const Update = z.object({
  update_id: z.number().int(),
  message: z.object({
    message_id: z.number().int(),
    date: z.number().int(),
    text: z.string().optional(),
    chat: z.object({ id: z.number().int(), type: z.string().max(32) }).passthrough(),
    from: z.object({ first_name: z.string().optional(), username: z.string().optional() }).passthrough().optional(),
  }).passthrough().optional(),
}).passthrough();

const SendInput = z.object({ chat_id: z.string().regex(/^-?\d{1,20}$/), text: z.string().min(1).max(4096) }).strict();

export const telegramConnector: Connector = {
  key: "telegram", name: "Telegram", kind: "communication", reality: "real", eventTypes: ["message.received"],
  async setup(input) {
    const token = String((input as { bot_token?: unknown } | null)?.bot_token ?? "").trim();
    if (!TOKEN.test(token)) throw new Error("Paste the bot token @BotFather gave you (it looks like 123456789:AA…).");
    const me = await api(token, "getMe");
    const r = me.json.result as { id?: number; username?: string } | undefined;
    if (me.json.ok !== true || !r?.username) throw new Error(`Telegram didn't accept the token: ${describe(me)}`);
    return { config: { username: r.username, bot_id: String(r.id ?? "") }, secrets: { bot_token: token, webhook_secret: newSecret().replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) }, revealOnce: {} };
  },
  async checkAuth({ secrets }) {
    const me = await api(secrets.bot_token ?? "", "getMe");
    if (me.json.ok === true) return { ok: true, detail: `Connected as @${String((me.json.result as { username?: string })?.username ?? "")}` };
    return { ok: false, reauth: me.status === 401 || me.status === 404, detail: `Telegram: ${describe(me)}` };
  },
  async activate({ connectionId, publicUrl, secrets }) {
    if (!publicUrl) return { ok: false, detail: "Sending works now. Receiving messages needs the app at a public https address (EMPLOYAI_PUBLIC_URL), then reconnect." };
    const r = await api(secrets.bot_token ?? "", "setWebhook", { url: `${publicUrl}/api/hooks/${connectionId}`, secret_token: secrets.webhook_secret, allowed_updates: ["message"] });
    return r.json.ok === true ? { ok: true, detail: "Telegram delivers incoming messages to EmployAI." } : { ok: false, detail: `Telegram didn't accept the webhook: ${describe(r)}` };
  },
  inbound({ rawBody, headers, secrets }): InboundVerdict {
    const given = Buffer.from(headers.get("x-telegram-bot-api-secret-token") ?? "");
    const want = Buffer.from(secrets.webhook_secret ?? "");
    if (!want.length || given.length !== want.length || !timingSafeEqual(given, want)) return { ok: false, status: 401, code: "BAD_SECRET" };
    let json: unknown;
    try { json = JSON.parse(rawBody); } catch { return { ok: false, status: 400, code: "INVALID_JSON" }; }
    const u = Update.safeParse(json);
    if (!u.success) return { ok: false, status: 400, code: "INVALID_UPDATE" };
    const m = u.data.message;
    if (!m) return { ok: true, events: [] };                          // other update kinds are ignored
    return { ok: true, events: [{
      externalId: String(u.data.update_id), type: "message.received", occurredAt: new Date(m.date * 1000).toISOString(), subject: String(m.chat.id),
      payload: { chat_id: String(m.chat.id), chat_type: m.chat.type, text: (m.text ?? "").slice(0, 4000), from: (m.from?.username ?? m.from?.first_name ?? "").slice(0, 64), message_id: m.message_id },
    }] };
  },
  actions: {
    "telegram.send_message": {
      sideEffect: "external_message", capability: ["reply_to_customer", "send_message"], permission: "send_messages", idempotency: "none",
      parse: i => SendInput.parse(i),
      async execute(ctx: ActionContext, input): Promise<ActionOutcome> {
        const r = await api(ctx.secrets.bot_token ?? "", "sendMessage", { chat_id: input.chat_id, text: input.text });
        const msg = r.json.result as { message_id?: number } | undefined;
        if (r.json.ok === true && msg?.message_id !== undefined) return { kind: "done", ref: String(msg.message_id), detail: "Delivered by Telegram", data: { message_id: msg.message_id, chat_id: input.chat_id } };
        if (r.status === 0 || r.status >= 500) return { kind: "unknown", detail: "Telegram didn't confirm the message; it may or may not have been delivered." };
        if (r.status === 401 || r.status === 404) return { kind: "rejected", retryable: false, code: "AUTH_REVOKED", detail: `Telegram refused the bot token (${describe(r)}). Reconnect Telegram. Nothing was sent.` };
        if (r.status === 429) return { kind: "rejected", retryable: true, code: "RATE_LIMITED", detail: "Telegram asked us to slow down. Nothing was sent; it will be retried." };
        if (r.status === 403) return { kind: "rejected", retryable: false, code: "RECIPIENT_BLOCKED", detail: `Telegram won't deliver to this chat (${describe(r)}). Nothing was sent.` };
        return { kind: "rejected", retryable: false, code: "SEND_REFUSED", detail: `Telegram refused the message: ${describe(r)}. Nothing was sent.` };
      },
    },
  },
};
