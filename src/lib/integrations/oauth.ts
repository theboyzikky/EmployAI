import "server-only";
// Official OAuth 2.0 authorization-code flows for the providers EmployAI implements. Endpoints are the
// providers' documented ones (checked 2026-11-11):
//   Instagram  (Instagram API with Instagram Login)  https://www.instagram.com/oauth/authorize
//              code → https://api.instagram.com/oauth/access_token → long-lived (60 days)
//              https://graph.instagram.com/access_token (ig_exchange_token), renewed with
//              https://graph.instagram.com/refresh_access_token (ig_refresh_token, token ≥ 24 h old)
//   Google     https://accounts.google.com/o/oauth2/v2/auth · https://oauth2.googleapis.com/token (PKCE)
//   Microsoft  https://login.microsoftonline.com/common/oauth2/v2.0/{authorize,token} (PKCE)
//   Facebook   https://www.facebook.com/v27.0/dialog/oauth · https://graph.facebook.com/v27.0/oauth/access_token
//              (code, then fb_exchange_token → long-lived user token → Page token, which doesn't expire)
//   LinkedIn   https://www.linkedin.com/oauth/v2/authorization · https://www.linkedin.com/oauth/v2/accessToken (60 days)
//   X          https://x.com/i/oauth2/authorize (PKCE) · https://api.x.com/2/oauth2/token (Basic client auth)
//   TikTok     https://www.tiktok.com/v2/auth/authorize/ · https://open.tiktokapis.com/v2/oauth/token/ (client_key)
//   YouTube    the Google flow above, with YouTube scopes
//
// Security:
//  - `state` is 256 random bits, stored only as its SHA-256 (KV, 10 minutes, single use), bound to the
//    business, the provider and the redirect URI; the callback also requires the OWNER's cookie for that
//    business, so a link can't attach someone else's account to a workspace (login CSRF).
//  - Minimum scopes per connector. Granted scopes are compared with the required ones: anything missing
//    leaves the connection "reconnection required" instead of pretending it works.
//  - Tokens are encrypted per business (credentials.ts) and never returned, logged or shown.
//  - Without the provider's client id/secret in the environment, the provider shows "needs developer
//    setup" and no flow starts.
import { createHash, randomBytes } from "node:crypto";
import { getKv } from "@/lib/kv";
import { discoveryRepository } from "@/lib/discovery/store";
import { providerByKey } from "./catalogue";
import { createConnection, IntegrationError, markReauthRequired, ReconnectRequired, registerTokenRefresher, CredentialRefreshFailed } from "./connections";
import { encryptSecrets } from "./credentials";
import type { ConnectionRecord } from "./records";

export type OAuthKind = "instagram" | "google" | "microsoft" | "facebook" | "linkedin" | "x" | "tiktok";
const KINDS: readonly OAuthKind[] = ["instagram", "google", "microsoft", "facebook", "linkedin", "x", "tiktok"];
type Tokens = { access_token: string; refresh_token?: string; expires_in?: number; scopes: string[] | null };

/** Injectable for tests. */
export const oauthNet = { fetch: (url: string, init: RequestInit) => fetch(url, init) };

const env = (k: string) => (process.env[k] ?? "").trim();
const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
async function postForm(url: string, body: Record<string, string>, headers: Record<string, string> = {}): Promise<{ status: number; json: Record<string, unknown> }> {
  try {
    const r = await oauthNet.fetch(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", ...headers }, body: form(body), signal: AbortSignal.timeout(20_000) });
    return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown> };
  } catch { return { status: 0, json: {} }; }
}
async function getJson(url: string, token?: string): Promise<{ status: number; json: Record<string, unknown> }> {
  try {
    const r = await oauthNet.fetch(url, { method: "GET", headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(20_000) });
    return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown> };
  } catch { return { status: 0, json: {} }; }
}
const scopesOf = (v: unknown, sep: RegExp): string[] | null => typeof v === "string" && v ? v.split(sep).map(decodeURIComponent).filter(Boolean) : null;

