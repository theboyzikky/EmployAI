import type { ReactNode } from "react";
import { Icon, ChatTextIcon, CheckIcon, CompassIcon, ShieldCheckIcon, TreeStructureIcon, UserCheckIcon } from "@/components/icons";
import { Container, SectionHeader } from "@/components/ui/Section";
import { Reveal } from "@/components/motion/Reveal";
import { cx } from "@/lib/cx";

/**
 * "How it works": four steps, each card with its own miniature of what happens at that step (a chat,
 * a growing summary, the proposed team, an approved workflow), joined by a connector on desktop.
 * The miniatures are illustrations (aria-hidden): the step title and text carry the meaning.
 */
const STEPS: Array<{ icon: typeof ChatTextIcon; title: string; body: string; preview: ReactNode }> = [
  { icon: ChatTextIcon, title: "Describe your business", body: "Tell EmployAI what you do, how customers order and what slows you down — in your own words.", preview: <ChatPreview /> },
  { icon: CompassIcon, title: "Discover your operations", body: "A business consultant asks focused follow-up questions and keeps a clear summary of what it has understood.", preview: <UnderstandingPreview /> },
  { icon: UserCheckIcon, title: "Review your AI workforce", body: "See the recommended team: what each agent does, which tools it may use, its limits and what it never does.", preview: <TeamPreview /> },
  { icon: TreeStructureIcon, title: "Build, validate and approve workflows", body: "EmployAI generates the workflows and checks every step, then waits for your approval.", preview: <WorkflowPreview /> },
];

export function HowItWorks() {
  return (
    <section id="how-it-works" aria-labelledby="how-title" className="py-20 sm:py-28">
      <Container>
        <SectionHeader
          id="how-title"
          eyebrow="How EmployAI works"
          title="From a conversation to a working AI team"
          intro="No workflow builders, no code. You explain the business; EmployAI does the design work and asks for your approval at every step that matters."
        />
        <ol className="relative mt-14 grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
          {/* The journey line: visible only in the gaps between cards, level with the step icons. */}
          <span aria-hidden="true" style={{ top: 48 }} className="pointer-events-none absolute inset-x-0 hidden border-t border-dashed border-accent-line lg:block" />
          {STEPS.map((s, i) => {
            const last = i === STEPS.length - 1;
            return (
              <Reveal as="li" key={s.title} delay={i * 90}
                className="card relative flex flex-col overflow-hidden p-6 [background-image:linear-gradient(180deg,var(--color-accent-soft)_0%,transparent_38%)]">
                {/* Large step numeral, as a quiet watermark. */}
                <span aria-hidden="true" className="pointer-events-none absolute -right-2 -top-6 select-none text-[6.5rem] font-bold leading-none tracking-[-0.06em] text-accent opacity-[0.09]">0{i + 1}</span>
                <span aria-hidden="true" className={cx(
                  "relative inline-flex h-12 w-12 flex-none items-center justify-center rounded-2xl",
                  last ? "bg-accent-solid text-on-accent shadow-[0_0_0_6px_var(--color-accent-soft)]" : "bg-accent-soft text-ink ring-1 ring-accent-line",
                )}><Icon icon={s.icon} size={24} swap={false} /></span>
                <h3 className="relative mt-6 text-lg font-semibold leading-snug text-ink">
                  <span className="sr-only">Step {i + 1}: </span>{s.title}
                </h3>
                <p className="relative mt-2 text-sm font-light leading-relaxed text-muted">{s.body}</p>
                <div aria-hidden="true" className="relative mt-auto pt-6">
                  <div className="rounded-2xl border border-line bg-surface-2 p-3">{s.preview}</div>
                </div>
              </Reveal>
            );
          })}
        </ol>
      </Container>
    </section>
  );
}

/* ---- miniatures (decorative) ------------------------------------------------------------------- */

function ChatPreview() {
  return (
    <div className="space-y-2 text-[0.75rem] leading-snug">
      <p className="ml-auto w-fit max-w-[92%] rounded-2xl rounded-br-md bg-accent-solid px-3 py-2 text-on-accent">
        I run a small restaurant. We keep running out of rice<span className="ml-0.5 inline-block h-3 w-px translate-y-0.5 bg-current motion-safe:animate-pulse" />
      </p>
      <p className="w-fit max-w-[85%] rounded-2xl rounded-bl-md bg-surface px-3 py-2 text-muted ring-1 ring-line">How do you reorder today?</p>
    </div>
  );
}

function UnderstandingPreview() {
  const rows: Array<[string, boolean]> = [["Business: restaurant", true], ["Orders: counter, WhatsApp", true], ["Cause: phone reorders", true], ["Goals", false]];
  return (
    <div>
      <p className="text-[0.6875rem] font-semibold uppercase tracking-[0.08em] text-muted">What I understand · 3 of 4</p>
      <ul className="mt-2 space-y-1.5 text-[0.75rem]">
        {rows.map(([label, done]) => (
          <li key={label} className={cx("flex items-center gap-2", done ? "text-ink" : "text-muted")}>
            <span className={cx("inline-flex h-4 w-4 flex-none items-center justify-center rounded-full", done ? "bg-accent-solid text-on-accent" : "border border-dashed border-subtle")}>
              {done && <Icon icon={CheckIcon} size={10} swap={false} />}
            </span>
            {label}
          </li>
        ))}
      </ul>
    </div>
  );
}

function TeamPreview() {
  const agents = ["Orchestrator", "Order", "Inventory", "Procurement", "Finance"];
  return (
    <div>
      <div className="flex -space-x-2">
        {agents.map((a, i) => (
          <span key={a} title={a} className={cx(
            "inline-flex h-8 w-8 items-center justify-center rounded-full text-[0.6875rem] font-semibold ring-2 ring-surface-2",
            i === 0 ? "bg-accent-solid text-on-accent" : "bg-accent-soft text-accent",
          )}>{a[0]}</span>
        ))}
      </div>
      <p className="mt-2 flex items-center gap-1.5 text-[0.75rem] text-ink">
        <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-accent-solid text-on-accent"><Icon icon={CheckIcon} size={10} swap={false} /></span>
        5 agents · scoped tools and limits
      </p>
    </div>
  );
}

function WorkflowPreview() {
  const node = "rounded-lg bg-surface px-2 py-1 text-[0.6875rem] font-medium text-ink ring-1 ring-line";
  return (
    <div>
      <div className="flex items-center gap-1.5">
        <span className={node}>Order</span>
        <span className="h-px flex-1 bg-accent-line" />
        <span className={node}>Stock</span>
        <span className="h-px flex-1 bg-accent-line" />
        <span className={cx(node, "inline-flex items-center gap-1 text-accent ring-accent-line")}><Icon icon={ShieldCheckIcon} size={11} swap={false} />Check</span>
      </div>
      <p className="mt-2.5 inline-flex items-center gap-1.5 rounded-full bg-accent-solid px-2.5 py-1 text-[0.6875rem] font-semibold text-on-accent">
        <Icon icon={CheckIcon} size={11} swap={false} /> Approved by you
      </p>
    </div>
  );
}
