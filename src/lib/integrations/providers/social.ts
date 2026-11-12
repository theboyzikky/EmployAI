import "server-only";
// REAL connectors for social accounts connected by OAuth redirect (src/lib/integrations/oauth.ts):
//
//   Facebook Pages  connect + PUBLISH image posts (Pages API, POST /{page-id}/photos with a public image URL).
//                   The Page access token derived from a long-lived user token has no expiry.
//   LinkedIn, X, TikTok, YouTube
//                   connect only: the account is verified and its tokens stored (encrypted) and renewed,
//                   so the owner connects once. Posting to these platforms is NOT built yet and every
//                   screen says so ("(not yet)"); no action exists that could pretend otherwise.
//
// Facebook publishing, honestly classified (no idempotency key exists):
//   - Meta code 190 → AUTH_REVOKED; code 10 / 200–299 → INSUFFICIENT_SCOPE (reconnect); other 4xx → rejected
//   - timeout / 5xx → UNKNOWN → reconciled by finding the exact message among the Page's recent posts,
//     otherwise escalated to the owner. Never re-published blindly.
import { z } from "zod";
import type { ActionContext, ActionOutcome, Connector } from "../types";

export const socialNet = { fetch: (url: string, init: RequestInit) => fetch(url, init) };
type Res = { status: number; json: Record<string, unknown> };
async function call(method: "GET" | "POST", url: string, token: string, body?: Record<string, unknown>, timeoutMs = 20_000): Promise<Res> {
  try {
    const r = await socialNet.fetch(url, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs) });
    return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown> };
  } catch { return { status: 0, json: {} }; }
}
const oauthToken = (input: unknown) => {
  const o = (input as { oauth?: { access_token?: unknown; refresh_token?: unknown } } | null)?.oauth;
  if (typeof o?.access_token !== "string" || !o.access_token) throw new Error("Connect this account with the Connect button.");
  return { access_token: o.access_token, ...(typeof o.refresh_token === "string" && o.refresh_token ? { refresh_token: o.refresh_token } : {}) };
};
const errText = (r: Res) => {
  const e = r.json.error as { message?: string } | string | undefined;
  const d = (r.json as { detail?: string; title?: string }).detail ?? (r.json as { title?: string }).title;
  return String(typeof e === "string" ? e : e?.message ?? d ?? `HTTP ${r.status || "no response"}`).slice(0, 200);
};

// ---- Facebook Pages ---------------------------------------------------------------------------
const FB = "https://graph.facebook.com/v27.0";
function metaAuth(r: Res): "AUTH_REVOKED" | "INSUFFICIENT_SCOPE" | null {
  const code = Number((r.json.error as { code?: unknown } | undefined)?.code);
  if (r.status === 401 || code === 190) return "AUTH_REVOKED";
  if (code === 10 || (code >= 200 && code < 300)) return "INSUFFICIENT_SCOPE";
  return null;
}
const PublishInput = z.object({
  image_url: z.string().url().max(2048).refine(u => u.startsWith("https://"), "The image must be at a public https URL."),
  caption: z.string().min(1).max(5000),
  content_item_id: z.string().max(64).optional(),
}).strict();

