import "server-only";
// Telegram's official business authorization, as EmployAI's "Connect → external authorization → back":
//
//  1. Connect → EmployAI issues a single-use code (256-bit, stored hashed, 15 minutes, bound to the
//     business) and sends the owner to https://t.me/<EmployAI bot>?start=<code> (Telegram's deep link).
//  2. In Telegram, the owner taps Start. The bot receives "/start <code>" from the owner's Telegram user:
//     EmployAI records a PENDING connection for that user and tells them the one remaining step.
//  3. The owner adds the bot under Settings → Telegram Business → Chatbots; Telegram shows the rights it
//     grants and sends a business_connection update. When it is enabled with permission to reply, the
//     connection becomes ACTIVE. Turning the chatbot off later makes it "Reconnection required".
//  4. Customer messages arrive as business_message updates and are routed by business_connection_id.
//
// All updates reach ONE webhook (/api/hooks/telegram) authenticated by Telegram's secret-token header.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { discoveryRepository } from "@/lib/discovery/store";
import { getKv } from "@/lib/kv";
import { audit, createConnection, IntegrationError, patchConnection } from "./connections";
import { deliverToRouteKey, type OnNewEvent } from "./inbox";
import { botApi, botToken } from "./providers/telegram-business";

const LINK_TTL_MS = 15 * 60_000;
const linkKey = (code: string) => `tglink:${createHash("sha256").update(code).digest("hex")}`;
export const telegramBotUsername = () => (process.env.TELEGRAM_BOT_USERNAME ?? "").trim().replace(/^@/, "");
export const telegramConfigured = () => !!botToken() && /^[A-Za-z0-9_]{5,32}$/.test(telegramBotUsername()) && !!(process.env.TELEGRAM_WEBHOOK_SECRET ?? "").trim();
export const telegramEnvNames = () => ["TELEGRAM_BOT_TOKEN", "TELEGRAM_BOT_USERNAME", "TELEGRAM_WEBHOOK_SECRET"];

/** Step 1: the Telegram deep link the Connect button opens. */
export async function startTelegramLink(businessId: string, returnTo: string): Promise<string> {
  if (!telegramConfigured()) throw new IntegrationError("SETUP_REQUIRED", 409, `Telegram needs developer setup on this server first (${telegramEnvNames().join(", ")}).`);
  const code = randomBytes(24).toString("base64url");                       // 32 chars, allowed in a start parameter
  const ret = returnTo.startsWith(`/w/${businessId}/`) && !returnTo.includes("//") ? returnTo : `/w/${businessId}/integrations`;
  await getKv().set(linkKey(code), JSON.stringify({ b: businessId, ret }), LINK_TTL_MS);
  return `https://t.me/${telegramBotUsername()}?start=${code}`;
}

/** The webhook's secret-token header must match (timing-safe). */
export function telegramSecretOk(header: string | null): boolean {
  const want = Buffer.from((process.env.TELEGRAM_WEBHOOK_SECRET ?? "").trim());
  const got = Buffer.from(header ?? "");
  return want.length > 0 && got.length === want.length && timingSafeEqual(got, want);
}

type TgUser = { id: number; first_name?: string; username?: string };
type Update = {
  update_id: number;
  message?: { message_id: number; date: number; text?: string; chat: { id: number; type: string }; from?: TgUser };
  business_connection?: { id: string; user: TgUser; user_chat_id: number; date: number; is_enabled: boolean; can_reply?: boolean; rights?: { can_reply?: boolean } };
  business_message?: { business_connection_id: string; message_id: number; date: number; text?: string; caption?: string; chat: { id: number; type: string; first_name?: string; username?: string }; from?: TgUser };
};
const nameOf = (u?: TgUser) => (u?.username ? `@${u.username}` : u?.first_name ?? null);
const say = (chatId: number, text: string) => botApi("sendMessage", { chat_id: chatId, text });

