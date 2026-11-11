import "server-only";
// REAL connector: Telegram Business. The owner connects their OWN Telegram account (customers keep
// messaging the business's usual Telegram) to EmployAI's bot, using Telegram's official business
// authorization: Telegram Settings → Telegram Business → Chatbots, where Telegram shows the rights the
// bot gets. No token or password ever passes through EmployAI's pages (the bot token is the operator's,
// in TELEGRAM_BOT_TOKEN). Requires Telegram Premium on the owner's account and Business Mode on the bot.
//
// Inbound arrives on EmployAI's single bot webhook (/api/hooks/telegram, telegram-link.ts) as
// business_message updates and is routed by business_connection_id. Replies use sendMessage with
// business_connection_id. Telegram has no idempotency key: an unknown outcome is escalated, never re-sent.
import { ReplyInput } from "../messaging-contract";
import type { ActionContext, ActionOutcome, Connector } from "../types";
import { classifyTelegramSend, telegramNet } from "./telegram";

export const botToken = () => (process.env.TELEGRAM_BOT_TOKEN ?? "").trim();
/** Bot API call with the operator's bot token (the token is in the URL path: URLs are never logged). */
export async function botApi(method: string, body: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> {
  const token = botToken();
  if (!token) return { status: 0, json: { description: "TELEGRAM_BOT_TOKEN isn't configured." } };
  try {
    const r = await telegramNet.fetch(`https://api.telegram.org/bot${token}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
    return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown> };
  } catch { return { status: 0, json: {} }; }
}

export const telegramBusinessConnector: Connector = {
  key: "telegram_business", name: "Telegram", kind: "communication", reality: "real", eventTypes: ["message.received"],
  // Created only by the link flow (telegram-link.ts), never from a form.
  setup(input) {
    const l = (input as { link?: { owner_user_id?: unknown; owner_name?: unknown } } | null)?.link;
    if (typeof l?.owner_user_id !== "string" || !/^\d{1,20}$/.test(l.owner_user_id)) throw new Error("Connect Telegram with the Connect button.");
    return { config: { owner_user_id: l.owner_user_id, username: typeof l.owner_name === "string" ? l.owner_name.slice(0, 64) : null, business_connection_id: null }, secrets: {}, revealOnce: {}, routeKeys: [`tg:user:${l.owner_user_id}`] };
  },
  async checkAuth({ config }) {
    const id = String(config.business_connection_id ?? "");
    if (!id) return { ok: false, reauth: false, detail: "Waiting for you to add EmployAI's bot under Telegram Business → Chatbots." };
    const r = await botApi("getBusinessConnection", { business_connection_id: id });
    const bc = r.json.result as { is_enabled?: boolean; can_reply?: boolean; rights?: { can_reply?: boolean } } | undefined;
    if (r.json.ok === true && bc?.is_enabled && (bc.rights?.can_reply ?? bc.can_reply)) return { ok: true, detail: "Telegram confirms EmployAI may reply on your behalf." };
    return { ok: false, reauth: r.json.ok === true || r.status === 400, detail: r.json.ok === true ? "The chatbot is turned off or not allowed to reply in Telegram Business settings." : `Telegram: ${String(r.json.description ?? "unreachable")}` };
  },
  actions: {
    "telegram_business.reply": {
      sideEffect: "external_message", capability: "reply_to_customer", permission: "send_messages", idempotency: "none",
      parse: i => ReplyInput.parse(i),
      async execute(ctx: ActionContext, input): Promise<ActionOutcome> {
        const bc = String((input.context as Record<string, string> | undefined)?.business_connection_id ?? ctx.config.business_connection_id ?? "");
        if (!bc) return { kind: "rejected", retryable: false, code: "RECONNECT_REQUIRED", detail: "Telegram Business isn't connected. Nothing was sent." };
        if (!botToken()) return { kind: "rejected", retryable: false, code: "NOT_CONFIGURED", detail: "This server has no Telegram bot configured. Nothing was sent." };
        const r = await botApi("sendMessage", { business_connection_id: bc, chat_id: input.thread, text: input.text });
        // A business connection that was turned off answers 400/403: the owner must reconnect.
        const desc = String(r.json.description ?? "");
        if ((r.status === 400 || r.status === 403) && /business.?connection/i.test(desc)) return { kind: "rejected", retryable: false, code: "AUTH_REVOKED", detail: `Telegram: ${desc.slice(0, 160)}. Reconnect Telegram. Nothing was sent.` };
        return classifyTelegramSend(r, String(input.thread));
      },
    },
  },
};
