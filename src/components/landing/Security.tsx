import type { Icon as PhosphorIcon } from "@phosphor-icons/react/dist/lib/types";
import { Icon, GaugeIcon, HandPalmIcon, KeyIcon, ListChecksIcon, PowerIcon, UserCheckIcon } from "@/components/icons";
import { Container, SectionHeader } from "@/components/ui/Section";
import { Reveal } from "@/components/motion/Reveal";

const CONTROLS: Array<{ icon: PhosphorIcon; title: string; body: string }> = [
  { icon: UserCheckIcon, title: "You approve the team", body: "No agent runs until you have reviewed its job, its tools and its limits." },
  { icon: GaugeIcon, title: "Spending limits", body: "Per-payment and daily limits from your policy, checked by EmployAI and again by the treasury contract." },
  { icon: HandPalmIcon, title: "Approval queue", body: "Unusual payments pause and wait for you, with the amount, recipient, reasons and an expiry." },
  { icon: ListChecksIcon, title: "Recipient checks", body: "Account age, activity, contract changes, past payments and a shared blocklist — before anything is signed." },
  { icon: KeyIcon, title: "Restricted keys", body: "The paying agent's key can call one treasury method only. It cannot move funds directly or change its own limits." },
  { icon: PowerIcon, title: "Kill switch", body: "Stop every agent instantly. Pending approvals are cancelled and nothing new is signed." },
];

export function Security() {
  return (
    <section id="security" aria-labelledby="security-title" className="relative isolate overflow-hidden border-y border-line bg-band py-20 text-on-band sm:py-28">
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(60%_55%_at_50%_0%,var(--eai-glow-strong),transparent)]" />
      <Container>
        <div className="mx-auto max-w-2xl text-center">
          <Reveal><span className="eyebrow !bg-white/10 !text-on-band">Security &amp; business control</span></Reveal>
          <Reveal delay={80}>
            <h2 id="security-title" className="mt-4 text-[1.875rem] font-semibold leading-[1.15] tracking-[-0.02em] sm:text-[2.5rem]">
              Autonomy inside rules you set
            </h2>
          </Reveal>
          <Reveal delay={160}>
            <p className="mt-4 text-[1.0625rem] font-light leading-relaxed text-on-band/75 sm:text-lg">
              Agents can propose payments, but deterministic checks decide. Instructions hidden in a supplier message or a customer order can never override your policy.
            </p>
          </Reveal>
        </div>
        <ul className="mt-14 grid gap-8 sm:grid-cols-2 lg:grid-cols-3">
          {CONTROLS.map((c, i) => (
            <Reveal as="li" key={c.title} delay={i * 70} className="rounded-[var(--radius-card)] border border-white/10 bg-white/[0.04] p-6">
              <span className="inline-flex h-11 w-11 items-center justify-center rounded-xl bg-white/10 text-on-band">
                <Icon icon={c.icon} size={22} swap={false} />
              </span>
              <h3 className="mt-4 text-[1.0625rem] font-semibold">{c.title}</h3>
              <p className="mt-2 text-[0.9375rem] font-light leading-relaxed text-on-band/70">{c.body}</p>
            </Reveal>
          ))}
        </ul>
        <Reveal delay={150}>
          <p className="mx-auto mt-10 max-w-2xl text-center text-xs font-light text-on-band/60">
            Security checks reduce risk; they cannot guarantee that a recipient is safe. EmployAI is a hackathon prototype that runs on NEAR testnet only.
          </p>
        </Reveal>
      </Container>
    </section>
  );
}
