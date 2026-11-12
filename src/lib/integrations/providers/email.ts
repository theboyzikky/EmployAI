import "server-only";
// REAL connectors: Gmail (Gmail API) and Outlook / Microsoft 365 (Microsoft Graph), connected by OAuth
// (src/lib/integrations/oauth.ts). Scopes: send (gmail.send / Mail.Send) and read the inbox
// (gmail.readonly / Mail.Read) so the support employee can answer customer email in the same thread.
// gmail.readonly is a Google "restricted" scope: public use needs Google's verification and a security
// assessment. Inbound is POLLED by the durable worker (no Pub/Sub or Graph subscription infrastructure
// needed); newsletters, automated mail and promotions are skipped, never answered.
//
// send_email, honestly classified:
//   - 401 → AUTH_REVOKED, 403 → INSUFFICIENT_SCOPE (the connection then needs reconnecting); other 4xx → rejected
//   - 429 → rejected, retryable after a wait (nothing was sent)
//   - timeout / 5xx → UNKNOWN. Neither API takes an idempotency key and send-only scopes can't search the
//     Sent folder, so an unknown send is NEVER re-sent automatically: it is escalated to the owner.
import { z } from "zod";
import { ReplyInput, type InboundMessagePayload } from "../messaging-contract";
import type { ActionContext, ActionOutcome, ActionSpec, Connector, InboundEvent } from "../types";

export const emailNet = { fetch: (url: string, init: RequestInit) => fetch(url, init) };

async function call(method: "GET" | "POST", url: string, token: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  try {
    const r = await emailNet.fetch(url, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20_000) });
    return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown> };
  } catch { return { status: 0, json: {} }; }
}
const apiError = (r: { status: number; json: Record<string, unknown> }) => {
  const e = r.json.error as { message?: string; code?: string } | string | undefined;
  return (typeof e === "string" ? e : e?.message ?? e?.code ?? `HTTP ${r.status || "no response"}`).toString().slice(0, 200);
};

