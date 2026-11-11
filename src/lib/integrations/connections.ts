import "server-only";
// Connections: one business's configured instance of a connector (layer B). The owner creates them;
// grants say which employees may use which of its actions, routes say which employee receives which of
// its event types. An employee can hold grants on any number of connections (never tied to one).
// Secrets are encrypted per business (credentials.ts) and never returned by any function here except
// loadConnectionForUse, which the inbox and the action executor call on the server.
import { randomBytes, randomUUID } from "node:crypto";
import { AGENT_ORDER } from "@/lib/catalogue/catalogue";
import { discoveryRepository, type DevState } from "@/lib/discovery/store";
import type { ActivityEvent, Actor } from "@/lib/runs/types";
import { decryptSecrets, encryptSecrets } from "./credentials";
import type { ConnectionGrant, ConnectionRecord, ConnectionRoute } from "./records";
import { connectorFor } from "./registry";

export class IntegrationError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) { super(message); this.name = "IntegrationError"; }
}

export const MAX_CONNECTIONS_PER_BUSINESS = 10;
export const CONNECTION_ID = /^[A-Za-z0-9_-]{24}$/;
export const newConnectionId = () => randomBytes(18).toString("base64url");   // 144 bits, 24 chars

/** Append an audit event inside a transaction (same shape as the run repository's activity events). */
export function audit(s: DevState, businessId: string, actor: Actor, type: string, subject: string, status: string, correlationId: string, payload: Record<string, unknown> = {}) {
  const rec: ActivityEvent = { id: randomUUID(), business_id: businessId, actor, type, subject, status, correlation_id: correlationId, payload, created_at: new Date().toISOString() };
  ((s.activity_events ??= {})[businessId] ??= []).push(rec);
}

/** A catalogue agent key, or an employee of this business's workforce plan. */
export function employeeKnown(s: DevState, businessId: string, id: string): boolean {
  return (AGENT_ORDER as string[]).includes(id) || !!s.businesses[businessId]?.workforce?.employees.some(e => e.id === id);
}

export type ConnectionView = Omit<ConnectionRecord, "secrets"> & { hasSecrets: boolean; webhookPath: string | null; connectorName: string };

export function connectionView(c: ConnectionRecord): ConnectionView {
  const { secrets, ...rest } = c;
  const connector = connectorFor(c.connector);
  return { ...rest, hasSecrets: !!secrets, webhookPath: connector?.inbound ? `/api/hooks/${c.id}` : null, connectorName: connector?.name ?? c.connector };
}

function validateGrantsAndRoutes(connectorKey: string, grants: unknown, routes: unknown): { grants: ConnectionGrant[]; routes: ConnectionRoute[] } {
  const c = connectorFor(connectorKey)!;
  // Shape only here; that the employee exists in this business is checked in the commit (employeeKnown).
  const isAgent = (a: unknown): a is string => typeof a === "string" && /^[a-z][a-z0-9_]{1,31}$/.test(a);
  const g = Array.isArray(grants) ? grants : [];
  const r = Array.isArray(routes) ? routes : [];
  if (g.length > 7 || r.length > 20) throw new IntegrationError("VALIDATION_FAILED", 400, "Too many grants or routes.");
  const outG: ConnectionGrant[] = g.map(x => {
    const o = x as { agent?: unknown; actions?: unknown };
    if (!isAgent(o.agent)) throw new IntegrationError("VALIDATION_FAILED", 400, "A grant names an unknown employee.");
    const actions = Array.isArray(o.actions) ? o.actions : [];
    if (actions.length === 0 || actions.some(a => typeof a !== "string" || !c.actions[a])) throw new IntegrationError("VALIDATION_FAILED", 400, `A grant names an action ${c.name} doesn't have.`);
    return { agent: o.agent, actions: [...new Set(actions as string[])] };
  });
  const outR: ConnectionRoute[] = r.map(x => {
    const o = x as { event_type?: unknown; agent?: unknown };
    if (typeof o.event_type !== "string" || !c.eventTypes.includes(o.event_type)) throw new IntegrationError("VALIDATION_FAILED", 400, `A route names an event type ${c.name} doesn't send.`);
    if (!isAgent(o.agent)) throw new IntegrationError("VALIDATION_FAILED", 400, "A route names an unknown employee.");
    return { event_type: o.event_type, agent: o.agent };
  });
  return { grants: outG, routes: outR };
}

