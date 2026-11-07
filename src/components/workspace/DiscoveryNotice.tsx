import { Icon, InfoIcon } from "@/components/icons";

/**
 * M3.5: shown when this business's discovery was captured before the consultant could investigate
 * causes. Nothing approved is changed; test runs (M4) need a fresh discovery first.
 */
export function DiscoveryNotice() {
  return (
    <p role="note" className="mt-3 flex items-start gap-2 rounded-xl bg-surface-2 px-3 py-2.5 text-sm text-ink">
      <Icon icon={InfoIcon} size={16} swap={false} className="mt-0.5 flex-none text-accent" />
      <span>
        This discovery was captured before EmployAI's consultant could investigate the causes of your problems.
        Your approved team and workflows stay exactly as they are. <span className="text-muted">Test runs need a fresh discovery first, so the workflows rest on a checked understanding of the business.</span>
      </span>
    </p>
  );
}