type FlowSpec = {
  name: string;
  clientIdEnv: string; secretEnv: string;
  authorizeUrl: string;
  /** Name of the client id query parameter (TikTok calls it client_key). */
  clientParam?: string;
  pkce: boolean;
  scopeSep: "," | " ";
  extra: Record<string, string>;
  /** Minimum scopes requested per connector key. */
  scopes: Record<string, string[]>;
  /** The scopes without which the connector can't work; checked against what the provider granted. */
  essential: Record<string, string[]>;
  exchange(code: string, redirectUri: string, verifier: string | null): Promise<Tokens | { error: string }>;
  refresh(secrets: Record<string, string>, expiresAt: string | null): Promise<Tokens | { error: "revoked" | "expired" | "unavailable" } | null>;
};

/** How the client authenticates at the token endpoint: in the form body (most) or HTTP Basic (X). */
type ClientAuth = { idEnv: string; secretEnv: string; idParam?: string; basic?: boolean };
const clientCreds = (c: ClientAuth): { body: Record<string, string>; headers: Record<string, string> } => c.basic
  ? { body: {}, headers: { Authorization: `Basic ${Buffer.from(`${env(c.idEnv)}:${env(c.secretEnv)}`).toString("base64")}` } }
  : { body: { [c.idParam ?? "client_id"]: env(c.idEnv), client_secret: env(c.secretEnv) }, headers: {} };
const standardExchange = (tokenUrl: string, idEnv: string, secretEnv: string, o: { idParam?: string; basic?: boolean; scopeSep?: RegExp } = {}) => async (code: string, redirectUri: string, verifier: string | null): Promise<Tokens | { error: string }> => {
  const c = clientCreds({ idEnv, secretEnv, ...o });
  const r = await postForm(tokenUrl, { grant_type: "authorization_code", code, redirect_uri: redirectUri, ...c.body, ...(verifier ? { code_verifier: verifier } : {}) }, c.headers);
  if (typeof r.json.access_token !== "string") return { error: String(r.json.error_description ?? r.json.error ?? `HTTP ${r.status || "no response"}`).slice(0, 200) };
  return { access_token: r.json.access_token, refresh_token: typeof r.json.refresh_token === "string" ? r.json.refresh_token : undefined, expires_in: Number(r.json.expires_in) || undefined, scopes: scopesOf(r.json.scope, o.scopeSep ?? /\s+/) };
};
const standardRefresh = (tokenUrl: string, idEnv: string, secretEnv: string, o: { idParam?: string; basic?: boolean } = {}) => async (secrets: Record<string, string>, expiresAt: string | null) => {
  if (expiresAt && Date.parse(expiresAt) - Date.now() > 120_000) return null;                 // still fresh
  if (!secrets.refresh_token) return expiresAt && Date.parse(expiresAt) > Date.now() ? null : { error: "expired" as const };
  const c = clientCreds({ idEnv, secretEnv, ...o });
  const r = await postForm(tokenUrl, { grant_type: "refresh_token", refresh_token: secrets.refresh_token, ...c.body }, c.headers);
  if (typeof r.json.access_token === "string") return { access_token: r.json.access_token, refresh_token: typeof r.json.refresh_token === "string" ? r.json.refresh_token : secrets.refresh_token, expires_in: Number(r.json.expires_in) || undefined, scopes: scopesOf(r.json.scope, /\s+/) };
  return { error: r.json.error === "invalid_grant" ? "revoked" as const : "unavailable" as const };
};

