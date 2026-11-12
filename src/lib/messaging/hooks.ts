import "server-only";
// Ties reply actions to their conversation messages:
//  - the GUARD re-checks at send time that the message is still approved and its text unchanged;
//  - the OBSERVER keeps the message's status in step with the action (sent with the provider's id,
//    failed, or waiting for the owner when the outcome is unknown and can't be safely re-sent).
import { audit } from "@/lib/integrations/connections";
import { registerActionGuard, registerActionObserver } from "@/lib/integrations/actions";
import { REPLY_ACTIONS } from "./service";

for (const action of REPLY_ACTIONS) {
  registerActionGuard(action, (s, a) => {
    const c = ((s.conversations ?? {})[a.business_id] ?? []).find(x => x.id === String(a.input.conversation_id ?? ""));
    const m = c?.messages.find(x => x.id === String(a.input.message_id ?? ""));
    if (!c || !m) return { ok: false, code: "MESSAGE_MISSING", message: "The reply no longer exists." };
    if (m.status !== "approved" && m.status !== "sending") return { ok: false, code: "MESSAGE_NOT_APPROVED", message: "The reply isn't approved (it was discarded or changed)." };
    if (String(a.input.text) !== m.text) return { ok: false, code: "MESSAGE_CHANGED", message: "The text differs from the approved reply." };
    return { ok: true };
  });
  registerActionObserver(action, (s, a) => {
    const c = ((s.conversations ?? {})[a.business_id] ?? []).find(x => x.id === String(a.input.conversation_id ?? ""));
    const m = c?.messages.find(x => x.id === String(a.input.message_id ?? ""));
    if (!c || !m || m.attempt_id !== a.id) return;
    c.updated_at = new Date().toISOString();
    switch (a.status) {
      case "sending": m.status = "sending"; return;
      case "done":
        m.status = "sent"; m.provider_id = a.provider_ref; m.at = new Date().toISOString();
        if (c.status === "needs_owner" && m.by === "owner") c.status = "open";
        audit(s, a.business_id, `agent:${a.agent}`, "reply.sent", `conversation:${c.id}`, "sent", c.id, { channel: c.channel });
        return;
      case "rejected": case "aborted":
        m.status = "failed"; m.note = a.error?.message ?? "The platform refused the reply.";
        audit(s, a.business_id, "system", "reply.failed", `conversation:${c.id}`, "failed", c.id, { code: a.error?.code ?? null });
        return;
      case "unknown": case "escalated":
        m.status = "needs_attention"; m.note = a.status === "escalated" ? "We can't tell whether this reached the customer, and re-sending could duplicate it. Check on the platform." : "Delivery unconfirmed; checking.";
        if (a.status === "escalated") { c.status = "needs_owner"; c.escalation = { reason: "A reply's delivery couldn't be confirmed.", at: new Date().toISOString() }; }
        return;
      case "prepared": m.note = a.error?.message ?? m.note ?? null; return;
    }
  });
}

export const MESSAGING_HOOKS_REGISTERED = true;
