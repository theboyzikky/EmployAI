import type { ReactNode } from "react";
import type { Icon as PhosphorIcon } from "@phosphor-icons/react/dist/lib/types";
import { Icon, ChartLineUpIcon, InfoIcon, LightbulbIcon, QuestionIcon, SparkleIcon } from "@/components/icons";
import { cx } from "@/lib/cx";

type ConsultantKind = "question" | "insight" | "analysis" | "note" | "plain";
const KIND: Record<ConsultantKind, { label: string | null; icon: PhosphorIcon | null; bubble: string }> = {
  question: { label: "Question", icon: QuestionIcon, bubble: "border-line bg-surface" },
  insight: { label: "Insight", icon: LightbulbIcon, bubble: "border-accent-line bg-accent-soft" },
  analysis: { label: "Analysis", icon: ChartLineUpIcon, bubble: "border-accent-line bg-accent-soft" },
  note: { label: "Update", icon: InfoIcon, bubble: "border-line bg-surface-2" },
  plain: { label: null, icon: null, bubble: "border-line bg-surface" },
};

/** A consultant message. Text is rendered as plain text (never as HTML or markdown). */
export function ConsultantMessage({ children, label = "EmployAI consultant", kind = "plain" }: { children: ReactNode; label?: string; kind?: ConsultantKind }) {
  const k = KIND[kind];
  return (
    <div className="enter flex items-start gap-3">
      <span className="inline-flex h-9 w-9 flex-none items-center justify-center rounded-full bg-accent-solid text-on-accent" aria-hidden="true">
        <Icon icon={SparkleIcon} size={18} swap={false} />
      </span>
      <div className="min-w-0 max-w-[44rem]">
        <p className="flex items-center gap-2 text-xs font-semibold text-accent">
          {label}
          {k.label && k.icon && (
            <span className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-[0.6875rem] font-medium text-muted ring-1 ring-line">
              <Icon icon={k.icon} size={12} swap={false} /> {k.label}
            </span>
          )}
        </p>
        <div className={cx("mt-1 whitespace-pre-wrap break-words rounded-2xl rounded-tl-md border px-4 py-3 text-[0.9375rem] font-normal leading-relaxed text-ink shadow-[var(--shadow-card)]", k.bubble)}>
          {children}
        </div>
      </div>
    </div>
  );
}

export function UserMessage({ children, meta, faded = false }: { children: ReactNode; meta?: ReactNode; faded?: boolean }) {
  return (
    <div className="enter flex justify-end">
      <div className="min-w-0 max-w-[42rem]">
        <p className="text-right text-xs font-semibold text-muted">You{meta ? <> · {meta}</> : null}</p>
        <div className={cx("mt-1 whitespace-pre-wrap break-words rounded-2xl rounded-tr-md bg-ink px-4 py-3 text-[0.9375rem] font-normal leading-relaxed text-on-ink", faded && "opacity-70")}>
          {children}
        </div>
      </div>
    </div>
  );
}

/** A clearly labelled system note (status, not AI output). */
export function SystemNote({ children }: { children: ReactNode }) {
  return (
    <div role="status" className="enter mx-auto flex max-w-[40rem] items-start gap-2.5 rounded-2xl border border-dashed border-line bg-accent-soft px-4 py-3 text-sm font-normal leading-relaxed text-ink">
      <Icon icon={InfoIcon} size={18} swap={false} className="mt-0.5 flex-none text-accent" />
      <div>{children}</div>
    </div>
  );
}

/** "Consultant is thinking" indicator while a reply is on its way. */
export function Thinking({ label = "The consultant is thinking" }: { label?: string }) {
  return (
    <div className="flex items-center gap-3" role="status" aria-live="polite">
      <span className="inline-flex h-9 w-9 flex-none items-center justify-center rounded-full bg-accent-solid text-on-accent" aria-hidden="true">
        <Icon icon={SparkleIcon} size={18} swap={false} />
      </span>
      <span className="inline-flex items-center gap-2 rounded-2xl border border-line bg-surface px-4 py-3 text-sm text-muted">
        {label}
        <span className="inline-flex gap-1" aria-hidden="true">
          {[0, 1, 2].map(i => <span key={i} className="thinking-dot h-1.5 w-1.5 rounded-full bg-accent" style={{ animationDelay: `${i * 160}ms` }} />)}
        </span>
      </span>
    </div>
  );
}
