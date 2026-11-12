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
import { enqueueTaskIn } from "@/lib/automation/tasks";
import { decryptSecrets, encryptSecrets } from "./credentials";
import { PERMISSIONS, permissionOf, type Permission } from "./catalogue";
import type { ConnectionAuth, ConnectionGrant, ConnectionRecord, ConnectionRoute } from "./records";
import { connectorFor } from "./registry";
import type { Connector } from "./types";

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

/**
 * Connecting an account grants NOTHING to any employee. Account connections and employee permissions are
 * separate: the owner explicitly grants each employee the permissions it needs (setEmployeePermissions,
 * or one click from the readiness panel), and per-item approvals (posts, payments) still apply on top.
 */

/**
 * Create a connection (or, with replaceId, reconnect an existing one: same id, grants, routes and history;
 * only its credentials change). Returns its view and any secrets to show the owner ONCE.
 */
export async function createConnection(businessId: string, input: { connector: string; label: string; setup: unknown; grants?: unknown; routes?: unknown; auth?: Omit<ConnectionAuth, "checked_at" | "problem">; replaceId?: string | null; initialStatus?: "active" | "pending" }): Promise<{ view: ConnectionView; revealOnce: Record<string, string> }> {
  const connector = connectorFor(input.connector);
  if (!connector) throw new IntegrationError("VALIDATION_FAILED", 400, "Unknown integration.");
  const label = (input.label ?? "").trim();
  if (label.length < 1 || label.length > 60) throw new IntegrationError("VALIDATION_FAILED", 400, "Give the connection a name (up to 60 characters).");
  const { grants, routes } = validateGrantsAndRoutes(connector.key, input.grants, input.routes);
  let setup;
  try { setup = await connector.setup(input.setup); }
  catch (e) { throw new IntegrationError("VALIDATION_FAILED", 400, e instanceof Error ? e.message.slice(0, 200) : "Invalid settings."); }
  const id = input.replaceId && CONNECTION_ID.test(input.replaceId) ? input.replaceId : newConnectionId();
  const secrets = Object.keys(setup.secrets).length ? encryptSecrets(businessId, id, setup.secrets) : null;   // CredentialError → fail closed
  const now = new Date().toISOString();
  const cfg = setup.config as { username?: unknown; email?: unknown };
  const account = String(cfg.username ?? cfg.email ?? "") || null;
  const auth: ConnectionAuth = { method: "token", scopes: [], expires_at: null, refreshable: false, ...(input.auth ?? {}), account: input.auth?.account ?? account, problem: null, checked_at: now };
  // One external account belongs to one business: refuse an identity another workspace already holds.
  const routeKeys = [...new Set(setup.routeKeys ?? [])];
  for (const k of routeKeys) {
    const hit = await discoveryRepository().connectionForRouteKey(k);
    if (hit && hit.businessId !== businessId) throw new IntegrationError("ACCOUNT_IN_USE", 409, "This account is already connected to another EmployAI workspace. Disconnect it there first.");
  }
  const status = input.initialStatus ?? "active";
  const rec: ConnectionRecord = { id, business_id: businessId, connector: connector.key, label, status, reality: connector.reality, config: setup.config, secrets, grants, routes, auth, route_keys: routeKeys, created_at: now, updated_at: now };
  if (input.replaceId) {
    const view = await discoveryRepository().transact(businessId, s => {
      const c = ((s.connections ?? {})[businessId] ?? []).find(x => x.id === input.replaceId && x.connector === connector.key);
      if (!c) throw new IntegrationError("NOT_FOUND", 404, "That connection doesn't exist.");
      // Grants kept by a reconnect stay; a disconnected connection had its grants cleared and gets none back.
      Object.assign(c, { status, config: setup.config, secrets, auth, label, route_keys: routeKeys, updated_at: now });
      audit(s, businessId, "owner", "connection.reconnected", `connection:${c.id}`, "active", c.id, { connector: connector.key, account });
      if (connector.poll && status === "active") enqueueTaskIn(s, businessId, { kind: "poll_mailbox", ref: c.id, dedupeKey: `poll:${c.id}` });
      return connectionView(c);
    });
    await activateConnection(businessId, id, connector, setup);
    return { view, revealOnce: setup.revealOnce };
  }
  await discoveryRepository().transact(businessId, s => {
    if (!s.businesses[businessId]) throw new IntegrationError("NOT_FOUND", 404, "Not found.");
    for (const who of [...grants.map(g => g.agent), ...routes.map(r => r.agent)]) if (!employeeKnown(s, businessId, who)) throw new IntegrationError("VALIDATION_FAILED", 400, "A grant or route names an employee this business doesn't have.");
    const list = ((s.connections ??= {})[businessId] ??= []);
    if (list.length >= MAX_CONNECTIONS_PER_BUSINESS) throw new IntegrationError("LIMIT_REACHED", 409, `A business can have up to ${MAX_CONNECTIONS_PER_BUSINESS} connections.`);
    list.push(rec);
    // Providers without push (mailboxes): the durable worker checks for new messages on a schedule.
    if (connector.poll && status === "active") enqueueTaskIn(s, businessId, { kind: "poll_mailbox", ref: rec.id, dedupeKey: `poll:${rec.id}` });
    audit(s, businessId, "owner", "connection.created", `connection:${id}`, "active", id, { connector: connector.key, reality: connector.reality, grants: rec.grants.map(g => g.agent), routes: routes.length });
  });
  await activateConnection(businessId, id, connector, setup);
  return { view: connectionView(rec), revealOnce: setup.revealOnce };
}

