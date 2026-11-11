import "server-only";
// The inbox (layer B → C): how an external event reaches the right business and employee.
//
//   /api/hooks/<connectionId>  →  connection index → business (re-checked)  →  connector verifies the
//   request (signature / secret)  →  normalised events  →  stored ONCE per (connection, provider event id)
//   →  routed to the employee the owner chose for that event type (or marked "unrouted" for the owner).
//
// Connector-independent: Telegram, WhatsApp, email, POS or a generic webhook all arrive here the same way.
// Event content is stored as UNTRUSTED: it can never authorise an action, set a payment recipient or
// change a rule (the security gate's provenance rule). Nothing here executes anything; processing is a
// durable task for the automation engine.
import { randomUUID } from "node:crypto";
import { discoveryRepository } from "@/lib/discovery/store";
import { CredentialError } from "./credentials";
import { audit, CONNECTION_ID, loadConnectionForUse } from "./connections";
import type { InboundEventRecord } from "./records";
import type { InboundEvent } from "./types";
import { connectorFor } from "./registry";

/** Events kept per business (oldest dropped). Provider retries arrive within minutes, well inside this. */
export const INBOX_KEEP = 500;
export const MAX_INBOUND_BYTES = 64 * 1024;

export type InboxResult =
  | { status: 200; businessId: string; accepted: string[]; duplicates: number }
  | { status: 400 | 401 | 404 | 413 | 503; code: string };

/** Hook for the automation engine: called inside the same commit for every NEWLY stored event. */
export type OnNewEvent = (s: Parameters<Parameters<ReturnType<typeof discoveryRepository>["transact"]>[1]>[0], ev: InboundEventRecord) => void;

export async function receiveInbound(connectionId: string, rawBody: string, headers: Headers, opts: { now?: number; onNewEvent?: OnNewEvent } = {}): Promise<InboxResult> {
  if (!CONNECTION_ID.test(connectionId)) return { status: 404, code: "NOT_FOUND" };
  if (Buffer.byteLength(rawBody, "utf8") > MAX_INBOUND_BYTES) return { status: 413, code: "PAYLOAD_TOO_LARGE" };
  const repo = discoveryRepository();
  const businessId = await repo.businessIdForConnection(connectionId);     // store errors propagate → 503 at the route
  if (!businessId) return { status: 404, code: "NOT_FOUND" };
  let conn;
  try { conn = await loadConnectionForUse(businessId, connectionId); }
  catch (e) { if (e instanceof CredentialError) return { status: 503, code: "CREDENTIALS_UNAVAILABLE" }; throw e; }
  // Unknown and disabled connections look the same from outside (no enumeration).
  if (!conn || conn.record.status !== "active") return { status: 404, code: "NOT_FOUND" };
  const connector = connectorFor(conn.record.connector);
  if (!connector?.inbound) return { status: 404, code: "NOT_FOUND" };
  const verdict = connector.inbound({ rawBody, headers, config: conn.record.config, secrets: conn.secrets, now: opts.now ?? Date.now() });
  if (!verdict.ok) return { status: verdict.status, code: verdict.code };

  const out = await storeInboundEvents(businessId, connectionId, connector.key, conn.record.routes, verdict.events, opts.onNewEvent);
  return { status: 200, businessId, ...out };
}

/**
 * Store verified events for one connection: once per provider event id, routed to the employee the owner
 * chose, with a hook (the automation task) in the same commit. Shared by per-connection webhooks and
 * platform-wide webhooks (Meta, Telegram Business), which verify the request themselves first.
 */
export async function storeInboundEvents(businessId: string, connectionId: string, connectorKey: string, routes: Array<{ event_type: string; agent: string }>, events: InboundEvent[], onNewEvent?: OnNewEvent): Promise<{ accepted: string[]; duplicates: number }> {
  const connector = { key: connectorKey };
  const opts = { onNewEvent };
  const verdict = { events };
  return discoveryRepository().transact(businessId, s => {
    const list = ((s.inbound_events ??= {})[businessId] ??= []);
    const accepted: string[] = [];
    let duplicates = 0;
    const now = new Date().toISOString();
    for (const ev of verdict.events) {
      if (list.some(x => x.connection_id === connectionId && x.external_id === ev.externalId)) { duplicates++; continue; }
      const route = routes.find(r => r.event_type === ev.type);
      const rec: InboundEventRecord = {
        id: randomUUID(), business_id: businessId, connection_id: connectionId, connector: connector.key, external_id: ev.externalId,
        type: ev.type, subject: ev.subject, payload: ev.payload, occurred_at: ev.occurredAt, received_at: now, provenance: "untrusted",
        status: route ? "routed" : "unrouted", routed_to: route?.agent ?? null,
        note: route ? null : `No employee is assigned to "${ev.type}" events from this connection; the owner decides.`,
      };
      list.push(rec);
      accepted.push(rec.id);
      audit(s, businessId, "system", route ? "event.received" : "event.unrouted", `event:${rec.id}`, rec.status, rec.id, { connector: connector.key, type: ev.type, routed_to: rec.routed_to });
      opts.onNewEvent?.(s, rec);
    }
    if (list.length > INBOX_KEEP) list.splice(0, list.length - INBOX_KEEP);
    return { accepted, duplicates };
  });
}

/**
 * Platform-wide webhooks: deliver already-verified events to the business that owns this external
 * identity (route key). Unknown or inactive identities are ignored (never another business's data).
 */
export async function deliverToRouteKey(routeKey: string, events: InboundEvent[], onNewEvent?: OnNewEvent): Promise<{ businessId: string; accepted: string[] } | null> {
  const hit = await discoveryRepository().connectionForRouteKey(routeKey);
  if (!hit || events.length === 0) return null;
  const conn = await discoveryRepository().readState(hit.businessId, s => ((s.connections ?? {})[hit.businessId] ?? []).find(c => c.id === hit.connectionId) ?? null);
  if (!conn || conn.status !== "active") return null;
  const r = await storeInboundEvents(hit.businessId, conn.id, conn.connector, conn.routes, events, onNewEvent);
  return { businessId: hit.businessId, accepted: r.accepted };
}
