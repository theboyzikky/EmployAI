import type { Icon as PhosphorIcon } from "@phosphor-icons/react/dist/lib/types";
import { Icon, PackageIcon, ReceiptIcon, TreeStructureIcon, TruckIcon, WalletIcon } from "@/components/icons";
import { Container, SectionHeader } from "@/components/ui/Section";
import { Reveal } from "@/components/motion/Reveal";

type Agent = { icon: PhosphorIcon; name: string; role: string; does: string[]; never: string };

// The restaurant demo team. Other business types get a different team from the same capability catalogue.
const ORCHESTRATOR: Agent = {
  icon: TreeStructureIcon,
  name: "Business Orchestrator",
  role: "Coordinates the team",
  does: ["Runs the workflows you approved", "Hands each task to the right specialist", "Records every handoff and result"],
  never: "Never bypasses the security checks or grants itself permissions.",
};
const SPECIALISTS: Agent[] = [
  { icon: ReceiptIcon, name: "Order Agent", role: "Sales & orders", does: ["Checks each order against your menu", "Applies your minimum order value"], never: "Never changes prices or issues refunds on its own." },
  { icon: PackageIcon, name: "Inventory Agent", role: "Stock levels", does: ["Updates stock after every order", "Flags items below your reorder point"], never: "Never buys anything or changes financial rules." },
  { icon: TruckIcon, name: "Procurement Agent", role: "Suppliers", does: ["Compares supplier quotes", "Recommends the best approved option"], never: "Never pays an unknown supplier without checks." },
  { icon: WalletIcon, name: "Finance Agent", role: "Payments & budget", does: ["Checks budget and spending limits", "Requests payments through the security gate"], never: "Never holds an unrestricted wallet key." },
];

function AgentCard({ agent, featured = false }: { agent: Agent; featured?: boolean }) {
  return (
    <article className={`card flex h-full flex-col p-6 ${featured ? "bg-[linear-gradient(160deg,var(--color-surface)_40%,var(--color-accent-soft))]" : ""}`}>
      <div className="flex items-center gap-3">
        <span className="icon-tile">
          <Icon icon={agent.icon} size={24} swap={false} />
        </span>
        <div>
          <h3 className="text-lg font-semibold leading-tight text-ink">{agent.name}</h3>
          <p className="text-sm font-medium text-muted">{agent.role}</p>
        </div>
      </div>
      <ul className="mt-5 space-y-2">
        {agent.does.map(d => (
          <li key={d} className="flex gap-2 text-[0.9375rem] font-normal leading-snug text-ink/85">
            <span aria-hidden="true" className="mt-[0.45rem] h-1.5 w-1.5 flex-none rounded-full bg-accent" />
            {d}
          </li>
        ))}
      </ul>
      {featured && (
        <div className="mt-6">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted">Coordinates</p>
          <ul className="mt-3 grid grid-cols-2 gap-2">
            {SPECIALISTS.map(s => (
              <li key={s.name} className="flex items-center gap-2 rounded-xl border border-line bg-surface px-3 py-2 text-sm font-medium text-ink/85">
                <Icon icon={s.icon} size={16} swap={false} className="text-muted" />
                {s.name.replace(" Agent", "")}
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="mt-auto pt-5 text-sm font-light leading-snug text-muted">
        <span className="font-medium text-ink">Boundary: </span>{agent.never}
      </p>
    </article>
  );
}

export function Workforce() {
  return (
    <section id="agents" aria-labelledby="agents-title" className="bg-surface py-20 sm:py-28">
      <Container>
        <SectionHeader
          id="agents-title"
          eyebrow="Meet your AI workforce"
          title="A small team of specialists, each with a clear job"
          intro="EmployAI only recommends agents with a real purpose for your business. Here is the team it builds for our demonstration restaurant."
        />
        <div className="mt-14 grid gap-5 lg:grid-cols-3">
          <Reveal className="lg:row-span-2">
            <AgentCard agent={ORCHESTRATOR} featured />
          </Reveal>
          <div className="grid gap-5 sm:grid-cols-2 lg:col-span-2">
            {SPECIALISTS.map((a, i) => (
              <Reveal key={a.name} delay={(i + 1) * 80}>
                <AgentCard agent={a} />
              </Reveal>
            ))}
          </div>
        </div>
        <Reveal delay={200}>
          <p className="mx-auto mt-8 max-w-2xl text-center text-sm font-light text-muted">
            Run a salon, a shop or a service business? You&rsquo;ll get a different team, built from the same catalogue of capabilities and the same safety rules.
          </p>
        </Reveal>
      </Container>
    </section>
  );
}
