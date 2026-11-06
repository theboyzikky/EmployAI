import type { ReactNode } from "react";
import { Icon, ArrowRightIcon, ClockIcon, WarningIcon } from "@/components/icons";
import { OUTCOME_LABELS } from "@/lib/workflows/layout";
import { OUTCOMES, type Step, type WorkflowDoc } from "@/lib/workflows/schema";
import { explainDisconnected, workflowStructure } from "@/lib/workflows/structure";
import type { WorkspaceAgent } from "@/lib/workflows/view-types";
import { cx } from "@/lib/cx";
import { STEP_META, stepActor, taskLabel } from "./step-meta";
import { ngn } from "./workspace-api";

const END_TEXT: Record<string, string> = {
  completed: "The demo order is handled and the restock request is recorded.",
  no_reorder: "Stock is above every reorder point, so nothing is bought.",
  manual_order: "The workflow stops at a recommendation. You place the supplier order yourself.",
  blocked: "The security check blocked the payment request. Nothing is paid and you are told why.",
  rejected: "You declined the payment request. Nothing is paid.",
};

const OUTCOME_HELP: Record<string, string> = {
  allow: "Within your rules",
  warn: "Unusual: always needs your approval",
  block: "Breaks a rule: stops, nothing is paid",
  approved: "Approved (by you, or automatically within your rules)",
  rejected: "You decline",
};

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-semibold uppercase tracking-[0.06em] text-muted">{label}</dt>
      <dd className="mt-0.5 text-sm text-ink">{children}</dd>
    </div>
  );
}

/** A labelled, boxed fact: used for the payment's key facts so they stand out on any screen. */
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rounded-xl border border-line bg-surface-2 p-3">
      <dt className="text-xs font-semibold uppercase tracking-[0.06em] text-muted">{label}</dt>
      <dd className="mt-1 text-sm text-ink">{children}</dd>
    </div>
  );
}

const chips = (items: string[]) => items.length === 0 ? <span className="text-muted">None</span> : (
  <span className="flex flex-wrap gap-1.5">
    {items.map(t => <span key={t} className="rounded-md bg-surface-2 px-1.5 py-0.5 text-xs font-medium text-ink ring-1 ring-line">{t.replace(/_/g, " ")}</span>)}
  </span>
);

