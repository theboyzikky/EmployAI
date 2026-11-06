import type { Icon as PhosphorIcon } from "@phosphor-icons/react/dist/lib/types";
import { Icon, CalculatorIcon, ChatCircleDotsIcon, CreditCardIcon, LockKeyIcon, PlugsIcon, SparkleIcon, StorefrontIcon } from "@/components/icons";
import { Container, SectionHeader } from "@/components/ui/Section";
import { Reveal } from "@/components/motion/Reveal";

// Only integrations that exist in this build are shown as available (PRD §17.4, FR-01).
// Everything else is a generic category, clearly marked "Planned". No third-party logos.
const AVAILABLE: Array<{ icon: PhosphorIcon; name: string; detail: string; status: string }> = [
  { icon: SparkleIcon, name: "NEAR AI Cloud", detail: "Powers business discovery, analysis and agent reasoning.", status: "Core" },
  { icon: LockKeyIcon, name: "NEAR Protocol (testnet)", detail: "Agent account, policy-enforcing treasury contract and on-chain ledger references.", status: "Testnet" },
];
const PLANNED: Array<{ icon: PhosphorIcon; name: string }> = [
  { icon: StorefrontIcon, name: "Order intake & storefronts" },
  { icon: ChatCircleDotsIcon, name: "Customer messaging" },
  { icon: CreditCardIcon, name: "Payments" },
  { icon: CalculatorIcon, name: "Accounting" },
];

export function Integrations() {
  return (
    <section id="integrations" aria-labelledby="integrations-title" className="py-20 sm:py-28">
      <Container>
        <SectionHeader
          id="integrations-title"
          eyebrow="Supported integrations"
          title="Built on NEAR, honest about the rest"
          intro="This prototype lists only what actually works today. Connectors for the tools you already use are on the roadmap and are labelled that way."
        />
        <div className="mt-14 grid gap-5 md:grid-cols-2">
          {AVAILABLE.map((a, i) => (
            <Reveal key={a.name} delay={i * 80} className="card flex gap-4 p-6">
              <span className="inline-flex h-12 w-12 flex-none items-center justify-center rounded-2xl bg-ink text-on-ink">
                <Icon icon={a.icon} size={24} swap={false} />
              </span>
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-lg font-semibold text-ink">{a.name}</h3>
                  <span className="rounded-full bg-success/10 px-2.5 py-0.5 text-xs font-semibold text-success">{a.status}</span>
                </div>
                <p className="mt-1.5 text-[0.9375rem] font-light leading-relaxed text-muted">{a.detail}</p>
              </div>
            </Reveal>
          ))}
        </div>
        <Reveal delay={120} className="mt-5">
          <div className="rounded-[var(--radius-card)] border border-dashed border-line bg-surface p-6">
            <p className="flex items-center gap-2 text-sm font-semibold text-ink">
              <Icon icon={PlugsIcon} size={18} swap={false} className="text-muted" /> Planned connector categories
            </p>
            <ul className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {PLANNED.map(p => (
                <li key={p.name} className="flex items-center gap-3 rounded-xl bg-surface-2 px-4 py-3 text-[0.9375rem] font-medium text-ink/80">
                  <Icon icon={p.icon} size={20} swap={false} />
                  <span className="flex-1">{p.name}</span>
                  <span className="text-xs font-medium text-muted">Planned</span>
                </li>
              ))}
            </ul>
          </div>
        </Reveal>
      </Container>
    </section>
  );
}
