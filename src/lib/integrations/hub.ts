import "server-only";
// The connections hub: every provider in the catalogue with its REAL status for one business, what is
// really implemented for it, the permission matrix per connection, and the workforce's readiness.
// Never returns secrets.
import { discoveryRepository, type BusinessRecord } from "@/lib/discovery/store";
import { workforceReadiness, type Readiness } from "@/lib/workforce/readiness";
import { CAPABILITY_DEFS, PERMISSIONS, PROVIDERS, provides, type Permission, type ProviderCategory, type ProviderSupport } from "./catalogue";
import { connectionPermissions, heldPermissions } from "./connections";
import { isOAuthKind, oauthConfigured, oauthEnvNames, registeredCallbackUrl } from "./oauth";
import type { ConnectionRecord } from "./records";
import { connectorFor } from "./registry";

/**
 *  connected         an account is connected and usable
 *  reauth_required   connected before, but the provider refused, revoked or expired the access
 *  ready_to_connect  Connect redirects to the provider's own sign-in and consent page now
 *  setup_required    the OAuth flow exists, but this server has no developer app credentials for it yet
 *  not_connected     connectable without OAuth (a bot token, a signed webhook) and not connected
 *  disabled          paused by the owner
 *  not_implemented   listed, but no connector exists in this build
 *  unsupported       no official way to automate it
 */
export type HubStatus = "connected" | "reauth_required" | "ready_to_connect" | "setup_required" | "not_connected" | "disabled" | "not_implemented" | "unsupported";
export const HUB_STATUS_LABEL: Record<HubStatus, string> = {
  connected: "Connected", reauth_required: "Reconnection required", ready_to_connect: "Ready to connect", setup_required: "Developer setup required",
  not_connected: "Not connected", disabled: "Paused", not_implemented: "Available but not implemented", unsupported: "Unsupported",
};

export type HubConnection = {
  id: string; status: "connected" | "reauth_required" | "disabled"; expired: boolean;
  account: string | null; method: string | null; expiresAt: string | null; problem: string | null; checkedAt: string | null; note: string | null;
  permissions: Array<{ permission: Permission; label: string; description: string }>;
  /** employee id → the permission categories the OWNER granted it on this connection */
  grants: Record<string, Permission[]>;
};
/** What is really true for this provider, step by step (never inferred from the button existing). */
export type HubChecklist = {
  /** null = this provider doesn't connect with OAuth */
  oauthImplemented: boolean | null;
  credentialsConfigured: boolean | null;
  accountConnected: boolean;
  dataAccess: string[];
  actions: string[];
  /** Actions run by the durable background worker (scheduled, retried safely, with or without a browser). */
  backgroundAutomation: boolean;
};
export type HubProvider = {
  key: string; name: string; category: ProviderCategory; support: ProviderSupport; setup: string;
  /** What the provider offers; `working` only when THIS build's connector really implements it. */
  capabilities: Array<{ label: string; working: boolean }>;
  status: HubStatus;
  /** Connect redirects to the provider's consent page (OAuth configured on this server). */
  oauthReady: boolean;
  canOAuth: boolean; canWebhook: boolean;
  /** A bot token is the provider's own connection method (Telegram). */
  canToken: boolean;
  /** Developer-only fallback while the OAuth app isn't set up (a token generated in the provider's console). */
  developerToken: boolean;
  /** Environment variables missing on this server before the OAuth flow can run. */
  setupMissing: string[];
  /** The callback URL to register with the provider (null until EMPLOYAI_PUBLIC_URL is an https address). */
  callbackUrl: string | null;
  callbackPath: string | null;
  checklist: HubChecklist;
  /** The most recent failed connection attempt (last 24 h, after the last success), in the provider's words. */
  lastFailure: { at: string; outcome: string; reason: string } | null;
  connections: HubConnection[];
  /** A disconnected connection that a new connect should reuse (keeps its history). */
  reuseId: string | null;
};
export type HubView = {
  businessId: string;
  publicUrl: boolean;
  providers: HubProvider[];
  employees: Array<{ id: string; name: string; title: string; status: string }>;
  readiness: Readiness | null;
};

function statusOf(c: ConnectionRecord): HubConnection["status"] {
  const expired = !!c.auth?.expires_at && Date.parse(c.auth.expires_at) <= Date.now();
  if (c.status === "active") return expired && !c.auth?.refreshable ? "reauth_required" : "connected";
  if (c.status === "reauth_required") return "reauth_required";
  return "disabled";
}
const RANK: HubConnection["status"][] = ["connected", "reauth_required", "disabled"];

