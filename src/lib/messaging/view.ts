import "server-only";
// The owner's Inbox: conversations across every connected channel, which communication channels are
// connected or missing (with how each connects), and the support settings. Never returns secrets.
import { discoveryRepository, type BusinessRecord } from "@/lib/discovery/store";
import { connectModes, type ConnectMode } from "@/lib/integrations/hub";
import { PROVIDERS } from "@/lib/integrations/catalogue";
import { DEFAULT_SETTINGS, WINDOW_24H, type Conversation, type MessagingSettings } from "./model";

export type InboxChannel = { key: string; name: string; status: "connected" | "needs_attention" | "pending" | "not_connected" | "unavailable"; account: string | null; mode: ConnectMode; employeeCanAnswer: boolean };
export type InboxView = {
  businessId: string;
  settings: MessagingSettings;
  channels: InboxChannel[];
  conversations: Array<Conversation & { windowOpen: boolean; pending: number }>;
  supportEmployee: { id: string; name: string } | null;
  counts: { needsOwner: number; pendingApproval: number; leads: number };
};

const COMM = ["telegram", "whatsapp_business", "instagram_dm", "messenger", "gmail", "outlook"];

export async function buildInboxView(b: BusinessRecord): Promise<InboxView> {
  const modes = connectModes();
  return discoveryRepository().readState(b.id, s => {
    const conns = (s.connections ?? {})[b.id] ?? [];
    const wf = s.businesses[b.id]?.workforce;
    const support = wf?.status === "approved" ? wf.employees.find(e => e.status === "active" && e.skills.some(k => k.id === "answer_enquiry")) ?? null : null;
    const channels: InboxChannel[] = COMM.map(key => {
      const p = PROVIDERS.find(x => x.key === key)!;
      const c = conns.find(x => x.connector === p.connector && x.status !== "disconnected");
      const status: InboxChannel["status"] = !c ? (modes[key] === "unavailable" ? "unavailable" : "not_connected") : c.status === "active" ? "connected" : c.status === "pending" ? "pending" : "needs_attention";
      const answers = !!c && !!support && c.status === "active" && c.routes.some(r => r.agent === support.id && r.event_type === "message.received") && c.grants.some(g => g.agent === support.id && g.actions.some(a => a.endsWith(".reply")));
      return { key, name: p.name, status, account: c?.auth?.account ?? (c?.config as { username?: string } | undefined)?.username ?? null, mode: modes[key] ?? "unavailable", employeeCanAnswer: answers };
    });
    const now = Date.now();
    const rank = (c: Conversation) => (c.status === "needs_owner" ? 0 : c.messages.some(m => m.status === "pending_approval") ? 1 : c.status === "open" ? 2 : 3);
    const conversations = [...((s.conversations ?? {})[b.id] ?? [])]
      .sort((x, y) => rank(x) - rank(y) || y.updated_at.localeCompare(x.updated_at))
      .map(c => ({ ...c, windowOpen: !WINDOW_24H.includes(c.channel) || (!!c.last_inbound_at && now - Date.parse(c.last_inbound_at) < 24 * 3_600_000), pending: c.messages.filter(m => m.status === "pending_approval").length }));
    return {
      businessId: b.id, settings: s.businesses[b.id]?.messaging ?? DEFAULT_SETTINGS, channels, conversations,
      supportEmployee: support ? { id: support.id, name: support.name } : null,
      counts: { needsOwner: conversations.filter(c => c.status === "needs_owner").length, pendingApproval: conversations.reduce((n, c) => n + c.pending, 0), leads: conversations.filter(c => !!c.lead).length },
    };
  });
}
