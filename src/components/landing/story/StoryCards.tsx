import { Icon, CheckCircleIcon } from "@/components/icons";
import { cx } from "@/lib/cx";
import { AGENTS, BUSINESS, DECISIONS, OPERATIONS, STEPS, type StoryAgent } from "./story-data";

// Presentational cards shared by the animated film and its static (reduced-motion) alternative.
// Static icons only: Regular weight, never Fill.

export function BusinessCard({ className }: { className?: string }) {
  return (
    <div className={cx("film-card film-card-hero p-5", className)}>
      <div className="flex items-center gap-3">
        <span className="icon-tile !h-11 !w-11 !rounded-[14px]"><Icon icon={BUSINESS.icon} size={22} swap={false} /></span>
        <div className="min-w-0">
          <p className="truncate text-[0.9375rem] font-semibold leading-tight text-ink">{BUSINESS.name}</p>
          <p className="mt-0.5 text-xs font-medium text-muted">{BUSINESS.industry} · fictional demo</p>
        </div>
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2.5">
        {BUSINESS.details.map(d => (
          <div key={d.label} className="min-w-0">
            <dt className="text-[0.6875rem] font-medium uppercase tracking-[0.08em] text-muted">{d.label}</dt>
            <dd className="text-[0.8125rem] font-medium leading-snug text-ink">{d.value}</dd>
          </div>
        ))}
      </dl>
      {/* Footer: "learning" while EmployAI studies the business; "coordinated" in the finale. */}
      <div className="film-biz-footer relative mt-4 h-9 border-t border-line pt-3">
        <div className="film-biz-learning absolute inset-x-0 top-3">
          <div className="flex items-center justify-between text-[0.75rem] font-medium text-muted">
            <span>Learning how you operate</span>
            <span className="film-learn-pct tabular-nums" />
          </div>
          <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-accent-soft">
            <div className="film-learn-bar h-full origin-left rounded-full bg-accent-solid" />
          </div>
        </div>
        <p className="film-biz-done absolute inset-x-0 top-3 flex items-center gap-1.5 text-[0.75rem] font-semibold text-ink">
          <Icon icon={CheckCircleIcon} size={16} swap={false} className="text-success" />
          Operations coordinated by your AI workforce
        </p>
      </div>
    </div>
  );
}

export function OperationCard({ index, className }: { index: number; className?: string }) {
  const op = OPERATIONS[index];
  return (
    <div className={cx("film-card flex items-center gap-3 p-3.5", className)}>
      <span className="inline-flex h-9 w-9 flex-none items-center justify-center rounded-xl bg-surface-2 text-ink">
        <Icon icon={op.icon} size={18} swap={false} />
      </span>
      <div className="min-w-0">
        <p className="text-[0.8125rem] font-semibold leading-tight text-ink">{op.title}</p>
        <p className="mt-0.5 text-[0.75rem] font-light leading-snug text-muted">{op.detail}</p>
      </div>
    </div>
  );
}

function SignalBars({ agent }: { agent: StoryAgent }) {
  return (
    <span aria-hidden="true" className="film-bars inline-flex h-3.5 items-end gap-[2px]">
      {agent.bars.map((h, i) => (
        <span key={i} className="w-[3px] rounded-full bg-accent" style={{ height: `${Math.round(h * 100)}%` }} />
      ))}
    </span>
  );
}

export function AgentCard({ index, className }: { index: number; className?: string }) {
  const agent = AGENTS[index];
  const lead = index === 0;
  return (
    <div className={cx("film-card film-agent p-3.5", lead && "film-agent-lead", className)}>
      <div className="flex items-center gap-2.5">
        <span className={cx("inline-flex h-9 w-9 flex-none items-center justify-center rounded-xl", lead ? "bg-ink text-on-ink" : "bg-accent-soft text-accent")}>
          <Icon icon={agent.icon} size={18} swap={false} />
        </span>
        <div className="min-w-0">
          <p className="text-[0.8125rem] font-semibold leading-tight text-ink">{agent.name}</p>
          <p className="film-agent-role mt-0.5 truncate text-[0.6875rem] font-light text-muted">{agent.role}</p>
        </div>
      </div>
      <div className="mt-2.5 flex items-center justify-between border-t border-line pt-2">
        <span className="inline-flex items-center gap-1.5 text-[0.6875rem] font-medium text-muted">
          <span className="film-agent-dot h-1.5 w-1.5 rounded-full bg-subtle" />
          {agent.signal}
        </span>
        <SignalBars agent={agent} />
      </div>
    </div>
  );
}

/** Six-step operational sequence. `state` per step is driven by the film; the static version passes "done". */
export function StepsPanel({ className, staticDone = false }: { className?: string; staticDone?: boolean }) {
  const state = staticDone ? "done" : "pending";
  return (
    <div className={cx("film-card film-card-hero p-4", className)}>
      <div className="flex items-center justify-between gap-3 border-b border-line pb-3">
        <p className="text-[0.8125rem] font-semibold text-ink">Order #1042</p>
        <span className="rounded-full bg-accent-soft px-2.5 py-0.5 text-[0.6875rem] font-semibold text-accent">Simulated run</span>
      </div>
      <ol className="mt-2 space-y-1">
        {STEPS.map((s, i) => (
          <li key={s.title} className="film-step flex items-center gap-3 rounded-xl px-2 py-1.5" data-step={i} data-state={state}>
            <span className="film-step-icon relative inline-flex h-8 w-8 flex-none items-center justify-center rounded-lg bg-surface-2 text-ink">
              <Icon icon={s.icon} size={16} swap={false} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[0.8125rem] font-semibold leading-tight text-ink">{s.title}</p>
              <p className="truncate text-[0.6875rem] font-light text-muted">{s.by} · {s.detail}</p>
            </div>
            <Icon icon={CheckCircleIcon} size={16} swap={false} className="film-step-check text-success" />
          </li>
        ))}
        <li className="film-step rounded-xl px-2 py-2" data-step={STEPS.length} data-state={state}>
          <p className="text-[0.6875rem] font-medium uppercase tracking-[0.08em] text-muted">Security decision</p>
          <div className="mt-1.5 flex gap-1.5">
            {DECISIONS.map(d => (
              <span key={d} className="film-decision rounded-full border px-2.5 py-0.5 text-[0.6875rem] font-semibold" data-decision={d}>
                {d}
              </span>
            ))}
          </div>
          <p className="film-decision-note mt-1.5 text-[0.6875rem] font-light text-muted">ALLOW · approved supplier, within the daily limit</p>
        </li>
      </ol>
    </div>
  );
}