const FLOWS: Record<OAuthKind, FlowSpec> = {
  instagram: {
    name: "Instagram", clientIdEnv: "INSTAGRAM_APP_ID", secretEnv: "INSTAGRAM_APP_SECRET",
    authorizeUrl: "https://www.instagram.com/oauth/authorize", pkce: false, scopeSep: ",", extra: { response_type: "code" },
    scopes: { instagram: ["instagram_business_basic", "instagram_business_content_publish"] },
    essential: { instagram: ["instagram_business_content_publish"] },
    async exchange(code, redirectUri) {
      const r = await postForm("https://api.instagram.com/oauth/access_token", { client_id: env("INSTAGRAM_APP_ID"), client_secret: env("INSTAGRAM_APP_SECRET"), grant_type: "authorization_code", redirect_uri: redirectUri, code });
      const row = (Array.isArray(r.json.data) ? r.json.data[0] : r.json) as Record<string, unknown> | undefined;
      if (typeof row?.access_token !== "string") return { error: String((r.json as { error_message?: unknown }).error_message ?? `HTTP ${r.status || "no response"}`).slice(0, 200) };
      const granted = Array.isArray(row.permissions) ? (row.permissions as string[]) : scopesOf(row.permissions, /,/);
      // Exchange the short-lived token for a long-lived one (server side only; never logged).
      const ll = await getJson(`https://graph.instagram.com/access_token?${form({ grant_type: "ig_exchange_token", client_secret: env("INSTAGRAM_APP_SECRET"), access_token: row.access_token })}`);
      if (typeof ll.json.access_token !== "string") return { error: "Instagram didn't issue a long-lived token." };
      return { access_token: ll.json.access_token, expires_in: Number(ll.json.expires_in) || undefined, scopes: granted };
    },
    async refresh(secrets, expiresAt) {
      if (!expiresAt) return null;
      const left = Date.parse(expiresAt) - Date.now();
      if (left <= 0) return { error: "expired" };
      // Renew when under 10 days remain and the token is at least a day old (Meta's rule).
      if (left > 10 * 86_400_000) return null;
      const r = await getJson(`https://graph.instagram.com/refresh_access_token?${form({ grant_type: "ig_refresh_token", access_token: secrets.access_token ?? "" })}`);
      if (typeof r.json.access_token === "string") return { access_token: r.json.access_token, expires_in: Number(r.json.expires_in) || undefined, scopes: null };
      const code = Number((r.json.error as { code?: unknown } | undefined)?.code);
      return code === 190 ? { error: "revoked" } : null;                                           // otherwise keep using it until expiry
    },
  },
  google: {
    name: "Google", clientIdEnv: "GOOGLE_OAUTH_CLIENT_ID", secretEnv: "GOOGLE_OAUTH_CLIENT_SECRET",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth", pkce: true, scopeSep: " ",
    extra: { response_type: "code", access_type: "offline", prompt: "consent", include_granted_scopes: "true" },
    scopes: { gmail: ["openid", "email", "https://www.googleapis.com/auth/gmail.send"], youtube: ["https://www.googleapis.com/auth/youtube.readonly", "https://www.googleapis.com/auth/youtube.upload"] },
    essential: { gmail: ["https://www.googleapis.com/auth/gmail.send"], youtube: ["https://www.googleapis.com/auth/youtube.upload"] },
    exchange: standardExchange("https://oauth2.googleapis.com/token", "GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET"),
    refresh: standardRefresh("https://oauth2.googleapis.com/token", "GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET"),
  },
  microsoft: {
    name: "Microsoft", clientIdEnv: "MICROSOFT_OAUTH_CLIENT_ID", secretEnv: "MICROSOFT_OAUTH_CLIENT_SECRET",
    authorizeUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize", pkce: true, scopeSep: " ",
    extra: { response_type: "code", response_mode: "query", prompt: "select_account" },
    scopes: { outlook: ["offline_access", "User.Read", "Mail.Send"] },
    essential: { outlook: ["Mail.Send"] },
    exchange: standardExchange("https://login.microsoftonline.com/common/oauth2/v2.0/token", "MICROSOFT_OAUTH_CLIENT_ID", "MICROSOFT_OAUTH_CLIENT_SECRET"),
    refresh: standardRefresh("https://login.microsoftonline.com/common/oauth2/v2.0/token", "MICROSOFT_OAUTH_CLIENT_ID", "MICROSOFT_OAUTH_CLIENT_SECRET"),
  },
  facebook: {
    name: "Facebook", clientIdEnv: "FACEBOOK_APP_ID", secretEnv: "FACEBOOK_APP_SECRET",
    authorizeUrl: "https://www.facebook.com/v27.0/dialog/oauth", pkce: false, scopeSep: ",", extra: { response_type: "code" },
    scopes: { facebook: ["pages_show_list", "pages_read_engagement", "pages_manage_posts"] },
    essential: { facebook: ["pages_show_list", "pages_manage_posts"] },
    async exchange(code, redirectUri) {
      const g = "https://graph.facebook.com/v27.0";
      const short = await getJson(`${g}/oauth/access_token?${form({ client_id: env("FACEBOOK_APP_ID"), redirect_uri: redirectUri, client_secret: env("FACEBOOK_APP_SECRET"), code })}`);
      if (typeof short.json.access_token !== "string") return { error: String((short.json.error as { message?: string } | undefined)?.message ?? `HTTP ${short.status || "no response"}`).slice(0, 200) };
      // Long-lived user token (about 60 days); the Page token derived from it has no expiry.
      const long = await getJson(`${g}/oauth/access_token?${form({ grant_type: "fb_exchange_token", client_id: env("FACEBOOK_APP_ID"), client_secret: env("FACEBOOK_APP_SECRET"), fb_exchange_token: short.json.access_token })}`);
      const token = typeof long.json.access_token === "string" ? long.json.access_token : short.json.access_token;
      const perms = await getJson(`${g}/me/permissions`, token);
      const granted = Array.isArray(perms.json.data) ? (perms.json.data as Array<{ permission: string; status: string }>).filter(p => p.status === "granted").map(p => p.permission) : null;
      return { access_token: token, scopes: granted };
    },
    async refresh() { return null; },                    // Page tokens have no expiry; revocation is detected at use
  },
  linkedin: {
    name: "LinkedIn", clientIdEnv: "LINKEDIN_CLIENT_ID", secretEnv: "LINKEDIN_CLIENT_SECRET",
    authorizeUrl: "https://www.linkedin.com/oauth/v2/authorization", pkce: false, scopeSep: " ", extra: { response_type: "code" },
    scopes: { linkedin: ["openid", "profile", "w_member_social"] },
    essential: { linkedin: ["w_member_social"] },
    exchange: standardExchange("https://www.linkedin.com/oauth/v2/accessToken", "LINKEDIN_CLIENT_ID", "LINKEDIN_CLIENT_SECRET", { scopeSep: /[\s,]+/ }),
    // Programmatic refresh is only for some LinkedIn partners: without it the owner reconnects every 60 days.
    refresh: standardRefresh("https://www.linkedin.com/oauth/v2/accessToken", "LINKEDIN_CLIENT_ID", "LINKEDIN_CLIENT_SECRET"),
  },
  x: {
    name: "X", clientIdEnv: "X_CLIENT_ID", secretEnv: "X_CLIENT_SECRET",
    authorizeUrl: "https://x.com/i/oauth2/authorize", pkce: true, scopeSep: " ", extra: { response_type: "code" },
    scopes: { xcom: ["tweet.read", "tweet.write", "users.read", "media.write", "offline.access"] },
    essential: { xcom: ["tweet.write"] },
    exchange: standardExchange("https://api.x.com/2/oauth2/token", "X_CLIENT_ID", "X_CLIENT_SECRET", { basic: true }),
    refresh: standardRefresh("https://api.x.com/2/oauth2/token", "X_CLIENT_ID", "X_CLIENT_SECRET", { basic: true }),
  },
  tiktok: {
    name: "TikTok", clientIdEnv: "TIKTOK_CLIENT_KEY", secretEnv: "TIKTOK_CLIENT_SECRET", clientParam: "client_key",
    authorizeUrl: "https://www.tiktok.com/v2/auth/authorize/", pkce: false, scopeSep: ",", extra: { response_type: "code" },
    scopes: { tiktok: ["user.info.basic", "video.publish"] },
    essential: { tiktok: ["video.publish"] },
    exchange: standardExchange("https://open.tiktokapis.com/v2/oauth/token/", "TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET", { idParam: "client_key", scopeSep: /[\s,]+/ }),
    refresh: standardRefresh("https://open.tiktokapis.com/v2/oauth/token/", "TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET", { idParam: "client_key" }),
  },
};

