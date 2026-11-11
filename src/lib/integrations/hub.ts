import "server-only";
// The connections hub: every provider in the catalogue with its REAL status for one business, the
// permission matrix per connection, and the workforce's readiness. Never returns secrets.
import { discoveryRepository, type BusinessRecord } from "@/lib/discovery/store";
import { workforceReadiness, type Readiness } from "@/lib/workforce/readiness";
import { CAPABILITY_DEFS, PERMISSIONS, PROVIDERS, provides, type Permission, type ProviderCategory, type ProviderSupport } from "./catalogue";
import { connectionPermissions } from "./connections";
import { isOAuthKind, oauthConfigured, oauthEnvNames } from "./oauth";
import type { ConnectionRecord } from "./records";
import { connectorFor } from "./registry";

export type HubStatus = "connected" | "not_connected" | "expired" | "reauth_required" | "disabled" | "not_implemented" | "unsupported";
export const HUB_STATUS_LABEL: Record<HubStatus, string> = {
  connected: "Connected", not_connected: "Not connected", expired: "Connection expired", reauth_required: "Reconnection required",
  disabled: "Paused", not_implemented: "Available but not yet implemented", unsupported: "Unsupported",
};

export type HubConnection = {
  id: string; status: HubStatus; account: string | null; method: string | null; expiresAt: string | null; problem: string | null; checkedAt: string | null; note: string | null;
  permissions: Array<{ permission: Permission; label: string; description: string }>;
  /** employee id → the permission categories it holds on this connection */
  grants: Record<string, Permission[]>;
};
export type HubProvider = {
  key: string; name: string; category: ProviderCategory; support: ProviderSupport; setup: string;
  /** What the provider offers; `working` only when THIS build's connector really implements it. */
  capabilities: Array<{ label: string; working: boolean }>;
  status: HubStatus;
  canOAuth: boolean; canToken: boolean; canWebhook: boolean;
  /** Environment variables missing on this server before the OAuth flow can run. */
  setupMissing: string[];
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

function statusOf(c: ConnectionRecord): HubStatus {
  const expired = !!c.auth?.expires_at && Date.parse(c.auth.expires_at) <= Date.now();
  if (c.status === "active") return expired && !c.auth?.refreshable ? "expired" : "connected";
  if (c.status === "reauth_required") return expired ? "expired" : "reauth_required";
  if (c.status === "disabled") return "disabled";
  return "not_connected";
}
const RANK: HubStatus[] = ["connected", "reauth_required", "expired", "disabled", "not_connected"];

export async function buildHubView(b: BusinessRecord): Promise<HubView> {
  return discoveryRepository().readState(b.id, s => {
    const conns = (s.connections ?? {})[b.id] ?? [];
    const wf = s.businesses[b.id]?.workforce ?? null;
    const providers: HubProvider[] = PROVIDERS.map(p => {
      const connector = p.connector ? connectorFor(p.connector) : null;
      const implemented = p.support === "implemented" && !!connector;
      const mine = implemented ? conns.filter(c => c.connector === p.connector) : [];
      const live = mine.filter(c => c.status !== "disconnected");
      const offered = connector ? connectionPermissions(connector) : [];
      const connections: HubConnection[] = live.map(c => ({
        id: c.id, status: statusOf(c), account: c.auth?.account ?? (c.config as { username?: string; email?: string }).username ?? (c.config as { email?: string }).email ?? null,
        method: c.auth?.method ?? null, expiresAt: c.auth?.expires_at ?? null, problem: c.auth?.problem ?? null, checkedAt: c.auth?.checked_at ?? null,
        note: typeof c.config.activation_detail === "string" ? c.config.activation_detail : null,
        permissions: offered.map(o => ({ permission: o.permission, label: o.label, description: PERMISSIONS[o.permission].description })),
        grants: Object.fromEntries((wf?.employees ?? []).map(e => [e.id, offered.filter(o =>
          (o.actions.length > 0 && o.actions.every(a => c.grants.some(g => g.agent === e.id && g.actions.includes(a)))) ||
          (o.actions.length === 0 && o.viaRoutes && c.routes.some(r => r.agent === e.id && r.event_type === "message.received")),
        ).map(o => o.permission)])),
      }));
      const status: HubStatus = p.support === "unsupported" ? "unsupported" : !implemented ? "not_implemented"
        : connections.length ? RANK.find(r => connections.some(c => c.status === r)) ?? "not_connected" : "not_connected";
      const canOAuth = implemented && p.auth.includes("oauth") && !!p.oauth;
      return {
        key: p.key, name: p.name, category: p.category, support: implemented ? "implemented" : p.support === "implemented" ? "not_implemented" : p.support, setup: p.setup,
        capabilities: p.capabilities.map(c => ({
          label: CAPABILITY_DEFS[c]?.label ?? c,
          working: !!connector && (Object.values(connector.actions).some(a => provides(a, c)) || (CAPABILITY_DEFS[c]?.permission === "read_messages" && connector.eventTypes.length > 0)),
        })),
        status, canOAuth, canToken: implemented && p.auth.includes("token"), canWebhook: implemented && p.auth.includes("signed_webhook"),
        setupMissing: canOAuth && p.oauth && isOAuthKind(p.oauth) && !oauthConfigured(p.oauth) ? oauthEnvNames(p.oauth) : [],
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
