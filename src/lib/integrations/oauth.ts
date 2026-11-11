import "server-only";
// Official OAuth 2.0 authorization-code flows for the providers EmployAI implements. Endpoints are the
// providers' documented ones (checked 2026-11-11):
//   Instagram  (Instagram API with Instagram Login)  https://www.instagram.com/oauth/authorize
//              code → https://api.instagram.com/oauth/access_token → long-lived (60 days)
//              https://graph.instagram.com/access_token (ig_exchange_token), renewed with
//              https://graph.instagram.com/refresh_access_token (ig_refresh_token, token ≥ 24 h old)
//   Google     https://accounts.google.com/o/oauth2/v2/auth · https://oauth2.googleapis.com/token (PKCE)
//   Microsoft  https://login.microsoftonline.com/common/oauth2/v2.0/{authorize,token} (PKCE)
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

export type OAuthKind = "instagram" | "google" | "microsoft";
type Tokens = { access_token: string; refresh_token?: string; expires_in?: number; scopes: string[] | null };

/** Injectable for tests. */
export const oauthNet = { fetch: (url: string, init: RequestInit) => fetch(url, init) };

const env = (k: string) => (process.env[k] ?? "").trim();
const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
async function postForm(url: string, body: Record<string, string>): Promise<{ status: number; json: Record<string, unknown> }> {
  try {
    const r = await oauthNet.fetch(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body: form(body), signal: AbortSignal.timeout(20_000) });
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

const standardExchange = (tokenUrl: string, idEnv: string, secretEnv: string) => async (code: string, redirectUri: string, verifier: string | null): Promise<Tokens | { error: string }> => {
  const r = await postForm(tokenUrl, { grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: env(idEnv), client_secret: env(secretEnv), ...(verifier ? { code_verifier: verifier } : {}) });
  if (typeof r.json.access_token !== "string") return { error: String(r.json.error_description ?? r.json.error ?? `HTTP ${r.status || "no response"}`).slice(0, 200) };
  return { access_token: r.json.access_token, refresh_token: typeof r.json.refresh_token === "string" ? r.json.refresh_token : undefined, expires_in: Number(r.json.expires_in) || undefined, scopes: scopesOf(r.json.scope, /\s+/) };
};
const standardRefresh = (tokenUrl: string, idEnv: string, secretEnv: string) => async (secrets: Record<string, string>, expiresAt: string | null) => {
  if (expiresAt && Date.parse(expiresAt) - Date.now() > 120_000) return null;                 // still fresh
  if (!secrets.refresh_token) return { error: "expired" as const };
  const r = await postForm(tokenUrl, { grant_type: "refresh_token", refresh_token: secrets.refresh_token, client_id: env(idEnv), client_secret: env(secretEnv) });
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
    scopes: { gmail: ["openid", "email", "https://www.googleapis.com/auth/gmail.send"] },
    essential: { gmail: ["https://www.googleapis.com/auth/gmail.send"] },
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
};

export const isOAuthKind = (k: string): k is OAuthKind => k === "instagram" || k === "google" || k === "microsoft";
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
  const q: Record<string, string> = { client_id: env(flow.clientIdEnv), redirect_uri: redirectUri, scope: requiredScopes(p.oauth, p.connector).join(flow.scopeSep), state, ...flow.extra };
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
