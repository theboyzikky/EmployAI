// Readiness: for the business's workforce, what can be done NOW with the accounts already connected,
// which connections are missing (and why, and where to connect them), what needs a permission or a
// reconnect, and what isn't possible yet because the skill or every provider is not built.
// This is what lets EmployAI prepare the work it can do and ask only for the missing connections.
import type { DevState } from "@/lib/discovery/store";
import { CAPABILITY_DEFS, PERMISSIONS, type Permission } from "@/lib/integrations/catalogue";
import { resolveCapability, type ProviderRef } from "@/lib/integrations/resolve";
import { SKILLS } from "./registry";

export type ReadinessItem = { employeeId: string; employee: string; skill: string; skillLabel: string; capability: string | null; capabilityLabel: string | null };
export type Readiness = {
  ready: Array<ReadinessItem & { via: string }>;
  /** One entry per missing capability, with every employee/skill that needs it and where to connect it. */
  missing: Array<{ capability: string; label: string; neededFor: ReadinessItem[]; providers: ProviderRef[]; why: string }>;
  needsPermission: Array<ReadinessItem & { connectionId: string; provider: ProviderRef; account: string | null; permission: Permission; permissionLabel: string; /** everything the skill needs on this account (answering = read + send) */ permissions: Permission[] }>;
  reconnect: Array<ReadinessItem & { connectionId: string; provider: ProviderRef; problem: string | null }>;
  notYet: Array<ReadinessItem & { reason: string }>;
  demo: ReadinessItem[];
};

export function workforceReadiness(s: DevState, businessId: string): Readiness | null {
  const wf = s.businesses[businessId]?.workforce;
  if (!wf) return null;
  const out: Readiness = { ready: [], missing: [], needsPermission: [], reconnect: [], notYet: [], demo: [] };
  for (const e of wf.employees) for (const sk of e.skills) {
    const def = SKILLS[sk.id];
    if (!def) continue;
    const cap = def.capability;
    const item: ReadinessItem = { employeeId: e.id, employee: e.name, skill: sk.id, skillLabel: def.label, capability: cap, capabilityLabel: cap ? CAPABILITY_DEFS[cap]?.label ?? cap : null };
    if (def.status === "planned") { out.notYet.push({ ...item, reason: "This skill isn't built yet." }); continue; }
    if (def.status === "preview") { out.demo.push(item); continue; }
    if (!cap) { out.ready.push({ ...item, via: "EmployAI" }); continue; }
    // A connected account is used only after the owner explicitly grants this employee the permission.
    const r = resolveCapability(s, businessId, e.id, cap);
    if (r.state === "built_in") out.ready.push({ ...item, via: r.label });
    else if (r.state === "ready") out.ready.push({ ...item, via: `${r.provider.name}${r.account ? ` (${r.account})` : ""}` });
    else if (r.state === "needs_permission") out.needsPermission.push({ ...item, connectionId: r.connectionId, provider: r.provider, account: r.account, permission: CAPABILITY_DEFS[cap]?.permission ?? "manage", permissionLabel: cap === "reply_to_customer" ? "Read messages and Send messages" : PERMISSIONS[CAPABILITY_DEFS[cap]?.permission ?? "manage"].label, permissions: cap === "reply_to_customer" ? ["read_messages", "send_messages"] : [CAPABILITY_DEFS[cap]?.permission ?? "manage"] });   // connected, but the owner hasn't granted it yet
    else if (r.state === "reconnect") out.reconnect.push({ ...item, connectionId: r.connectionId, provider: r.provider, problem: r.problem });
    else if (r.state === "not_built") out.notYet.push({ ...item, reason: r.providers.length ? `No connector for ${r.providers.map(p => p.name).join(", ")} is built yet.` : "No provider offers this yet." });
    else {
      const m = out.missing.find(x => x.capability === cap);
      if (m) m.neededFor.push(item);
      else out.missing.push({ capability: cap, label: item.capabilityLabel ?? cap, neededFor: [item], providers: r.providers, why: "" });
    }
  }
  for (const m of out.missing) { const who = [...new Set(m.neededFor.map(i => i.employee))]; m.why = `${who.join(" and ")} need${who.length === 1 ? "s" : ""} it to ${[...new Set(m.neededFor.map(i => i.skillLabel.toLowerCase()))].join(" and ")}.`; }
  return out;
}
