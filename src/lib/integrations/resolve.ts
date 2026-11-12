// Capability resolution: an employee asks for a CAPABILITY ("publish_social_post", "send_email"); this
// resolves it to an authorised connection and action of this business, or says exactly what is missing.
// Employees are never tied to a provider: whichever connected account offers the capability and grants
// it to the employee is used. Pure (reads the state it's given), so it runs inside commits and views.
import type { DevState } from "@/lib/discovery/store";
import { CAPABILITY_DEFS, PROVIDERS, providerForConnector, provides } from "./catalogue";
import type { ConnectionRecord } from "./records";
import { connectorFor } from "./registry";

export type ProviderRef = { key: string; name: string };
export type Resolution =
  | { state: "built_in"; label: string }
  | { state: "ready"; connectionId: string; connector: string; action: string; account: string | null; provider: ProviderRef }
  | { state: "needs_permission"; connectionId: string; connector: string; account: string | null; provider: ProviderRef }
  | { state: "reconnect"; connectionId: string; connector: string; provider: ProviderRef; problem: string | null }
  | { state: "not_connected"; providers: ProviderRef[] }
  | { state: "not_built"; providers: ProviderRef[] };

const refOf = (c: ConnectionRecord): ProviderRef => { const p = providerForConnector(c.connector); return { key: p?.key ?? c.connector, name: p?.name ?? c.connector }; };
const accountOf = (c: ConnectionRecord) => c.auth?.account ?? (c.config as { username?: string; email?: string }).username ?? (c.config as { email?: string }).email ?? null;

/** The actions of a connection that provide a capability (connector must be registered on this server). */
export function actionsFor(c: ConnectionRecord, capability: string): string[] {
  const k = connectorFor(c.connector);
  return k ? Object.entries(k.actions).filter(([, spec]) => provides(spec, capability)).map(([name]) => name) : [];
}

export function resolveCapability(s: DevState, businessId: string, employeeId: string, capability: string): Resolution {
  const def = CAPABILITY_DEFS[capability];
  if (def?.builtIn) return { state: "built_in", label: def.builtIn };
  const conns = ((s.connections ?? {})[businessId] ?? []).filter(c => actionsFor(c, capability).length > 0);
  for (const c of conns) if (c.status === "active") {
    const action = actionsFor(c, capability).find(a => c.grants.some(g => g.agent === employeeId && g.actions.includes(a)));
    if (action) return { state: "ready", connectionId: c.id, connector: c.connector, action, account: accountOf(c), provider: refOf(c) };
  }
  const active = conns.find(c => c.status === "active");
  if (active) return { state: "needs_permission", connectionId: active.id, connector: active.connector, account: accountOf(active), provider: refOf(active) };
  const broken = conns.find(c => c.status === "reauth_required");
  if (broken) return { state: "reconnect", connectionId: broken.id, connector: broken.connector, provider: refOf(broken), problem: broken.auth?.problem ?? null };
  // Suggest only providers whose connector really performs this capability (a connect-only account
  // such as LinkedIn today is never offered as a way to publish).
  const works = (p: (typeof PROVIDERS)[number]) => {
    const k = p.connector ? connectorFor(p.connector) : null;
    return !!k && Object.values(k.actions).some(a => provides(a, capability));
  };
  const implemented = PROVIDERS.filter(p => p.support === "implemented" && p.capabilities.includes(capability) && works(p)).map(p => ({ key: p.key, name: p.name }));
  if (implemented.length) return { state: "not_connected", providers: implemented };
  return { state: "not_built", providers: PROVIDERS.filter(p => p.support !== "unsupported" && p.capabilities.includes(capability) && !works(p)).map(p => ({ key: p.key, name: p.name })) };
}

/** A short, model-readable summary of the business's real connection registry (no secrets). */
export function connectionSummary(s: DevState, businessId: string): string {
  const conns = ((s.connections ?? {})[businessId] ?? []).filter(c => c.status !== "disconnected");
  if (!conns.length) return "(no accounts connected yet)";
  return conns.map(c => {
    const p = providerForConnector(c.connector);
    const caps = (p?.capabilities ?? []).filter(cap => actionsFor(c, cap).length).join(", ") || "events only";
    return `- ${p?.name ?? c.connector}${accountOf(c) ? ` (${accountOf(c)})` : ""}: ${c.status === "active" ? "connected" : c.status === "reauth_required" ? "needs reconnecting" : "disabled"}; provides ${caps}`;
  }).join("\n");
}
