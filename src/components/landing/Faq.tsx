import { Icon, CaretDownIcon } from "@/components/icons";
import { Container, SectionHeader } from "@/components/ui/Section";
import { Reveal } from "@/components/motion/Reveal";

const FAQS = [
  { q: "How does EmployAI work?", a: "You describe your business in plain language. EmployAI asks a few focused follow-up questions, summarises what it understood for you to confirm, recommends a team of specialised AI agents, and builds their workflows. Nothing runs until you approve it." },
  { q: "Do I need technical knowledge?", a: "No. You talk about your business — orders, stock, suppliers, customers — and EmployAI translates that into agents and workflows. Technical details are available if you want them, but you never have to design a workflow yourself." },
  { q: "What can each agent do?", a: "Every agent has a written job, a short list of tools it may use, limits, and things it must never do. You can edit or remove any agent before approving the team, and pause it at any time." },
  { q: "How are payments handled?", a: "Payments go through a treasury contract on NEAR testnet that enforces your rules: approved recipients, per-payment and daily limits, and a pause switch. The paying agent's key can only ask the treasury to pay; it cannot move funds directly. This prototype uses testnet funds only." },
  { q: "How is my business protected from mistakes or manipulation?", a: "Before anything is signed, a security check looks at the recipient and your policy and returns allow, warn or block with reasons. Warnings wait for your approval, blocks are refused, and a kill switch stops everything instantly. Text from suppliers or customers is treated as data, never as instructions." },
  { q: "Which tools does it work with today?", a: "This prototype runs on NEAR AI Cloud for its intelligence and NEAR testnet for accounts, payments and the ledger. Connectors for messaging, storefronts, payments and accounting are planned and are not available yet." },
  { q: "Is this a live product?", a: "Not yet. EmployAI is a prototype built for NEAR HACKATHON 2026. The demonstration business is a fictional restaurant, and all demo data and transactions are clearly labelled." },
] as const;

export function Faq() {
  return (
    <section id="faq" aria-labelledby="faq-title" className="bg-surface py-20 sm:py-28">
      <Container className="max-w-[860px]">
        <SectionHeader id="faq-title" eyebrow="FAQs" title="Questions business owners ask" />
        <div className="mt-12 space-y-3">
          {FAQS.map((f, i) => (
            <Reveal key={f.q} delay={i * 50}>
              <details className="faq group card overflow-hidden px-5 sm:px-6">
                <summary className="icon-host flex cursor-pointer items-center justify-between gap-4 py-5 text-left text-[1.0625rem] font-semibold text-ink transition-colors duration-200 hover:text-accent">
                  {f.q}
                  <span className="faq-caret inline-flex">
                    <Icon icon={CaretDownIcon} size={20} />
                  </span>
                </summary>
                <p className="faq-body pb-5 text-[0.9375rem] font-light leading-relaxed text-muted">{f.a}</p>
              </details>
            </Reveal>
          ))}
        </div>
      </Container>
    </section>
  );
}