/** Handle one verified update. Returns the business that received a customer message (to wake its worker). */
export async function handleTelegramUpdate(u: Update, onNewEvent?: OnNewEvent): Promise<string | null> {
  // 2 · the owner tapped Start with a link code
  const m = u.message;
  const start = m?.chat.type === "private" ? /^\/start ([A-Za-z0-9_-]{20,64})$/.exec(m.text ?? "") : null;
  if (m && start && m.from) {
    const raw = await getKv().get(linkKey(start[1])).catch(() => null);
    await getKv().del(linkKey(start[1])).catch(() => undefined);              // single use
    if (!raw) { await say(m.chat.id, "This EmployAI link has expired or was already used. Click Connect in EmployAI again."); return null; }
    const { b } = JSON.parse(raw) as { b: string };
    const userId = String(m.from.id);
    const existing = await discoveryRepository().readState(b, s => ((s.connections ?? {})[b] ?? []).find(c => c.connector === "telegram_business") ?? null);
    try {
      await createConnection(b, { connector: "telegram_business", label: "Telegram", setup: { link: { owner_user_id: userId, owner_name: nameOf(m.from) } }, initialStatus: "pending", replaceId: existing?.id ?? null });
    } catch (e) {
      await say(m.chat.id, e instanceof IntegrationError && e.code === "ACCOUNT_IN_USE" ? "This Telegram account is already connected to another EmployAI workspace." : "EmployAI couldn't start the connection. Please try again from EmployAI.");
      return null;
    }
    await say(m.chat.id, `Almost done. In Telegram, open Settings → Telegram Business → Chatbots, add @${telegramBotUsername()}, and allow it to reply to messages. Telegram will show exactly what EmployAI may do. Then go back to EmployAI.`);
    return null;
  }
  // 3 · Telegram confirms (or withdraws) the owner's authorization
  const bc = u.business_connection;
  if (bc) {
    const hit = await discoveryRepository().connectionForRouteKey(`tg:user:${bc.user.id}`);
    if (!hit) return null;                                                   // not linked to any EmployAI workspace
    const canReply = !!(bc.rights?.can_reply ?? bc.can_reply);
    await patchConnection(hit.businessId, hit.connectionId, (c, s) => {
      c.config = { ...c.config, business_connection_id: bc.id };
      const keys = new Set([...(c.route_keys ?? []), `tg:bc:${bc.id}`]);
      c.route_keys = [...keys];
      c.auth = { method: "token", scopes: canReply ? ["can_reply"] : [], expires_at: null, refreshable: false, checked_at: new Date().toISOString(), account: nameOf(bc.user), problem: null, ...(c.auth ? { method: c.auth.method } : {}) };
      if (bc.is_enabled && canReply) {
        if (c.status !== "active") audit(s, hit.businessId, "owner", "connection.authorized", `connection:${c.id}`, "active", c.id, { connector: "telegram_business" });
        c.status = "active";
      } else {
        c.status = "reauth_required";
        c.auth.problem = bc.is_enabled ? "Allow EmployAI's chatbot to reply to messages in Telegram Business settings." : "EmployAI's chatbot was turned off in Telegram Business settings.";
        audit(s, hit.businessId, "system", "connection.reauth_required", `connection:${c.id}`, "reauth_required", c.id, { connector: "telegram_business" });
      }
    });
    if (bc.is_enabled && canReply) await say(bc.user_chat_id, "EmployAI is connected to your Telegram Business account. You can close Telegram and return to EmployAI.");
    return null;
  }
  // 4 · a customer wrote to the owner's business account
  const bm = u.business_message;
  if (bm && bm.chat.type === "private") {
    const hit = await discoveryRepository().connectionForRouteKey(`tg:bc:${bm.business_connection_id}`);
    if (!hit) return null;
    const owner = await discoveryRepository().readState(hit.businessId, s => String(((s.connections ?? {})[hit.businessId] ?? []).find(c => c.id === hit.connectionId)?.config.owner_user_id ?? ""));
    if (bm.from && String(bm.from.id) === owner) return null;                 // the owner's own messages aren't customer messages
    const text = (bm.text ?? bm.caption ?? "").slice(0, 4000) || "[a message without text]";
    const r = await deliverToRouteKey(`tg:bc:${bm.business_connection_id}`, [{
      externalId: `${bm.business_connection_id}:${bm.chat.id}:${bm.message_id}`, type: "message.received", occurredAt: new Date(bm.date * 1000).toISOString(), subject: String(bm.chat.id),
      payload: { channel: "telegram", thread: String(bm.chat.id), from: nameOf(bm.from) ?? bm.chat.first_name ?? null, text, message_id: String(bm.message_id), sent_at: new Date(bm.date * 1000).toISOString(), context: { business_connection_id: bm.business_connection_id } },
    }], onNewEvent);
    return r && r.accepted.length ? r.businessId : null;
  }
  return null;
}