/** Create a connection. Returns its view and any secrets to show the owner ONCE (never stored in clear). */
export async function createConnection(businessId: string, input: { connector: string; label: string; setup: unknown; grants?: unknown; routes?: unknown }): Promise<{ view: ConnectionView; revealOnce: Record<string, string> }> {
  const connector = connectorFor(input.connector);
  if (!connector) throw new IntegrationError("VALIDATION_FAILED", 400, "Unknown integration.");
  const label = (input.label ?? "").trim();
  if (label.length < 1 || label.length > 60) throw new IntegrationError("VALIDATION_FAILED", 400, "Give the connection a name (up to 60 characters).");
  const { grants, routes } = validateGrantsAndRoutes(connector.key, input.grants, input.routes);
  let setup;
  try { setup = await connector.setup(input.setup); }
  catch (e) { throw new IntegrationError("VALIDATION_FAILED", 400, e instanceof Error ? e.message.slice(0, 200) : "Invalid settings."); }
  const id = newConnectionId();
  const secrets = Object.keys(setup.secrets).length ? encryptSecrets(businessId, id, setup.secrets) : null;   // CredentialError → fail closed
  const now = new Date().toISOString();
  const rec: ConnectionRecord = { id, business_id: businessId, connector: connector.key, label, status: "active", reality: connector.reality, config: setup.config, secrets, grants, routes, created_at: now, updated_at: now };
  await discoveryRepository().transact(businessId, s => {
    if (!s.businesses[businessId]) throw new IntegrationError("NOT_FOUND", 404, "Not found.");
    for (const who of [...grants.map(g => g.agent), ...routes.map(r => r.agent)]) if (!employeeKnown(s, businessId, who)) throw new IntegrationError("VALIDATION_FAILED", 400, "A grant or route names an employee this business doesn't have.");
    // No explicit grants: each action goes to the workforce employees whose skills need its CAPABILITY
    // (provider-independent: "social.publish" → whoever publishes, whatever the platform).
    if (grants.length === 0) {
      const wf = s.businesses[businessId]?.workforce;
      for (const [action, spec] of Object.entries(connector.actions)) {
        if (!spec.capability) continue;
        for (const e of wf?.employees ?? []) if (e.integrations.some(i => i.capability === spec.capability)) {
          const g = rec.grants.find(x => x.agent === e.id);
          if (g) { if (!g.actions.includes(action)) g.actions.push(action); } else rec.grants.push({ agent: e.id, actions: [action] });
        }
      }
    }
    const list = ((s.connections ??= {})[businessId] ??= []);
    if (list.length >= MAX_CONNECTIONS_PER_BUSINESS) throw new IntegrationError("LIMIT_REACHED", 409, `A business can have up to ${MAX_CONNECTIONS_PER_BUSINESS} connections.`);
    list.push(rec);
    audit(s, businessId, "owner", "connection.created", `connection:${id}`, "active", id, { connector: connector.key, reality: connector.reality, grants: rec.grants.map(g => g.agent), routes: routes.length });
  });
  return { view: connectionView(rec), revealOnce: setup.revealOnce };
}

export async function listConnections(businessId: string): Promise<ConnectionView[]> {
  return discoveryRepository().readState(businessId, s => ((s.connections ?? {})[businessId] ?? []).map(connectionView));
}

/** Enable or disable. A disabled connection accepts no events and runs no actions (checked at use). */
export async function setConnectionStatus(businessId: string, connectionId: string, status: "active" | "disabled"): Promise<ConnectionView> {
  return discoveryRepository().transact(businessId, s => {
    const c = ((s.connections ?? {})[businessId] ?? []).find(x => x.id === connectionId);
    if (!c) throw new IntegrationError("NOT_FOUND", 404, "That connection doesn't exist.");
    if (c.status !== status) {
      c.status = status; c.updated_at = new Date().toISOString();
      audit(s, businessId, "owner", status === "disabled" ? "connection.disabled" : "connection.enabled", `connection:${connectionId}`, status, connectionId);
    }
    return connectionView(c);
  });
}

/** Server-side use only (inbox, action executor): the record and its DECRYPTED secrets. */
export async function loadConnectionForUse(businessId: string, connectionId: string): Promise<{ record: ConnectionRecord; secrets: Record<string, string> } | null> {
  const record = await discoveryRepository().readState(businessId, s => ((s.connections ?? {})[businessId] ?? []).find(x => x.id === connectionId) ?? null);
  if (!record) return null;
  return { record, secrets: record.secrets ? decryptSecrets(businessId, record.id, record.secrets) : {} };
}