export async function buildHubView(b: BusinessRecord): Promise<HubView> {
  return discoveryRepository().readState(b.id, s => {
    const conns = (s.connections ?? {})[b.id] ?? [];
    const events = (s.activity_events ?? {})[b.id] ?? [];
    const wf = s.businesses[b.id]?.workforce ?? null;
    const providers: HubProvider[] = PROVIDERS.map(p => {
      const connector = p.connector ? connectorFor(p.connector) : null;
      const implemented = p.support === "implemented" && !!connector;
      const mine = implemented ? conns.filter(c => c.connector === p.connector) : [];
      const live = mine.filter(c => c.status !== "disconnected");
      const offered = connector ? connectionPermissions(connector) : [];
      const connections: HubConnection[] = live.map(c => ({
        id: c.id, status: statusOf(c), expired: !!c.auth?.expires_at && Date.parse(c.auth.expires_at) <= Date.now(),
        account: c.auth?.account ?? (c.config as { username?: string; email?: string }).username ?? (c.config as { email?: string }).email ?? null,
        method: c.auth?.method ?? null, expiresAt: c.auth?.expires_at ?? null, problem: c.auth?.problem ?? null, checkedAt: c.auth?.checked_at ?? null,
        note: typeof c.config.activation_detail === "string" ? c.config.activation_detail : null,
        permissions: offered.map(o => ({ permission: o.permission, label: o.label, description: PERMISSIONS[o.permission].description })),
        grants: connector ? Object.fromEntries((wf?.employees ?? []).map(e => [e.id, heldPermissions(c, connector, e.id)])) : {},
      }));
      const canOAuth = implemented && p.auth.includes("oauth") && !!p.oauth && isOAuthKind(p.oauth);
      const oauthReady = canOAuth && oauthConfigured(p.oauth!);
      const status: HubStatus = p.support === "unsupported" ? "unsupported" : !implemented ? "not_implemented"
        : connections.length ? RANK.find(r => connections.some(c => c.status === r))!
        : canOAuth ? (oauthReady ? "ready_to_connect" : "setup_required")
        : "not_connected";
      const works = (p.works ?? []).map(c => CAPABILITY_DEFS[c]?.label ?? c);
      const lastOk = mine.map(c => c.updated_at).sort().pop() ?? "";
      const since = new Date(Date.now() - 86_400_000).toISOString();
      const failure = [...events].reverse().find(e => e.type === "connection.oauth_failed" && e.subject === `provider:${p.key}` && e.created_at > since && e.created_at > lastOk);
      const fp = failure?.payload as { reason?: unknown } | undefined;
      return {
        key: p.key, name: p.name, category: p.category, support: implemented ? "implemented" : p.support === "implemented" ? "not_implemented" : p.support, setup: p.setup,
        capabilities: p.capabilities.map(c => ({
          label: CAPABILITY_DEFS[c]?.label ?? c,
          working: !!connector && (Object.values(connector.actions).some(a => provides(a, c)) || (CAPABILITY_DEFS[c]?.permission === "read_messages" && connector.eventTypes.length > 0)),
        })),
        status, oauthReady, canOAuth,
        canToken: implemented && !canOAuth && p.auth.includes("token"),
        developerToken: implemented && canOAuth && !oauthReady && p.auth.includes("token"),
        canWebhook: implemented && p.auth.includes("signed_webhook"),
        setupMissing: canOAuth && !oauthReady ? oauthEnvNames(p.oauth!) : [],
        callbackUrl: canOAuth ? registeredCallbackUrl(p.oauth!) : null,
        callbackPath: canOAuth ? `/api/oauth/${p.oauth}/callback` : null,
        checklist: {
          oauthImplemented: canOAuth ? true : null,
          credentialsConfigured: canOAuth ? oauthReady : null,
          accountConnected: connections.some(c => c.status === "connected"),
          dataAccess: implemented ? p.reads ?? [] : [],
          actions: implemented ? works : [],
          backgroundAutomation: implemented && !!connector && Object.keys(connector.actions).length > 0,
        },
        lastFailure: failure ? { at: failure.created_at, outcome: failure.status, reason: typeof fp?.reason === "string" ? fp.reason : "The connection didn't complete." } : null,
        connections, reuseId: mine.find(c => c.status === "disconnected")?.id ?? null,
      };
    });
    const base = (process.env.EMPLOYAI_PUBLIC_URL ?? "").trim();
    return {
      businessId: b.id, publicUrl: /^https:\/\//.test(base), providers,
      employees: (wf?.employees ?? []).map(e => ({ id: e.id, name: e.name, title: e.title, status: e.status })),
      readiness: workforceReadiness(s, b.id),
    };
  });
}

/** For the Workforce page: how each provider can be connected from a "Connect" button right now. */
export type ConnectMode = "oauth" | "setup_required" | "token" | "webhook" | "unavailable";
export function connectModes(): Record<string, ConnectMode> {
  return Object.fromEntries(PROVIDERS.map(p => {
    const implemented = p.support === "implemented" && !!(p.connector && connectorFor(p.connector));
    if (!implemented) return [p.key, "unavailable"];
    if (p.auth.includes("oauth") && p.oauth && isOAuthKind(p.oauth)) return [p.key, oauthConfigured(p.oauth) ? "oauth" : "setup_required"];
    return [p.key, p.auth.includes("token") ? "token" : p.auth.includes("signed_webhook") ? "webhook" : "unavailable"];
  }));
}
