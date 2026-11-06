import type { CSSProperties } from "react";
import type { Icon as PhosphorIcon } from "@phosphor-icons/react/dist/lib/types";
import { Icon, ChartBarIcon, CheckCircleIcon, PackageIcon, ReceiptIcon, ShieldCheckIcon, TruckIcon, WalletIcon } from "@/components/icons";
import { Container, SectionHeader } from "@/components/ui/Section";
import { Reveal } from "@/components/motion/Reveal";

type Step = { icon: PhosphorIcon; agent: string; title: string; detail: string; badge?: string };

// Illustration of the restaurant demo loop (not live data).
const STEPS: Step[] = [
  { icon: ReceiptIcon, agent: "Order Agent", title: "Order received", detail: "Two rice bowls · checked against the menu" },
  { icon: PackageIcon, agent: "Inventory Agent", title: "Stock updated", detail: "Rice is below the reorder point" },
  { icon: TruckIcon, agent: "Procurement Agent", title: "Suppliers compared", detail: "3 quotes · best approved supplier chosen" },
  { icon: ShieldCheckIcon, agent: "Security check", title: "Payment checked", detail: "Approved recipient · within limits", badge: "ALLOW" },
  { icon: WalletIcon, agent: "Finance Agent", title: "Supplier paid", detail: "Through the treasury contract on NEAR testnet" },
  { icon: ChartBarIcon, agent: "Ledger", title: "Ledger updated", detail: "Sale, cost and payout recorded" },
];

export function WorkflowDemo() {
  return (
    <section aria-labelledby="workflow-title" className="py-20 sm:py-28">
      <Container>
        <SectionHeader
          id="workflow-title"
          eyebrow="Business workflow"
          title="Watch one order move through your business"
          intro="When a customer orders, your agents hand work to each other. Anything involving money passes a security check first."
        />

        <Reveal mode="group" className="mt-14">
          <div className="card overflow-hidden rounded-[var(--radius-panel)] p-5 sm:p-8">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-4">
              <p className="text-sm font-semibold text-ink">Restaurant demo · Order #1042</p>
              <span className="rounded-full bg-accent-soft px-3 py-1 text-xs font-medium text-accent">Illustration</span>
            </div>

            {/* Desktop: horizontal flow */}
            <ol className="relative mt-8 hidden grid-cols-6 gap-4 lg:grid">
              <span aria-hidden="true" className="absolute left-[8%] right-[8%] top-7 h-px bg-line" />
              <span aria-hidden="true" className="flow-line absolute left-[8%] right-[8%] top-7 h-[2px] bg-accent" />
              {STEPS.map((s, i) => <FlowStep key={s.title} step={s} index={i} />)}
            </ol>

            {/* Mobile / tablet: vertical flow */}
            <ol className="relative mt-6 space-y-5 lg:hidden">
              <span aria-hidden="true" className="absolute bottom-6 left-6 top-6 w-px bg-line" />
              <span aria-hidden="true" className="flow-line-y absolute bottom-6 left-6 top-6 w-[2px] bg-accent" />
              {STEPS.map((s, i) => <FlowStep key={s.title} step={s} index={i} vertical />)}
            </ol>
          </div>
        </Reveal>
      </Container>
    </section>
  );
}

function FlowStep({ step, index, vertical = false }: { step: Step; index: number; vertical?: boolean }) {
  const style = { "--step-delay": `${200 + index * 220}ms` } as CSSProperties;
  return (
    <li className={`flow-step relative ${vertical ? "flex gap-4" : "flex flex-col items-center text-center"}`} style={style}>
      <span className="relative z-10 inline-flex h-14 w-14 flex-none items-center justify-center rounded-2xl border border-line bg-surface text-ink shadow-[var(--shadow-card)]">
        <Icon icon={step.icon} size={24} swap={false} />
        <span className="absolute -right-1.5 -top-1.5 inline-flex h-5 w-5 items-center justify-center rounded-full bg-surface text-success">
          <Icon icon={CheckCircleIcon} size={18} swap={false} />
        </span>
      </span>
      <div className={vertical ? "pt-1" : "mt-4"}>
        <p className="text-xs font-medium uppercase tracking-wide text-muted">{step.agent}</p>
        <p className="mt-1 text-[0.9375rem] font-semibold text-ink">{step.title}</p>
        <p className="mt-1 text-sm font-light leading-normal text-muted">{step.detail}</p>
        {step.badge && (
          <span className="mt-2 inline-flex items-center gap-1 rounded-full bg-success/10 px-2.5 py-0.5 text-xs font-semibold text-success">
            {step.badge}
          </span>
        )}
      </div>
    </li>
  );
}