export const isOAuthKind = (k: string): k is OAuthKind => (KINDS as readonly string[]).includes(k);
/** Is the provider's developer app configured on this server? */
export const oauthConfigured = (k: OAuthKind) => !!env(FLOWS[k].clientIdEnv) && !!env(FLOWS[k].secretEnv);
export const oauthEnvNames = (k: OAuthKind) => [FLOWS[k].clientIdEnv, FLOWS[k].secretEnv];
export const requiredScopes = (k: OAuthKind, connector: string) => FLOWS[k].scopes[connector] ?? [];

type Pending = { b: string; p: string; c: string; k: OAuthKind; v: string | null; r: string; ret: string; rep: string | null };
const STATE_TTL_MS = 10 * 60_000;
const stateKey = (state: string) => `oauth:${createHash("sha256").update(state).digest("hex")}`;
const b64url = (b: Buffer) => b.toString("base64url");

/** Public base URL for callbacks: EMPLOYAI_PUBLIC_URL when set, else the request's own origin. */
export function callbackUrl(kind: OAuthKind, origin: string): string {
  const base = (env("EMPLOYAI_PUBLIC_URL") || origin).replace(/\/+$/, "");
  return `${base}/api/oauth/${kind}/callback`;
}

/** Start: returns the provider's authorization URL. The owner is redirected there by the browser. */
export async function startOAuth(businessId: string, providerKey: string, o: { origin: string; returnTo: string; replaceId?: string | null }): Promise<string> {
  const p = providerByKey(providerKey);
  if (!p || p.support !== "implemented" || !p.oauth || !p.connector) throw new IntegrationError("NOT_SUPPORTED", 400, "This provider can't be connected with OAuth.");
  const flow = FLOWS[p.oauth];
  if (!oauthConfigured(p.oauth)) throw new IntegrationError("SETUP_REQUIRED", 409, `${p.name} needs developer setup on this server first (${oauthEnvNames(p.oauth).join(", ")}).`);
  const state = b64url(randomBytes(32));
  const verifier = flow.pkce ? b64url(randomBytes(48)) : null;
  const redirectUri = callbackUrl(p.oauth, o.origin);
  const pending: Pending = { b: businessId, p: p.key, c: p.connector, k: p.oauth, v: verifier, r: redirectUri, ret: safeReturn(businessId, o.returnTo), rep: o.replaceId ?? null };
  await getKv().set(stateKey(state), JSON.stringify(pending), STATE_TTL_MS);
  const q: Record<string, string> = { [flow.clientParam ?? "client_id"]: env(flow.clientIdEnv), redirect_uri: redirectUri, scope: requiredScopes(p.oauth, p.connector).join(flow.scopeSep), state, ...flow.extra };
  if (verifier) { q.code_challenge = b64url(createHash("sha256").update(verifier).digest()); q.code_challenge_method = "S256"; }
  return `${flow.authorizeUrl}?${form(q)}`;
}

