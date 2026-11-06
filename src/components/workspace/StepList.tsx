"use client";

import { Icon, ArrowBendDownRightIcon, CaretDownIcon, FlagIcon, WarningIcon } from "@/components/icons";
import type { Step, WorkflowDoc } from "@/lib/workflows/schema";
import { explainDisconnected, outcomeText, workflowStructure } from "@/lib/workflows/structure";
import type { WorkspaceAgent } from "@/lib/workflows/view-types";
import { cx } from "@/lib/cx";
import { StepDetail } from "./StepDetail";
import { STEP_META, stepKicker } from "./step-meta";

const GUARD = new Set(["security_check", "approval", "payment"]);

/**
 * Accessible step list (the default on phones). The main sequence is numbered in execution order.
 * Branches (other outcomes) sit indented under the step they leave from, marked "Ends here" or
 * "Continues at step N". Disconnected steps are listed separately as invalid.
 */
export function StepList({ doc, agents, selected, onToggle, onSelect }: {
  doc: WorkflowDoc; agents: WorkspaceAgent[]; selected: string | null;
  onToggle: (id: string) => void; onSelect: (id: string) => void;
}) {
  const { main, enteredBy, branches, disconnected } = workflowStructure(doc);
  const number = new Map(main.map((s, i) => [s.id, i + 1]));
  const detail = (s: Step) => selected === s.id && (
    <StepDetail step={s} doc={doc} agents={agents} onSelect={onSelect} showHeader={false} className="border-t border-line px-4 py-4" />
  );

  return (
    <div className="space-y-4">
      <ol className="space-y-2" aria-label="Main sequence, in order">
        {main.map((s, i) => {
          const via = (enteredBy.get(s.id) ?? []).filter(o => o !== "next");
          const out = branches.get(s.id) ?? [];
          return (
            <li key={s.id} className={cx("rounded-2xl border", selected === s.id ? "border-accent-solid" : "border-line")}>
              <Row step={s} agents={agents} open={selected === s.id} onToggle={() => onToggle(s.id)}
                lead={<span className="w-5 flex-none text-right text-xs font-semibold tabular-nums text-muted">{i + 1}</span>}
                via={via.length ? `If ${outcomeText(via)}` : null} />
              {detail(s)}
              {out.length > 0 && (
                <ul className="space-y-2 border-t border-line px-3 pb-3 pt-2" aria-label={`Other outcomes of step ${i + 1}`}>
                  {out.map(b => (
                    <li key={b.outcomes.join("+")} className="ml-4 border-l-2 border-dashed border-line pl-3">
                      <p className="flex items-center gap-1.5 pt-1 text-xs font-medium text-muted">
                        <Icon icon={ArrowBendDownRightIcon} size={14} swap={false} className="flex-none" />
                        Branch: if <OutcomePill text={outcomeText(b.outcomes)} />
                      </p>
                      <ul className="mt-1.5 space-y-1.5">
                        {b.chain.map(c => (
                          <li key={c.id} className={cx("rounded-xl border bg-surface-2", selected === c.id ? "border-accent-solid" : "border-line")}>
                            <Row step={c} agents={agents} open={selected === c.id} onToggle={() => onToggle(c.id)} compact
                              tag={c.type === "end" ? "Ends here" : null} />
                            {detail(c)}
                          </li>
                        ))}
                      </ul>
                      {b.rejoins && <p className="mt-1.5 text-xs font-medium text-muted">Then continues at step {number.get(b.rejoins)}</p>}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ol>

      {disconnected.length > 0 && (
        <section aria-labelledby="disconnected-title" className="rounded-2xl border border-dashed border-danger p-3">
          <h3 id="disconnected-title" className="flex items-center gap-2 text-sm font-semibold text-danger">
            <Icon icon={WarningIcon} size={16} swap={false} /> Not connected ({disconnected.length})
          </h3>
          <p className="mt-0.5 text-sm text-muted">These steps can never run, so this version can&rsquo;t be approved.</p>
          <ul className="mt-2 space-y-2">
            {disconnected.map(d => (
              <li key={d.step.id} className={cx("rounded-xl border border-dashed", selected === d.step.id ? "border-danger" : "border-line")}>
                <Row step={d.step} agents={agents} open={selected === d.step.id} onToggle={() => onToggle(d.step.id)} compact invalid />
                <p className="px-3 pb-2.5 text-sm text-muted">{explainDisconnected(d)}</p>
                {selected === d.step.id && <StepDetail step={d.step} doc={doc} agents={agents} onSelect={onSelect} showHeader={false} className="border-t border-line px-4 py-4" />}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function OutcomePill({ text }: { text: string }) {
  return <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[0.6875rem] font-semibold text-ink ring-1 ring-line">{text}</span>;
}

function Row({ step, agents, open, onToggle, lead, via, tag, compact, invalid }: {
  step: Step; agents: WorkspaceAgent[]; open: boolean; onToggle: () => void;
  lead?: React.ReactNode; via?: string | null; tag?: string | null; compact?: boolean; invalid?: boolean;
}) {
  const meta = STEP_META[step.type];
  return (
    <button type="button" aria-expanded={open} onClick={onToggle}
      className={cx("icon-host flex w-full items-center gap-3 text-left", compact ? "px-3 py-2" : "px-3 py-2.5")}>
      {lead}
      <span className={cx("inline-flex flex-none items-center justify-center rounded-lg", compact ? "h-7 w-7" : "h-8 w-8",
        invalid ? "bg-surface-2 text-danger" : GUARD.has(step.type) ? "bg-accent-soft text-accent" : compact ? "bg-surface text-ink" : "bg-surface-2 text-ink")}>
        <Icon icon={meta.icon} size={compact ? 14 : 16} />
      </span>
      <span className="min-w-0 flex-1">
        <span className={cx("flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[0.6875rem] font-semibold uppercase tracking-[0.06em]", invalid ? "text-danger" : "text-muted")}>
          {via && <span className="rounded-full bg-accent-soft px-1.5 py-px normal-case tracking-normal text-accent">{via}</span>}
          {invalid ? "Not connected" : stepKicker(step, agents)}
          {tag && (
            <span className="inline-flex items-center gap-1 rounded-full px-1.5 py-px normal-case tracking-normal text-muted ring-1 ring-line">
              <Icon icon={FlagIcon} size={11} swap={false} /> {tag}
            </span>
          )}
        </span>
        <span className="block text-sm font-semibold text-ink">{step.title}</span>
      </span>
      <span className={cx("inline-flex flex-none text-muted transition-transform motion-reduce:transition-none", open && "rotate-180")}>
        <Icon icon={CaretDownIcon} size={16} swap={false} />
      </span>
    </button>
  );
}
