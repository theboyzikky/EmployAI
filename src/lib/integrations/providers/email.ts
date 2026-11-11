import "server-only";
// REAL connectors: Gmail (Gmail API) and Outlook / Microsoft 365 (Microsoft Graph), connected by OAuth
// (src/lib/integrations/oauth.ts) with the minimum scope to SEND mail: gmail.send / Mail.Send. Neither
// can read the mailbox with these scopes, so reading email stays "not implemented".
//
// send_email, honestly classified:
//   - 401 → AUTH_REVOKED, 403 → INSUFFICIENT_SCOPE (the connection then needs reconnecting); other 4xx → rejected
//   - 429 → rejected, retryable after a wait (nothing was sent)
//   - timeout / 5xx → UNKNOWN. Neither API takes an idempotency key and send-only scopes can't search the
//     Sent folder, so an unknown send is NEVER re-sent automatically: it is escalated to the owner.
import { z } from "zod";
import type { ActionContext, ActionOutcome, Connector } from "../types";

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
  key: "gmail", name: "Gmail", kind: "communication", reality: "real", eventTypes: [],
  async setup(input) {
    const secrets = oauthSecrets(input);
    const me = await call("GET", "https://openidconnect.googleapis.com/v1/userinfo", secrets.access_token);
    if (me.status !== 200 || typeof me.json.email !== "string") throw new Error(`Google didn't confirm the account: ${apiError(me)}`);
    return { config: { email: me.json.email }, secrets, revealOnce: {} };
  },
  async checkAuth({ secrets }) {
    const me = await call("GET", "https://openidconnect.googleapis.com/v1/userinfo", secrets.access_token ?? "");
    if (me.status === 200) return { ok: true, detail: `Connected as ${String(me.json.email ?? "")}` };
    return { ok: false, reauth: me.status === 401 || me.status === 403, detail: `Google: ${apiError(me)}` };
  },
  actions: {
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
  key: "outlook", name: "Outlook / Microsoft 365", kind: "communication", reality: "real", eventTypes: [],
  async setup(input) {
    const secrets = oauthSecrets(input);
    const me = await call("GET", "https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName", secrets.access_token);
    const email = me.json.mail ?? me.json.userPrincipalName;
    if (me.status !== 200 || typeof email !== "string") throw new Error(`Microsoft didn't confirm the account: ${apiError(me)}`);
    return { config: { email }, secrets, revealOnce: {} };
  },
  async checkAuth({ secrets }) {
    const me = await call("GET", "https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName", secrets.access_token ?? "");
    if (me.status === 200) return { ok: true, detail: `Connected as ${String(me.json.mail ?? me.json.userPrincipalName ?? "")}` };
    return { ok: false, reauth: me.status === 401 || me.status === 403, detail: `Microsoft: ${apiError(me)}` };
  },
  actions: {
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
