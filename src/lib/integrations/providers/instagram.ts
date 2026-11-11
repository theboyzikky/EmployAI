import "server-only";
// REAL connector: Instagram (Instagram API with Instagram Login), the first provider of the
// provider-independent "social.publish" capability. Facebook, TikTok, LinkedIn and X can implement the
// same capability later; nothing outside this file knows it's Instagram.
//
// Owner setup: an Instagram professional account and an access token with instagram_business_basic +
// instagram_business_content_publish (Meta App Dashboard → Instagram → API setup with Instagram login).
// The token is verified once against the API, then stored encrypted (never shown again, never logged).
//
// publish_image, honestly classified:
//   - anything failing BEFORE media_publish (container creation, processing) → rejected: nothing is public
//   - media_publish timing out or a 5xx → UNKNOWN (it may have been published) → reconcile by looking for
//     the post among the account's recent media; if not found, escalate. Instagram has no idempotency key,
//     so an unknown publication is NEVER blindly re-published.
//   - success → done, with the real media id (ref) and permalink (data): the proof
import { z } from "zod";
import type { ActionContext, ActionOutcome, Connector } from "../types";

const VERSION = "v27.0";
const BASE = `https://graph.instagram.com/${VERSION}`;

export const instagramNet = { fetch: (url: string, init: RequestInit) => fetch(url, init), sleep: (ms: number) => new Promise(r => setTimeout(r, ms)) };

type Res = { ok: boolean; status: number; json: Record<string, unknown> } | { ok: false; status: 0; json: Record<string, unknown> };
async function call(method: "GET" | "POST", path: string, token: string, body?: Record<string, unknown>, timeoutMs = 20_000): Promise<Res> {
  try {
    const res = await instagramNet.fetch(`${BASE}${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs) });
    const json = await res.json().catch(() => ({})) as Record<string, unknown>;
    return { ok: res.ok && !json.error, status: res.status, json };
  } catch { return { ok: false, status: 0, json: {} }; }
}
/** Meta's error text (never contains the token). */
const metaError = (r: Res) => { const e = (r.json.error ?? {}) as { message?: string; code?: number }; return `${e.message ?? `HTTP ${r.status || "no response"}`}${e.code ? ` (code ${e.code})` : ""}`.slice(0, 240); };

const PublishInput = z.object({
  image_url: z.string().url().max(2048).refine(u => u.startsWith("https://"), "The image must be at a public https URL."),
  caption: z.string().min(1).max(2200),
  content_item_id: z.string().max(64).optional(),
}).strict();

export const instagramConnector: Connector = {
  key: "instagram",
  name: "Instagram",
  kind: "marketing",
  reality: "real",
  eventTypes: [],
  async setup(input) {
    const token = String((input as { access_token?: unknown } | null)?.access_token ?? "").trim();
    if (token.length < 20 || /\s/.test(token)) throw new Error("Paste the Instagram access token from the Meta App Dashboard.");
    const me = await call("GET", "/me?fields=user_id,username,account_type", token);
    if (!me.ok || typeof me.json.user_id !== "string" && typeof me.json.user_id !== "number") throw new Error(`Instagram didn't accept the token: ${metaError(me)}`);
    return { config: { ig_user_id: String(me.json.user_id), username: String(me.json.username ?? ""), account_type: String(me.json.account_type ?? "") }, secrets: { access_token: token }, revealOnce: {} };
  },
  actions: {
    "instagram.publish_image": {
      sideEffect: "publish",
      capability: "social.publish",
      idempotency: "none",
      parse: input => PublishInput.parse(input),
      async execute(ctx: ActionContext, input): Promise<ActionOutcome> {
        const token = ctx.secrets.access_token, ig = String(ctx.config.ig_user_id ?? "");
        if (!token || !ig) return { kind: "rejected", retryable: false, code: "NOT_CONNECTED", detail: "The Instagram connection has no account or token." };
        // 1 · container (nothing public yet)
        const c = await call("POST", `/${ig}/media`, token, { image_url: input.image_url, caption: input.caption });
        if (!c.ok || typeof c.json.id !== "string") return { kind: "rejected", retryable: c.status === 0 || c.status >= 500 || c.status === 429, code: "CONTAINER_FAILED", detail: `Instagram couldn't prepare the post: ${metaError(c)}. Nothing was published.` };
        const container = c.json.id;
        // 2 · wait for processing (bounded), still nothing public
        let status = "IN_PROGRESS";
        for (let i = 0; i < 8 && status === "IN_PROGRESS"; i++) {
          await instagramNet.sleep(i === 0 ? 3_000 : 7_000);
          const st = await call("GET", `/${container}?fields=status_code`, token);
          status = st.ok ? String(st.json.status_code ?? "UNKNOWN") : "IN_PROGRESS";
        }
        if (status !== "FINISHED") return { kind: "rejected", retryable: status === "IN_PROGRESS", code: `CONTAINER_${status}`, detail: `Instagram didn't finish processing the image (${status}). Nothing was published.` };
        // 3 · publish — from here an error means we can't know
        const p = await call("POST", `/${ig}/media_publish`, token, { creation_id: container }, 30_000);
        if (p.status === 0 || p.status >= 500) return { kind: "unknown", detail: "Instagram didn't confirm the publication (timeout or server error); it may or may not be live." };
        if (!p.ok || typeof p.json.id !== "string") return { kind: "rejected", retryable: p.status === 429, code: "PUBLISH_REFUSED", detail: `Instagram refused to publish: ${metaError(p)}.` };
        const mediaId = p.json.id;
        const m = await call("GET", `/${mediaId}?fields=permalink,timestamp`, token);
        return { kind: "done", ref: mediaId, detail: "Published on Instagram", data: { media_id: mediaId, permalink: m.ok ? m.json.permalink ?? null : null, timestamp: m.ok ? m.json.timestamp ?? null : null, username: ctx.config.username ?? null } };
      },
      async reconcile(ctx: ActionContext, input): Promise<ActionOutcome | null> {
        const token = ctx.secrets.access_token, ig = String(ctx.config.ig_user_id ?? "");
        const r = await call("GET", `/${ig}/media?fields=id,caption,permalink,timestamp&limit=15`, token);
        if (!r.ok) return null;
        const list = (r.json.data ?? []) as Array<{ id: string; caption?: string; permalink?: string; timestamp?: string }>;
        const hit = list.find(x => (x.caption ?? "").trim() === String(input.caption).trim());
        return hit ? { kind: "done", ref: hit.id, detail: "Found on Instagram during reconciliation", data: { media_id: hit.id, permalink: hit.permalink ?? null, timestamp: hit.timestamp ?? null, username: ctx.config.username ?? null } } : null;
      },
    },
  },
};