export const facebookConnector: Connector = {
  key: "facebook", name: "Facebook Pages", kind: "marketing", reality: "real", eventTypes: [],
  async setup(input) {
    const { access_token } = oauthToken(input);
    const pages = await call("GET", `${FB}/me/accounts?fields=id,name,access_token`, access_token);
    const list = (Array.isArray(pages.json.data) ? pages.json.data : []) as Array<{ id: string; name: string; access_token: string }>;
    const page = list.find(p => p.id && p.access_token);
    if (!page) throw new Error(pages.status === 200 ? "No Facebook Page that you manage was shared with EmployAI. Reconnect and select your business Page." : `Facebook didn't list your Pages: ${errText(pages)}`);
    return { config: { page_id: page.id, username: page.name, pages_available: list.length }, secrets: { access_token: page.access_token }, revealOnce: {} };
  },
  async checkAuth({ config, secrets }) {
    const r = await call("GET", `${FB}/${String(config.page_id ?? "")}?fields=name`, secrets.access_token ?? "");
    if (r.status === 200) return { ok: true, detail: `Connected to the Page ${String(r.json.name ?? "")}` };
    return { ok: false, reauth: !!metaAuth(r), detail: `Facebook: ${errText(r)}` };
  },
  actions: {
    "facebook.publish_image": {
      sideEffect: "publish", capability: "publish_social_post", permission: "publish_content", idempotency: "none",
      parse: i => PublishInput.parse(i),
      async execute(ctx: ActionContext, input): Promise<ActionOutcome> {
        const page = String(ctx.config.page_id ?? ""), token = ctx.secrets.access_token ?? "";
        if (!page || !token) return { kind: "rejected", retryable: false, code: "NOT_CONNECTED", detail: "The Facebook connection has no Page or token." };
        const r = await call("POST", `${FB}/${page}/photos`, token, { url: input.image_url, message: input.caption }, 45_000);
        if (r.status === 0 || r.status >= 500) return { kind: "unknown", detail: "Facebook didn't confirm the post (timeout or server error); it may or may not be live." };
        const auth = metaAuth(r);
        if (auth) return { kind: "rejected", retryable: false, code: auth, detail: `Facebook refused EmployAI's access (${errText(r)}). Reconnect Facebook. Nothing was published.` };
        const postId = typeof r.json.post_id === "string" ? r.json.post_id : typeof r.json.id === "string" ? r.json.id : null;
        if (r.status !== 200 || !postId) return { kind: "rejected", retryable: r.status === 429, code: "PUBLISH_REFUSED", detail: `Facebook refused to publish: ${errText(r)}.` };
        const p = await call("GET", `${FB}/${postId}?fields=permalink_url`, token);
        return { kind: "done", ref: postId, detail: "Published on Facebook", data: { media_id: postId, permalink: p.status === 200 ? p.json.permalink_url ?? null : null, username: ctx.config.username ?? null } };
      },
      async reconcile(ctx: ActionContext, input): Promise<ActionOutcome | null> {
        const r = await call("GET", `${FB}/${String(ctx.config.page_id ?? "")}/posts?fields=id,message,permalink_url&limit=15`, ctx.secrets.access_token ?? "");
        if (r.status !== 200) return null;
        const hit = ((r.json.data ?? []) as Array<{ id: string; message?: string; permalink_url?: string }>).find(x => (x.message ?? "").trim() === String(input.caption).trim());
        return hit ? { kind: "done", ref: hit.id, detail: "Found on Facebook during reconciliation", data: { media_id: hit.id, permalink: hit.permalink_url ?? null, username: ctx.config.username ?? null } } : null;
      },
    },
  },
};

// ---- Connect-only accounts (posting not built yet) -------------------------------------------------
function identityConnector(key: string, name: string, url: string, pick: (j: Record<string, unknown>) => { username: string; id: string } | null): Connector {
  return {
    key, name, kind: "marketing", reality: "real", eventTypes: [], actions: {},
    async setup(input) {
      const secrets = oauthToken(input);
      const r = await call("GET", url, secrets.access_token);
      const who = r.status === 200 ? pick(r.json) : null;
      if (!who) throw new Error(`${name} didn't confirm the account: ${errText(r)}`);
      return { config: { username: who.username, account_id: who.id }, secrets, revealOnce: {} };
    },
    async checkAuth({ secrets }) {
      const r = await call("GET", url, secrets.access_token ?? "");
      const who = r.status === 200 ? pick(r.json) : null;
      return who ? { ok: true, detail: `Connected as ${who.username}` } : { ok: false, reauth: r.status === 401 || r.status === 403, detail: `${name}: ${errText(r)}` };
    },
  };
}
const str = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v) : "");

export const linkedinConnector = identityConnector("linkedin", "LinkedIn", "https://api.linkedin.com/v2/userinfo",
  j => str(j.sub) ? { username: str(j.name) || str(j.email) || "LinkedIn member", id: str(j.sub) } : null);
export const xConnector = identityConnector("xcom", "X", "https://api.x.com/2/users/me",
  j => { const d = j.data as { id?: string; username?: string } | undefined; return d?.id ? { username: `@${d.username ?? d.id}`, id: d.id } : null; });
export const tiktokConnector = identityConnector("tiktok", "TikTok", "https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name",
  j => { const u = (j.data as { user?: { open_id?: string; display_name?: string } } | undefined)?.user; return u?.open_id ? { username: u.display_name || "TikTok account", id: u.open_id } : null; });
export const youtubeConnector = identityConnector("youtube", "YouTube", "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true",
  j => { const c = (j.items as Array<{ id?: string; snippet?: { title?: string } }> | undefined)?.[0]; return c?.id ? { username: c.snippet?.title ?? "YouTube channel", id: c.id } : null; });
