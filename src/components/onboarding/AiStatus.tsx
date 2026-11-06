import { Icon, ArrowCounterClockwiseIcon, CircleNotchIcon, CpuIcon, WarningIcon } from "@/components/icons";
import type { DiscoveryView } from "@/lib/discovery/view-types";
import { cx } from "@/lib/cx";

/** Honest "AI mode" label, always visible in the top bar. */
export function AiModeBadge({ ai }: { ai: DiscoveryView["ai"] }) {
  const unavailable = !!ai.problem;
  const offline = ai.provider === "mock";
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-[0.6875rem] font-semibold",
        unavailable ? "bg-danger/10 text-danger" : offline ? "bg-surface-2 text-muted ring-1 ring-line" : "bg-accent-soft text-accent",
      )}
      title={unavailable ? ai.problem ?? undefined : offline ? "Rule-based offline consultant for development and testing. No AI service is called." : "Answers come from NEAR AI Cloud."}
    >
      <Icon icon={unavailable ? WarningIcon : CpuIcon} size={14} swap={false} />
      <span className="hidden sm:inline">{unavailable ? "AI unavailable" : ai.label}</span>
      <span className="sm:hidden [@media(max-width:359px)]:sr-only">{unavailable ? "AI unavailable" : offline ? "Offline AI" : "NEAR AI"}</span>
    </span>
  );
}

/**
 * Shown when the AI provider fails. The owner's message is already saved, and EmployAI never
 * switches to a different AI automatically.
 */
export function AiUnavailable({ message, onRetry, retrying }: { message: string; onRetry: () => void; retrying: boolean }) {
  return (
    <div role="alert" className="enter rounded-2xl border border-danger/40 bg-danger/5 px-4 py-3.5">
      <p className="flex items-center gap-2 text-sm font-semibold text-ink">
        <Icon icon={WarningIcon} size={18} swap={false} className="text-danger" /> The AI consultant is unavailable
      </p>
      <p className="mt-1 text-sm font-normal leading-relaxed text-muted">
        {message} Your conversation is saved, so nothing is lost. EmployAI never switches to a different AI on its own.
      </p>
      <button type="button" onClick={onRetry} disabled={retrying} className="btn btn-secondary btn-sm icon-host mt-3">
        {retrying ? <span className="animate-spin motion-reduce:animate-none"><Icon icon={CircleNotchIcon} size={16} swap={false} /></span> : <Icon icon={ArrowCounterClockwiseIcon} size={16} />}
        Try again
      </button>
    </div>
  );
}