const EMAIL = /^[^\s@<>()",;:\\[\]]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,24}$/;
const SendInput = z.object({
  to: z.string().max(254).regex(EMAIL, "A single valid email address."),
  subject: z.string().min(1).max(200).refine(s => !/[\r\n]/.test(s), "The subject can't contain line breaks."),
  body: z.string().min(1).max(20_000),
}).strict();

function classify(r: { status: number; json: Record<string, unknown> }, provider: string): ActionOutcome {
  if (r.status === 0 || r.status >= 500) return { kind: "unknown", detail: `${provider} didn't confirm the email (timeout or server error); it may or may not have been sent.` };
  if (r.status === 401) return { kind: "rejected", retryable: false, code: "AUTH_REVOKED", detail: `${provider} refused EmployAI's access (${apiError(r)}). Reconnect ${provider}. Nothing was sent.` };
  if (r.status === 403) return { kind: "rejected", retryable: false, code: "INSUFFICIENT_SCOPE", detail: `${provider} says EmployAI isn't allowed to send mail (${apiError(r)}). Reconnect and allow sending. Nothing was sent.` };
  if (r.status === 429) return { kind: "rejected", retryable: true, code: "RATE_LIMITED", detail: `${provider} asked us to slow down. Nothing was sent; it will be retried.` };
  return { kind: "rejected", retryable: false, code: "SEND_REFUSED", detail: `${provider} refused the email: ${apiError(r)}. Nothing was sent.` };
}

const oauthSecrets = (input: unknown) => {
  const o = (input as { oauth?: { access_token?: unknown; refresh_token?: unknown } } | null)?.oauth;
  const access = typeof o?.access_token === "string" ? o.access_token : "";
  if (!access) throw new Error("Connect this account with the Connect button (OAuth).");
  return { access_token: access, ...(typeof o?.refresh_token === "string" && o.refresh_token ? { refresh_token: o.refresh_token } : {}) };
};

/** RFC 2822 message, base64url (Gmail "raw"). Headers are built only from validated values. */
export function gmailRaw(to: string, subject: string, body: string): string {
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
  const msg = [`To: ${to}`, `Subject: =?UTF-8?B?${b64(subject)}?=`, "MIME-Version: 1.0", 'Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64", "", b64(body)].join("\r\n");
  return Buffer.from(msg, "utf8").toString("base64url");
}

export const gmailConnector: Connector = {
  key: "gmail", name: "Gmail", kind: "communication", reality: "real", eventTypes: ["message.received"],
  async setup(input) {
    const secrets = oauthSecrets(input);
    const me = await call("GET", "https://openidconnect.googleapis.com/v1/userinfo", secrets.access_token);
    if (me.status !== 200 || typeof me.json.email !== "string") throw new Error(`Google didn't confirm the account: ${apiError(me)}`);
    return { config: { email: me.json.email }, secrets, revealOnce: {} };
  },
  poll: gmailPoll,
  async checkAuth({ secrets }) {
    const me = await call("GET", "https://openidconnect.googleapis.com/v1/userinfo", secrets.access_token ?? "");
    if (me.status === 200) return { ok: true, detail: `Connected as ${String(me.json.email ?? "")}` };
    return { ok: false, reauth: me.status === 401 || me.status === 403, detail: `Google: ${apiError(me)}` };
  },
  actions: {
    "gmail.reply": gmailReplySpec(),
    "gmail.send_email": {
      sideEffect: "external_message", capability: ["send_email", "send_message"], permission: "send_messages", idempotency: "none",
      parse: i => SendInput.parse(i),
      async execute(ctx: ActionContext, input): Promise<ActionOutcome> {
        const r = await call("POST", "https://gmail.googleapis.com/gmail/v1/users/me/messages/send", ctx.secrets.access_token ?? "", { raw: gmailRaw(String(input.to), String(input.subject), String(input.body)) });
        if (r.status === 200 && typeof r.json.id === "string") return { kind: "done", ref: r.json.id, detail: "Sent with Gmail", data: { message_id: r.json.id, from: ctx.config.email ?? null } };
        return classify(r, "Gmail");
      },
    },
  },
};

export const outlookConnector: Connector = {
  key: "outlook", name: "Outlook / Microsoft 365", kind: "communication", reality: "real", eventTypes: ["message.received"],
  async setup(input) {
    const secrets = oauthSecrets(input);
    const me = await call("GET", "https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName", secrets.access_token);
    const email = me.json.mail ?? me.json.userPrincipalName;
    if (me.status !== 200 || typeof email !== "string") throw new Error(`Microsoft didn't confirm the account: ${apiError(me)}`);
    return { config: { email }, secrets, revealOnce: {} };
  },
  poll: outlookPoll,
  async checkAuth({ secrets }) {
    const me = await call("GET", "https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName", secrets.access_token ?? "");
    if (me.status === 200) return { ok: true, detail: `Connected as ${String(me.json.mail ?? me.json.userPrincipalName ?? "")}` };
    return { ok: false, reauth: me.status === 401 || me.status === 403, detail: `Microsoft: ${apiError(me)}` };
  },
  actions: {
    "outlook.reply": outlookReplySpec(),
    "outlook.send_email": {
      sideEffect: "external_message", capability: ["send_email", "send_message"], permission: "send_messages", idempotency: "none",
      parse: i => SendInput.parse(i),
      async execute(ctx: ActionContext, input): Promise<ActionOutcome> {
        const r = await call("POST", "https://graph.microsoft.com/v1.0/me/sendMail", ctx.secrets.access_token ?? "", {
          message: { subject: input.subject, body: { contentType: "Text", content: input.body }, toRecipients: [{ emailAddress: { address: input.to } }] },
          saveToSentItems: true,
        });
        // Graph answers 202 Accepted with no id: the acceptance is the provider's confirmation.
        if (r.status === 202) return { kind: "done", ref: null, detail: "Accepted for delivery by Microsoft 365", data: { from: ctx.config.email ?? null } };
        return classify(r, "Microsoft 365");
      },
    },
  },
};

// ---- inbound mail (polled) and threaded replies ---------------------------------------------------
const GM = "https://gmail.googleapis.com/gmail/v1/users/me";
const SKIP_FROM = /(no-?reply|do-?not-?reply|mailer-daemon|postmaster|notifications?@|bounce)/i;
const addressOf = (from: string) => (/<([^>]+)>/.exec(from)?.[1] ?? from).trim();
const event = (id: string, p: InboundMessagePayload): InboundEvent => ({ externalId: id, type: "message.received", occurredAt: p.sent_at, subject: p.thread, payload: p });
type GPart = { mimeType?: string; body?: { data?: string }; parts?: GPart[]; headers?: Array<{ name: string; value: string }> };
function gmailText(p: GPart | undefined): string {
  if (!p) return "";
  if (p.mimeType === "text/plain" && p.body?.data) return Buffer.from(p.body.data, "base64url").toString("utf8");
  for (const c of p.parts ?? []) { const t = gmailText(c); if (t) return t; }
  return "";
}
/** Drop quoted history ("On … wrote:", "> …") so the employee reads what the customer actually wrote. */
const unquote = (t: string) => t.split(/\r?\n(?:On .{5,200} wrote:|-{2,} ?Original Message|From: )/)[0].split(/\r?\n/).filter(l => !l.startsWith(">")).join("\n").trim();

async function gmailPoll({ config, secrets }: { config: Readonly<Record<string, unknown>>; secrets: Readonly<Record<string, string>> }) {
  const token = secrets.access_token ?? "";
  const own = String(config.email ?? "").toLowerCase();
  const start = String(config.history_id ?? "");
  // First poll: start from now (never answer the existing inbox).
  if (!start) {
    const p = await call("GET", `${GM}/profile`, token);
    if (p.status === 401 || p.status === 403) return { error: "auth" as const, detail: `Gmail: ${apiError(p)}` };
    if (p.status !== 200) return { error: "temporary" as const, detail: `Gmail: ${apiError(p)}` };
    return { events: [], config: { ...config, history_id: String(p.json.historyId ?? "") } };
  }
  const h = await call("GET", `${GM}/history?${new URLSearchParams({ startHistoryId: start, historyTypes: "messageAdded", labelId: "INBOX" })}`, token);
  if (h.status === 404) return { events: [], config: { ...config, history_id: "" } };                 // too old: re-baseline
  if (h.status === 401 || h.status === 403) return { error: "auth" as const, detail: `Gmail: ${apiError(h)}` };
  if (h.status !== 200) return { error: "temporary" as const, detail: `Gmail: ${apiError(h)}` };
  const ids = [...new Set(((h.json.history ?? []) as Array<{ messagesAdded?: Array<{ message: { id: string; labelIds?: string[] } }> }>)
    .flatMap(x => x.messagesAdded ?? []).map(x => x.message)
    .filter(m => (m.labelIds ?? []).includes("INBOX") && !(m.labelIds ?? []).some(l => ["SENT", "DRAFT", "SPAM", "CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL", "CATEGORY_UPDATES", "CATEGORY_FORUMS"].includes(l)))
    .map(m => m.id))].slice(0, 20);
  const events: InboundEvent[] = [];
  for (const id of ids) {
    const m = await call("GET", `${GM}/messages/${id}?format=full`, token);
    if (m.status !== 200) continue;
    const payload = m.json.payload as GPart | undefined;
    const hdr = (n: string) => payload?.headers?.find(x => x.name.toLowerCase() === n)?.value ?? "";
    const from = hdr("from"), address = addressOf(from).toLowerCase();
    if (!address || address === own || SKIP_FROM.test(address) || hdr("list-unsubscribe") || /bulk|list|junk/i.test(hdr("precedence")) || (hdr("auto-submitted") && hdr("auto-submitted") !== "no")) continue;
    const text = unquote(gmailText(payload) || String(m.json.snippet ?? "")).slice(0, 4000);
    if (!text) continue;
    events.push(event(id, { channel: "gmail", thread: String(m.json.threadId ?? id), from: from.slice(0, 120) || null, text, message_id: id,
      sent_at: m.json.internalDate ? new Date(Number(m.json.internalDate)).toISOString() : null,
      context: { to: address, subject: hdr("subject").slice(0, 200), rfc_message_id: hdr("message-id").slice(0, 300) } }));
  }
  return { events, config: { ...config, history_id: String(h.json.historyId ?? start) } };
}

function gmailReplySpec(): ActionSpec {
  return {
    sideEffect: "external_message", capability: "reply_to_customer", permission: "send_messages", idempotency: "none",
    parse: i => ReplyInput.parse(i),
    async execute(ctx: ActionContext, input): Promise<ActionOutcome> {
      const c = (input.context ?? {}) as Record<string, string>;
      const to = String(c.to ?? "");
      if (!EMAIL.test(to)) return { kind: "rejected", retryable: false, code: "NO_RECIPIENT", detail: "The customer's email address is missing. Nothing was sent." };
      const subject = (/^re:/i.test(c.subject ?? "") ? c.subject : `Re: ${c.subject || "your message"}`).replace(/[\r\n]/g, " ").slice(0, 200);
      const b64 = (x: string) => Buffer.from(x, "utf8").toString("base64");
      const ref = /^<[^<>\r\n]{3,298}>$/.test(c.rfc_message_id ?? "") ? c.rfc_message_id : "";
      const raw = [`To: ${to}`, `Subject: =?UTF-8?B?${b64(subject)}?=`, ...(ref ? [`In-Reply-To: ${ref}`, `References: ${ref}`] : []), "MIME-Version: 1.0", 'Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64", "", b64(String(input.text))].join("\r\n");
      const r = await call("POST", `${GM}/messages/send`, ctx.secrets.access_token ?? "", { raw: Buffer.from(raw, "utf8").toString("base64url"), threadId: input.thread });
      if (r.status === 200 && typeof r.json.id === "string") return { kind: "done", ref: r.json.id, detail: "Sent with Gmail", data: { message_id: r.json.id } };
      return classify(r, "Gmail");
    },
  };
}

const GRAPH = "https://graph.microsoft.com/v1.0/me";
async function outlookPoll({ config, secrets }: { config: Readonly<Record<string, unknown>>; secrets: Readonly<Record<string, string>> }) {
  const token = secrets.access_token ?? "";
  const own = String(config.email ?? "").toLowerCase();
  let next = typeof config.delta_link === "string" && config.delta_link.startsWith("https://graph.microsoft.com/") ? config.delta_link : "";
  const baseline = !next;
  const since = typeof config.baseline_at === "string" ? config.baseline_at : new Date().toISOString();
  if (!next) next = `${GRAPH}/mailFolders/inbox/messages/delta?$select=id,subject,from,body,receivedDateTime,conversationId,inferenceClassification,isDraft`;
  const events: InboundEvent[] = [];
  for (let page = 0; page < 10 && next; page++) {
    let r: { status: number; json: Record<string, unknown> };
    try {
      const res = await emailNet.fetch(next, { method: "GET", headers: { Authorization: `Bearer ${token}`, Prefer: 'outlook.body-content-type="text", odata.maxpagesize=50' }, signal: AbortSignal.timeout(20_000) });
      r = { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
    } catch { r = { status: 0, json: {} }; }
    if (r.status === 401 || r.status === 403) return { error: "auth" as const, detail: `Microsoft 365: ${apiError(r)}` };
    if (r.status === 410) return { events, config: { ...config, delta_link: "", baseline_at: new Date().toISOString() } };   // sync reset
    if (r.status !== 200) return { error: "temporary" as const, detail: `Microsoft 365: ${apiError(r)}` };
    for (const m of (r.json.value ?? []) as Array<{ id?: string; "@removed"?: unknown; subject?: string; from?: { emailAddress?: { address?: string; name?: string } }; body?: { content?: string }; receivedDateTime?: string; conversationId?: string; inferenceClassification?: string; isDraft?: boolean }>) {
      if (baseline || !m.id || m["@removed"] || m.isDraft || m.inferenceClassification === "other") continue;    // Focused inbox only
      if (!m.receivedDateTime || m.receivedDateTime < since) continue;                                             // a changed old message isn't new
      const address = (m.from?.emailAddress?.address ?? "").toLowerCase();
      if (!address || address === own || SKIP_FROM.test(address)) continue;
      const text = unquote(m.body?.content ?? "").slice(0, 4000);
      if (!text) continue;
      events.push(event(m.id, { channel: "outlook", thread: m.conversationId ?? m.id, from: m.from?.emailAddress?.name ?? address, text, message_id: m.id, sent_at: m.receivedDateTime, context: { reply_to_id: m.id, to: address, subject: (m.subject ?? "").slice(0, 200) } }));
    }
    const nl = r.json["@odata.nextLink"], dl = r.json["@odata.deltaLink"];
    if (typeof dl === "string") return { events, config: { ...config, delta_link: dl, baseline_at: baseline ? new Date().toISOString() : since } };
    next = typeof nl === "string" ? nl : "";
  }
  return { events, config: { ...config, delta_link: next, baseline_at: since } };
}

function outlookReplySpec(): ActionSpec {
  return {
    sideEffect: "external_message", capability: "reply_to_customer", permission: "send_messages", idempotency: "none",
    parse: i => ReplyInput.parse(i),
    async execute(ctx: ActionContext, input): Promise<ActionOutcome> {
      const id = String(((input.context ?? {}) as Record<string, string>).reply_to_id ?? "");
      if (!/^[A-Za-z0-9=_+/-]{10,400}$/.test(id)) return { kind: "rejected", retryable: false, code: "NO_RECIPIENT", detail: "The original email is missing. Nothing was sent." };
      const r = await call("POST", `${GRAPH}/messages/${encodeURIComponent(id)}/reply`, ctx.secrets.access_token ?? "", { comment: input.text });
      if (r.status === 202) return { kind: "done", ref: null, detail: "Reply accepted by Microsoft 365", data: {} };
      return classify(r, "Microsoft 365");
    },
  };
}
