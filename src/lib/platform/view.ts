import "server-only";
// Read-only views for the platform screens (Workforce, Content, Activity). Never return secrets.
import { configuredProvider } from "@/lib/ai/factory";
import { workerUrl } from "@/lib/automation/dispatch";
import { qstashConfig } from "@/lib/automation/qstash";
import type { ContentItem, Product } from "@/lib/content/model";
import { discoveryRepository, type BusinessRecord } from "@/lib/discovery/store";
import { connectionView, type ConnectionView } from "@/lib/integrations/connections";
import { CAPABILITIES } from "@/lib/workforce/registry";
import type { WorkforceState } from "@/lib/workforce/plan";

export type IntegrationStatus = "connected" | "available" | "planned";
export type PlatformView = {
  businessId: string;
  businessName: string | null;
  ai: { label: string; live: boolean };
  workforce: WorkforceState | null;
  /** Every capability the workforce needs, with each provider's REAL status for this business. */
  integrations: Array<{ capability: string; label: string; neededBy: string[]; providers: Array<{ connector: string; name: string; status: IntegrationStatus; account: string | null }> }>;
  connections: ConnectionView[];
  products: Array<Product & { preview: string | null }>;
  content: ContentItem[];
  background: { publicUrl: boolean; qstash: boolean; note: string };
};

export async function buildPlatformView(b: BusinessRecord): Promise<PlatformView> {
  const s = await discoveryRepository().readState(b.id, st => ({
    connections: ((st.connections ?? {})[b.id] ?? []).map(connectionView),
    content: [...((st.content_items ?? {})[b.id] ?? [])].sort((x, y) => (x.planned_for + x.created_at).localeCompare(y.planned_for + y.created_at)),
    business: st.businesses[b.id] ?? b,
  }));
  const wf = s.business.workforce ?? null;
  const caps = new Map<string, string[]>();
  for (const e of wf?.employees ?? []) for (const i of e.integrations) caps.set(i.capability, [...(caps.get(i.capability) ?? []), e.name]);
  const active = s.connections.filter(c => c.status === "active");
  const integrations = [...caps.entries()].map(([capability, neededBy]) => ({
    capability, label: CAPABILITIES[capability]?.label ?? capability, neededBy,
    providers: (CAPABILITIES[capability]?.providers ?? []).map(p => {
      const conn = active.find(c => c.connector === p.connector);
      return { connector: p.connector, name: p.name, status: (conn ? "connected" : p.status) as IntegrationStatus, account: conn ? String((conn.config as { username?: string }).username ?? conn.label) : null };
    }),
  }));
  const q = qstashConfig();
  const pub = !!workerUrl();
  const ai = configuredProvider(process.env);
  return {
    businessId: b.id, businessName: s.business.name,
    ai: { label: ai.label, live: ai.name === "nearai" },
    workforce: wf, integrations, connections: s.connections,
    products: (s.business.products ?? []).map(p => ({ ...p, preview: p.image ? (p.image.kind === "url" ? p.image.url : `/api/media/${p.image.media_id}`) : null })),
    content: s.content,
    background: {
      publicUrl: pub, qstash: q.canPublish && pub,
      note: pub
        ? (q.canPublish ? "Scheduled posts are published by the background worker (QStash wake-ups plus a recovery sweep), with or without this page open." : "Scheduled posts are published by the background worker's recovery sweep (QStash isn't configured, so timing is less precise).")
        : "This server has no public address, so scheduled posts run only when the worker is triggered here (e.g. by the recovery sweep). Deploy for unattended publishing.",
    },
  };
}

const LABELS: Record<string, string> = {
  "workforce.planned": "Workforce planned", "workforce.approved": "Workforce approved", "employee.paused": "Employee paused", "employee.resumed": "Employee resumed",
  "connection.created": "Integration connected", "connection.disabled": "Integration disabled", "connection.enabled": "Integration enabled",
  "product.added": "Product added", "product.removed": "Product removed",
  "content.planned": "Content calendar created", "content.drafted": "Caption written", "content.edited": "Caption edited by owner", "content.approved": "Post approved and scheduled",
  "content.cancelled": "Schedule cancelled", "content.published": "Post published", "content.failed": "Publication failed", "content.needs_attention": "Publication needs attention",
  "action.prepared": "Action recorded", "action.sending": "Delivering", "action.done": "Delivered (confirmed by the platform)", "action.rejected": "Refused by the platform", "action.unknown": "Outcome unknown — verifying", "action.escalated": "Escalated to the owner", "action.aborted": "Stopped before sending", "action.reconciled": "Outcome confirmed by reconciliation", "action.retry_scheduled": "Retry scheduled", "action.refused": "Action refused (permissions)",
  "event.received": "Event received", "event.unrouted": "Event needs an owner decision", "event.awaiting_automation": "Event kept for the owner", "task.dead": "Background task failed",
  "kill_switch.on": "Kill switch ON", "kill_switch.off": "Kill switch off", "run.started": "Run started", "payment.confirmed": "NEAR testnet payment confirmed",
};

export type ActivityView = {
  events: Array<{ id: string; at: string; actor: string; type: string; label: string; status: string; detail: string | null; link: string | null }>;
  tasks: { queued: number; running: number; dead: number; nextDue: string | null };
  actions: Array<{ id: string; at: string; action: string; agent: string; status: string; deliveries: number; ref: string | null; link: string | null; error: string | null; notBefore: string | null }>;
};

export async function buildActivityView(b: BusinessRecord): Promise<ActivityView> {
  return discoveryRepository().readState(b.id, s => {
    const staff = new Map((s.businesses[b.id]?.workforce?.employees ?? []).map(e => [e.id, e.name === e.title ? e.name : `${e.name} (${e.title})`]));
    const who = (actor: string) => actor === "owner" ? "You" : actor.startsWith("agent:") ? staff.get(actor.slice(6)) ?? actor.slice(6) : actor;
    const events = [...((s.activity_events ?? {})[b.id] ?? [])].slice(-120).reverse().map(e => {
      const p = e.payload as Record<string, unknown>;
      const link = typeof p.permalink === "string" ? p.permalink : null;
      const detail = typeof p.media_id === "string" ? `Media ID ${p.media_id}` : typeof p.code === "string" ? p.code : typeof p.scheduled_for === "string" ? `Scheduled for ${p.scheduled_for}` : null;
      return { id: e.id, at: e.created_at, actor: who(e.actor), type: e.type, label: LABELS[e.type] ?? e.type, status: e.status, detail, link };
    });
    const tasks = (s.tasks ?? {})[b.id] ?? [];
    const queued = tasks.filter(t => t.status === "queued");
    return {
      events,
      tasks: { queued: queued.length, running: tasks.filter(t => t.status === "running").length, dead: tasks.filter(t => t.status === "dead").length, nextDue: queued.map(t => t.next_at).sort()[0] ?? null },
      actions: [...((s.action_attempts ?? {})[b.id] ?? [])].slice(-25).reverse().map(a => ({
        id: a.id, at: a.updated_at, action: a.action, agent: staff.get(a.agent) ?? a.agent, status: a.status, deliveries: a.deliveries, ref: a.provider_ref,
        link: typeof (a.result as { permalink?: unknown } | null | undefined)?.permalink === "string" ? (a.result as { permalink: string }).permalink : null,
        error: a.error?.message ?? null, notBefore: a.status === "prepared" ? a.retry_at : null,
      })),
    };
  });
}