/** Only same-site workspace paths of THIS business are valid return targets (no open redirect). */
function safeReturn(businessId: string, r: string): string {
  const fallback = `/w/${businessId}/integrations`;
  return typeof r === "string" && r.startsWith(`/w/${businessId}/`) && !r.includes("//") && !r.includes("\\") && r.length < 200 ? r : fallback;
}

/** Read the pending flow for a state WITHOUT consuming it (the callback checks the owner first). */
export async function peekState(state: string): Promise<Pending | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(state)) return null;
  const raw = await getKv().get(stateKey(state)).catch(() => null);
  try { return raw ? (JSON.parse(raw) as Pending) : null; } catch { return null; }
}

/**
 * Callback: consume the state (single use), exchange the code, let the connector verify the account,
 * store the connection encrypted. Returns where to send the owner back, with an outcome flag.
 */
export async function completeOAuth(kind: OAuthKind, state: string, pending: Pending, q: { code: string | null; error: string | null }): Promise<{ returnTo: string; outcome: string }> {
  await getKv().del(stateKey(state)).catch(() => undefined);
  const back = (outcome: string) => ({ returnTo: pending.ret, outcome });
  if (pending.k !== kind) return back("error");
  if (q.error || !q.code) return back(q.error === "access_denied" ? "denied" : "error");
  const flow = FLOWS[kind];
  const t = await flow.exchange(q.code, pending.r, pending.v);
  if ("error" in t) return back("error");
  const required = requiredScopes(kind, pending.c);
  // Providers report scopes in their own forms (Graph may prefix its URL); compare case-insensitively.
  const has = (g: string, want: string) => g.toLowerCase() === want.toLowerCase() || g.toLowerCase().endsWith(`/${want.toLowerCase()}`);
  const missing = t.scopes ? (flow.essential[pending.c] ?? []).filter(w => !t.scopes!.some(g => has(g, w))) : [];
  const provider = providerByKey(pending.p)!;
  const { view } = await createConnection(pending.b, {
    connector: pending.c, label: provider.name, replaceId: pending.rep,
    setup: { oauth: { access_token: t.access_token, refresh_token: t.refresh_token ?? null } },
    auth: { method: "oauth", account: null, scopes: t.scopes ?? required, expires_at: t.expires_in ? new Date(Date.now() + t.expires_in * 1000).toISOString() : null, refreshable: !!t.refresh_token || kind === "instagram" },
  });
  if (missing.length) { await markReauthRequired(pending.b, view.id, `Permission not granted: ${missing.join(", ")}. Reconnect and allow every requested permission.`); return back("insufficient"); }
  return back("connected");
}

