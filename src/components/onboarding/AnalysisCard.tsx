import type { Icon as PhosphorIcon } from "@phosphor-icons/react/dist/lib/types";
import { Icon, ArrowCounterClockwiseIcon, CircleNotchIcon, InfoIcon, LightningIcon, ListChecksIcon, QuotesIcon, TreeStructureIcon, WarningIcon } from "@/components/icons";
import type { DiscoveryView, ViewEvidence, ViewInsight } from "@/lib/discovery/view-types";
import { cx } from "@/lib/cx";

const SECTIONS: Array<{ key: "processes" | "repetitiveTasks" | "bottlenecks" | "opportunities"; title: string; icon: PhosphorIcon; empty: string }> = [
  { key: "processes", title: "Main processes", icon: TreeStructureIcon, empty: "No processes identified from your answers yet." },
  { key: "repetitiveTasks", title: "Repetitive work", icon: ListChecksIcon, empty: "Nothing clearly repetitive came up." },
  { key: "bottlenecks", title: "Bottlenecks", icon: WarningIcon, empty: "You didn't mention specific bottlenecks." },
  { key: "opportunities", title: "Automation opportunities", icon: LightningIcon, empty: "No clear automation opportunities from your answers." },
];

/** Stage 3 result. Every insight lists the evidence it rests on; inferences are labelled. */
export function AnalysisCard({ analysis, stale, onRefresh, refreshing, canRefresh }: {
  analysis: NonNullable<DiscoveryView["analysis"]>; stale: boolean; onRefresh: () => void; refreshing: boolean; canRefresh: boolean;
}) {
  return (
    <section aria-labelledby="analysis-title" className="enter card overflow-hidden">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-5 py-4">
        <h2 id="analysis-title" className="text-base font-semibold text-ink">How your business runs</h2>
        <span className="rounded-full bg-surface-2 px-2.5 py-0.5 text-[0.6875rem] font-medium text-muted ring-1 ring-line">
          {analysis.mode === "live" ? "Analysis by NEAR AI Cloud" : "Offline demo AI (rule-based)"}
        </span>
      </header>
      {stale && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line bg-accent-soft px-5 py-3">
          <p className="text-sm text-ink">You&rsquo;ve corrected the summary since this analysis was made.</p>
          {canRefresh && (
            <button type="button" onClick={onRefresh} disabled={refreshing} className="btn btn-primary btn-sm icon-host">
              {refreshing ? <span className="animate-spin motion-reduce:animate-none"><Icon icon={CircleNotchIcon} size={16} swap={false} /></span> : <Icon icon={ArrowCounterClockwiseIcon} size={16} />}
              Update analysis
            </button>
          )}
        </div>
      )}
      <div className="grid gap-px bg-line sm:grid-cols-2">
        {SECTIONS.map(s => (
          <div key={s.key} className="bg-surface p-5">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
              <Icon icon={s.icon} size={18} swap={false} className="text-accent" /> {s.title}
            </h3>
            {analysis[s.key].length === 0 ? (
              <p className="mt-3 text-sm font-light text-muted">{s.empty}</p>
            ) : (
              <ul className="mt-3 space-y-3">
                {analysis[s.key].map(item => <InsightItem key={item.title} item={item} />)}
              </ul>
            )}
          </div>
        ))}
      </div>
      {analysis.rejectedItems > 0 && (
        <p className="flex items-start gap-2 border-t border-line px-5 py-3 text-xs font-normal text-muted">
          <Icon icon={InfoIcon} size={14} swap={false} className="mt-0.5 flex-none" />
          {analysis.rejectedItems} suggestion{analysis.rejectedItems === 1 ? " was" : "s were"} left out because {analysis.rejectedItems === 1 ? "it wasn't" : "they weren't"} supported by your answers.
        </p>
      )}
    </section>
  );
}

function InsightItem({ item }: { item: ViewInsight }) {
  return (
    <li className="text-sm">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-semibold text-ink">
        {item.title}
        {item.basis === "assumed" && <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[0.6875rem] font-semibold text-accent">Assumption, please check</span>}
        {item.basis === "supported" && <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[0.6875rem] font-semibold text-ink ring-1 ring-line">Supported by your answers, not confirmed</span>}
      </p>
      {item.detail && <p className="mt-0.5 font-normal leading-normal text-muted">{item.detail}</p>}
      <EvidenceList evidence={item.evidence} />
    </li>
  );
}

export function EvidenceList({ evidence, className }: { evidence: ViewEvidence[]; className?: string }) {
  return (
    <ul className={cx("mt-1.5 space-y-1", className)} aria-label="Based on">
      {evidence.slice(0, 3).map((e, i) => (
        <li key={i} className="flex items-start gap-1.5 text-xs font-normal leading-normal text-muted">
          <Icon icon={QuotesIcon} size={12} swap={false} className="mt-0.5 flex-none text-accent" />
          <span>
            <span className="font-medium text-ink">{e.label}{e.kind === "field" && e.status === "assumed" ? " (unconfirmed)" : ""}:</span> “{e.text}”
          </span>
        </li>
      ))}
    </ul>
  );
}