/** Provider-side activation (e.g. Telegram setWebhook). Its result is recorded in config; never fatal. */
async function activateConnection(businessId: string, id: string, connector: Connector, setup: { config: Record<string, unknown>; secrets: Record<string, string> }) {
  if (!connector.activate) return;
  const base = (process.env.EMPLOYAI_PUBLIC_URL ?? "").replace(/\/+$/, "");
  const publicUrl = /^https:\/\//.test(base) ? base : null;
  let r: { ok: boolean; detail: string };
  try { r = await connector.activate({ connectionId: id, publicUrl, config: setup.config, secrets: setup.secrets }); } catch { r = { ok: false, detail: "Activation failed." }; }
  await discoveryRepository().transact(businessId, s => {
    const c = ((s.connections ?? {})[businessId] ?? []).find(x => x.id === id);
    if (c) { c.config = { ...c.config, activation: r.ok ? "ok" : "pending", activation_detail: r.detail.slice(0, 200) }; c.updated_at = new Date().toISOString(); }
  });
}

export async function listConnections(businessId: string): Promise<ConnectionView[]> {
  return discoveryRepository().readState(businessId, s => ((s.connections ?? {})[businessId] ?? []).map(connectionView));
}

/** Enable or disable. A disabled connection accepts no events and runs no actions (checked at use). */
export async function setConnectionStatus(businessId: string, connectionId: string, status: "active" | "disabled"): Promise<ConnectionView> {
  return discoveryRepository().transact(businessId, s => {
    const c = ((s.connections ?? {})[businessId] ?? []).find(x => x.id === connectionId);
    if (!c) throw new IntegrationError("NOT_FOUND", 404, "That connection doesn't exist.");
    if (c.status === "reauth_required" || c.status === "disconnected") throw new IntegrationError("RECONNECT_REQUIRED", 409, "Reconnect this account first.");
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
  const secrets = record.secrets ? decryptSecrets(businessId, record.id, record.secrets) : {};
  // OAuth tokens are renewed here, before use, when they are about to expire (oauth.ts registers it).
  const hook = (globalThis as unknown as { [REFRESH]?: RefreshHook })[REFRESH];
  if (hook && record.auth?.method === "oauth" && record.status === "active") return hook(businessId, record, secrets);
  return { record, secrets };
}

type RefreshHook = (businessId: string, record: ConnectionRecord, secrets: Record<string, string>) => Promise<{ record: ConnectionRecord; secrets: Record<string, string> }>;
const REFRESH = Symbol.for("employai.oauthRefresh");
/** oauth.ts registers the token refresher (keeps this module free of provider details). */
export function registerTokenRefresher(fn: RefreshHook) { (globalThis as unknown as { [REFRESH]?: RefreshHook })[REFRESH] = fn; }

/** Thrown when a token renewal failed for a temporary reason (nothing was sent; try later). */
export class CredentialRefreshFailed extends Error { constructor(message: string) { super(message); this.name = "CredentialRefreshFailed"; } }

/** Thrown when credentials can't be used until the owner reconnects (nothing was sent). */
export class ReconnectRequired extends Error { constructor(message: string) { super(message); this.name = "ReconnectRequired"; } }

/** The permission categories this connection's connector supports, and which actions each covers. */
export function connectionPermissions(connector: Connector): Array<{ permission: Permission; label: string; actions: string[]; viaRoutes: boolean }> {
  const out = new Map<Permission, { actions: string[]; viaRoutes: boolean }>();
  for (const [name, spec] of Object.entries(connector.actions)) { const p = permissionOf(spec); const e = out.get(p) ?? { actions: [], viaRoutes: false }; e.actions.push(name); out.set(p, e); }
  // Receiving messages is granted by routing inbound message events to the employee.
  if (connector.eventTypes.includes("message.received")) { const e = out.get("read_messages") ?? { actions: [], viaRoutes: false }; e.viaRoutes = true; out.set("read_messages", e); }
  return [...out.entries()].map(([permission, v]) => ({ permission, label: PERMISSIONS[permission].label, ...v }));
}

/** The permission categories an employee currently holds on a connection. */
export function heldPermissions(c: ConnectionRecord, connector: Connector, employeeId: string): Permission[] {
  return connectionPermissions(connector).filter(o =>
    (o.actions.length > 0 && o.actions.every(a => c.grants.some(g => g.agent === employeeId && g.actions.includes(a)))) ||
    (o.actions.length === 0 && o.viaRoutes && c.routes.some(r => r.agent === employeeId && r.event_type === "message.received")),
  ).map(o => o.permission);
}

/**
 * Owner sets exactly which permission categories one employee holds on one connection
 * (or, with { add }, grants one more on top of what it holds — the readiness panel's one-click "Allow").
 */
export async function setEmployeePermissions(businessId: string, connectionId: string, employeeId: string, permissionsOrAdd: Permission[] | { add: Permission | Permission[] }): Promise<ConnectionView> {
  return discoveryRepository().transact(businessId, s => {
    const c = ((s.connections ?? {})[businessId] ?? []).find(x => x.id === connectionId);
    if (!c) throw new IntegrationError("NOT_FOUND", 404, "That connection doesn't exist.");
    if (c.status === "disconnected") throw new IntegrationError("RECONNECT_REQUIRED", 409, "Reconnect this account first.");
    if (!employeeKnown(s, businessId, employeeId)) throw new IntegrationError("VALIDATION_FAILED", 400, "That employee doesn't exist.");
    const connector = connectorFor(c.connector);
    if (!connector) throw new IntegrationError("CONNECTOR_UNAVAILABLE", 409, "This integration isn't available on this server.");
    const offered = connectionPermissions(connector);
    const permissions = Array.isArray(permissionsOrAdd) ? permissionsOrAdd : [...heldPermissions(c, connector, employeeId), ...[permissionsOrAdd.add].flat()];
    const want = new Set(permissions.filter(p => offered.some(o => o.permission === p)));
    const actions = offered.filter(o => want.has(o.permission)).flatMap(o => o.actions);
    c.grants = c.grants.filter(g => g.agent !== employeeId);
    if (actions.length) c.grants.push({ agent: employeeId, actions });
    if (offered.some(o => o.viaRoutes)) {
      c.routes = c.routes.filter(r => !(r.agent === employeeId && r.event_type === "message.received"));
      // One employee receives a connection's incoming messages; granting it moves the route.
      if (want.has("read_messages")) { c.routes = c.routes.filter(r => r.event_type !== "message.received"); c.routes.push({ event_type: "message.received", agent: employeeId }); }
    }
    c.updated_at = new Date().toISOString();
    audit(s, businessId, "owner", "connection.permissions_changed", `connection:${c.id}`, c.status, c.id, { employee: employeeId, permissions: [...want] });
    return connectionView(c);
  });
}

/** Disconnect: delete the stored credentials and every grant/route. History (actions, events) is kept. */
export async function disconnectConnection(businessId: string, connectionId: string): Promise<ConnectionView> {
  return discoveryRepository().transact(businessId, s => {
    const c = ((s.connections ?? {})[businessId] ?? []).find(x => x.id === connectionId);
    if (!c) throw new IntegrationError("NOT_FOUND", 404, "That connection doesn't exist.");
    Object.assign(c, { status: "disconnected", secrets: null, grants: [], routes: [], updated_at: new Date().toISOString() });
    if (c.auth) c.auth = { ...c.auth, expires_at: null, refreshable: false, problem: null };
    audit(s, businessId, "owner", "connection.disconnected", `connection:${c.id}`, "disconnected", c.id, { connector: c.connector });
    return connectionView(c);
  });
}

/** The provider refused our credentials: stop using them until the owner reconnects. */
export async function markReauthRequired(businessId: string, connectionId: string, problem: string): Promise<void> {
  await discoveryRepository().transact(businessId, s => {
    const c = ((s.connections ?? {})[businessId] ?? []).find(x => x.id === connectionId);
    if (!c || c.status === "disconnected") return;
    const was = c.status;
    c.status = "reauth_required";
    c.auth = { ...(c.auth ?? { method: "token", account: null, scopes: [], expires_at: null, refreshable: false, checked_at: null }), problem: problem.slice(0, 200) };
    c.updated_at = new Date().toISOString();
    if (was !== "reauth_required") audit(s, businessId, "system", "connection.reauth_required", `connection:${c.id}`, "reauth_required", c.id, { connector: c.connector });
  });
}

/** Owner's "Check connection": ask the provider whether the credentials still work. */
export async function checkConnection(businessId: string, connectionId: string): Promise<ConnectionView> {
  const loaded = await loadConnectionForUse(businessId, connectionId).catch(e => { if (e instanceof ReconnectRequired) return null; throw e; });
  const record = await discoveryRepository().readState(businessId, s => ((s.connections ?? {})[businessId] ?? []).find(x => x.id === connectionId) ?? null);
  if (!record) throw new IntegrationError("NOT_FOUND", 404, "That connection doesn't exist.");
  if (!loaded || record.status === "disconnected") return connectionView(record);
  const connector = connectorFor(record.connector);
  type Check = { ok: true; detail?: string } | { ok: false; reauth: boolean; detail: string };
  const r: Check = connector?.checkAuth ? await connector.checkAuth({ config: loaded.record.config, secrets: loaded.secrets }).catch((): Check => ({ ok: false, reauth: false, detail: "The provider couldn't be reached." })) : { ok: true };
  if (!r.ok && r.reauth) await markReauthRequired(businessId, connectionId, r.detail);
  return discoveryRepository().transact(businessId, s => {
    const c = ((s.connections ?? {})[businessId] ?? []).find(x => x.id === connectionId)!;
    if (c.auth) c.auth.checked_at = new Date().toISOString();
    if (r.ok && c.status === "reauth_required") { c.status = "active"; if (c.auth) c.auth.problem = null; }
    audit(s, businessId, "owner", "connection.checked", `connection:${c.id}`, r.ok ? "ok" : "failed", c.id, r.ok ? {} : { code: "CHECK_FAILED" });
    return connectionView(c);
  });
}

/** Server-side state changes of a connection driven by the provider (e.g. Telegram confirming access). */
export async function patchConnection<T>(businessId: string, connectionId: string, fn: (c: ConnectionRecord, s: DevState) => T): Promise<T> {
  return discoveryRepository().transact(businessId, s => {
    const c = ((s.connections ?? {})[businessId] ?? []).find(x => x.id === connectionId);
    if (!c) throw new IntegrationError("NOT_FOUND", 404, "That connection doesn't exist.");
    const out = fn(c, s);
    c.updated_at = new Date().toISOString();
    return out;
  });
}