async function storeSecrets(businessId: string, connectionId: string, secrets: Record<string, string>, auth?: Partial<ConnectionRecord["auth"]>): Promise<ConnectionRecord | null> {
  return discoveryRepository().transact(businessId, s => {
    const c = ((s.connections ?? {})[businessId] ?? []).find(x => x.id === connectionId);
    if (!c) return null;
    c.secrets = encryptSecrets(businessId, connectionId, secrets);
    if (auth && c.auth) c.auth = { ...c.auth, ...auth };
    c.updated_at = new Date().toISOString();
    return { ...c };
  });
}

// Renew OAuth tokens before use (called by loadConnectionForUse for every OAuth connection).
registerTokenRefresher(async (businessId, record, secrets) => {
  const p = [...Object.entries(FLOWS)].find(([, f]) => Object.keys(f.scopes).includes(record.connector));
  if (!p) return { record, secrets };
  const r = await p[1].refresh(secrets, record.auth?.expires_at ?? null);
  if (r === null) return { record, secrets };
  if ("error" in r) {
    if (r.error === "unavailable") throw new CredentialRefreshFailed(`${p[1].name} couldn't renew the access token right now.`);
    const why = r.error === "revoked" ? `${p[1].name} revoked EmployAI's access.` : `The ${p[1].name} connection expired.`;
    await markReauthRequired(businessId, record.id, `${why} Reconnect to continue.`);
    throw new ReconnectRequired(`${why} Reconnect it in Integrations. Nothing was sent.`);
  }
  const next = { ...secrets, access_token: r.access_token, ...(r.refresh_token ? { refresh_token: r.refresh_token } : {}) };
  const updated = await storeSecrets(businessId, record.id, next, { expires_at: r.expires_in ? new Date(Date.now() + r.expires_in * 1000).toISOString() : record.auth?.expires_at ?? null, ...(r.scopes ? { scopes: r.scopes } : {}) });
  return { record: updated ?? record, secrets: next };
});
