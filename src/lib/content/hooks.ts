import "server-only";
// Content ↔ action coupling (registered on import by the automation handlers):
//  guard     — at every delivery, in the same commit: the post still exists, is still scheduled and its
//              caption is EXACTLY the approved one. A cancelled or edited post is never published.
//  observer  — whenever the publish action changes status, the post follows in the same commit:
//              sending → publishing · done → published (real media id + permalink, the proof) ·
//              rejected → failed · unknown → publishing (being verified) · escalated → needs attention ·
//              aborted → back to draft/failed with the reason (nothing was published).
import { registerActionGuard, registerActionObserver } from "@/lib/integrations/actions";
import { audit } from "@/lib/integrations/connections";
import { finalCaption, PUBLISH_ACTIONS } from "./service";

for (const action of PUBLISH_ACTIONS) registerActionGuard(action, (s, a) => {
  const id = String(a.input.content_item_id ?? "");
  const item = ((s.content_items ?? {})[a.business_id] ?? []).find(i => i.id === id);
  if (!item) return { ok: false, code: "CONTENT_MISSING", message: "The post no longer exists." };
  if (item.status !== "scheduled" && item.status !== "publishing") return { ok: false, code: "CONTENT_NOT_APPROVED", message: "The post isn't approved and scheduled (it was cancelled or changed)." };
  if (String(a.input.caption) !== finalCaption(item)) return { ok: false, code: "CONTENT_CHANGED", message: "The caption differs from the one the owner approved." };
  return { ok: true };
});

for (const action of PUBLISH_ACTIONS) registerActionObserver(action, (s, a) => {
  const id = String(a.input.content_item_id ?? "");
  const item = ((s.content_items ?? {})[a.business_id] ?? []).find(i => i.id === id);
  if (!item || item.action_attempt_id !== a.id) return;
  const now = new Date().toISOString();
  item.updated_at = now;
  switch (a.status) {
    case "sending": case "unknown":
      if (item.status === "scheduled") item.status = "publishing";
      item.error = a.status === "unknown" ? "The platform didn't confirm; verifying before anything is retried." : null;
      return;
    case "prepared":     // a provider asked us to wait (retryable refusal): still scheduled
      item.status = "scheduled"; item.error = a.error?.message ?? null; return;
    case "done": {
      const r = (a.result ?? {}) as { permalink?: string | null; media_id?: string };
      item.status = "published"; item.media_id = a.provider_ref; item.permalink = r.permalink ?? null; item.published_at = now; item.error = null;
      audit(s, a.business_id, `agent:${a.agent}`, "content.published", `content:${item.id}`, "published", item.id, { media_id: a.provider_ref, permalink: item.permalink });
      return;
    }
    case "rejected":
      item.status = "failed"; item.error = a.error?.message ?? "The platform refused the post.";
      audit(s, a.business_id, "system", "content.failed", `content:${item.id}`, "failed", item.id, { code: a.error?.code });
      return;
    case "escalated":
      item.status = "needs_attention"; item.error = a.error?.message ?? "Couldn't confirm the publication.";
      audit(s, a.business_id, "system", "content.needs_attention", `content:${item.id}`, "needs_attention", item.id);
      return;
    case "aborted":
      if (item.status === "scheduled" || item.status === "publishing") { item.status = "failed"; item.error = a.error?.message ?? "Stopped before publishing; nothing was published."; }
      return;
  }
});

export const CONTENT_HOOKS_REGISTERED = true;