/** Plain-language detail for one step. Every step is described only: nothing here runs in M3. */
export function StepDetail({ step, doc, agents, onSelect, className, showHeader = true }: { step: Step; doc: WorkflowDoc; agents: WorkspaceAgent[]; onSelect: (id: string) => void; className?: string; showHeader?: boolean }) {
  const meta = STEP_META[step.type];
  const byId = new Map(doc.steps.map(s => [s.id, s]));
  const p = doc.params;
  const { disconnected } = workflowStructure(doc);
  const isolated = disconnected.find(d => d.step.id === step.id);
  // Outcomes of THIS step that should lead to a disconnected step (the broken connection).
  const brokenOutcomes = new Map(disconnected.filter(d => d.expected?.from.id === step.id).map(d => [d.expected!.outcome, d.step]));
  const title = (id: string) => `“${byId.get(id)?.title ?? id}”`;
  const guards = step.type === "payment" ? {
    security: doc.steps.find(s => s.type === "security_check" && s.subject === step.id),
    approval: doc.steps.find(s => s.type === "approval" && s.subject === step.id),
  } : null;

  return (
    <div className={cx("space-y-4", className)}>
      {showHeader && (
        <div className="flex items-start gap-3">
          <span className={cx("inline-flex h-10 w-10 flex-none items-center justify-center rounded-xl",
            step.type === "payment" || step.type === "security_check" || step.type === "approval" ? "bg-accent-soft text-accent" : "bg-surface-2 text-ink")}>
            <Icon icon={meta.icon} size={20} swap={false} />
          </span>
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.06em] text-muted">{meta.label} · {stepActor(step, agents)}</p>
            <h3 className="text-base font-semibold leading-snug text-ink">{step.title}</h3>
          </div>
        </div>
      )}
      {isolated && (
        <p role="note" className="flex items-start gap-2 rounded-xl border border-dashed border-danger px-3 py-2.5 text-sm text-ink">
          <Icon icon={WarningIcon} size={16} swap={false} className="mt-0.5 flex-none text-danger" />
          <span><span className="font-semibold text-danger">Not connected. </span>{explainDisconnected(isolated)} A workflow with a disconnected step can&rsquo;t be approved.</span>
        </p>
      )}
      {step.description && <p className="text-sm leading-relaxed text-ink">{step.description}</p>}

      <dl className="space-y-3">
        {step.type === "trigger" && (
          <Field label="Starts from">{step.source === "demo_order" ? "A demo customer order (fictional)" : "A demo stock check (fictional)"}</Field>
        )}
        {step.type === "agent_task" && (<>
          <Field label="Task">{taskLabel(agents, step.agent, step.task)}</Field>
          <Field label="Uses">{step.input}</Field>
          <Field label="Produces">{step.output}</Field>
          <Field label="Tools it may use">{chips(step.tools)}</Field>
          <Field label="Data">{`Reads ${step.reads.join(", ") || "nothing"} · writes ${step.writes.join(", ") || "nothing"}`}</Field>
        </>)}
        {step.type === "condition" && (
          <Field label="Question">Is any item in the demo stock below its reorder point?</Field>
        )}
        {step.type === "security_check" && (<>
          <Field label="Guards">The payment request {title(step.subject)}. Nothing can be paid without passing this check.</Field>
          <Field label="Checks">Your limits (at most {ngn(p.max_payment_ngn)} per payment, illustrative) and the approved-supplier list. The gate&rsquo;s rules are enforced in a later stage.</Field>
        </>)}
        {step.type === "approval" && (
          <Field label="When you are asked">When the amount is above {ngn(p.approval_threshold_ngn)} (illustrative), or the security check returns WARN. A payment the security check allows at or below that amount needs no extra approval from you.</Field>
        )}
        {step.type === "payment" && guards && (<>
          <Fact label="Who gets paid · beneficiary">The approved supplier recommended in {title(step.beneficiary.from_step)}. Suppliers that aren&rsquo;t approved can never be paid.</Fact>
          <Fact label="How it’s requested · treasury channel">A <span className="font-medium">request_payment</span> call to the EmployAI treasury contract on NEAR testnet. The contract holds the funds and is never the recipient; its account is set up in a later stage.</Fact>
          <Fact label="Payment authority">The Finance Agent can only <span className="font-medium">request</span> this payment. It can&rsquo;t send funds directly, choose a different recipient or hold a wallet key.</Fact>
          <Fact label="Security conditions">
            Reached only after {guards.security ? title(guards.security.id) : "a security check"} returns ALLOW or WARN, and then {guards.approval ? title(guards.approval.id) : "your approval check"}: your approval is required above {ngn(p.approval_threshold_ngn)} or after a WARN. A BLOCK stops it.
          </Fact>
          <Field label="Amount">From the supplier&rsquo;s quote, in illustrative Nigerian naira. Never more than {ngn(p.max_payment_ngn)} per payment.</Field>
          <p className="rounded-xl bg-surface-2 px-3 py-2 text-xs leading-relaxed text-muted ring-1 ring-line">
            NEAR contract limits and network fees are set separately in a later stage (M5). Nothing is converted between naira and NEAR.
          </p>
          <Field label="Mode">Test run only. Nothing is paid in this stage.</Field>
        </>)}
        {step.type === "notify" && (
          <Field label="Goes to">{step.audience === "customer" ? "The demo customer" : "You"}{step.task ? ` · ${taskLabel(agents, step.agent, step.task)}` : ""}. Shown in the demo only; nothing is sent.</Field>
        )}
        {step.type === "end" && <Field label="Result">{END_TEXT[step.result]}</Field>}
      </dl>

      {OUTCOMES[step.type].length > 0 && (
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.06em] text-muted">What happens next</p>
          <ul className="mt-1.5 space-y-2">
            {OUTCOMES[step.type].map(o => {
              const to = step.next[o];
              const target = to ? byId.get(to) : undefined;
              const expected = brokenOutcomes.get(o);
              return (
                <li key={o} className="text-sm">
                  {o !== "next" && (
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[0.6875rem] font-semibold text-ink ring-1 ring-line">{OUTCOME_LABELS[o] ?? o}</span>
                      {OUTCOME_HELP[o] && <span className="text-muted">{OUTCOME_HELP[o]}</span>}
                    </span>
                  )}
                  <span className={cx("flex items-start gap-1.5", o !== "next" && "mt-1")}>
                    <Icon icon={ArrowRightIcon} size={14} swap={false} className="mt-[3px] flex-none text-muted" />
                    {target
                      ? <button type="button" onClick={() => onSelect(target.id)} className="min-w-0 text-left font-medium text-accent underline-offset-2 hover:underline">{target.title}</button>
                      : <span className="text-danger">Not connected</span>}
                  </span>
                  {expected && (
                    <span className="mt-1 flex items-start gap-1.5 text-danger">
                      <Icon icon={WarningIcon} size={14} swap={false} className="mt-[3px] flex-none" />
                      <span>Should lead to “{expected.title}”, which is now disconnected.</span>
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <p className="flex items-center gap-1.5 text-xs font-medium text-muted">
        <Icon icon={ClockIcon} size={14} swap={false} /> Described only — test runs start in the next stage
      </p>
    </div>
  );
}
