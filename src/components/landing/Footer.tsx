import Link from "next/link";
import { Logo } from "@/components/ui/Logo";
import { Container } from "@/components/ui/Section";

const PRODUCT = [
  { href: "#how-it-works", label: "How it works" },
  { href: "#agents", label: "AI workforce" },
  { href: "#security", label: "Security" },
  { href: "#integrations", label: "Integrations" },
  { href: "#faq", label: "FAQs" },
];
// Placeholders until real pages exist (PRD §17.4) — rendered as text, not dead links.
const PLACEHOLDERS = ["Documentation", "Contact", "Privacy", "Terms"];

export function Footer() {
  return (
    <footer className="border-t border-line bg-surface">
      <Container className="py-12">
        <div className="grid gap-10 md:grid-cols-[1.4fr_1fr_1fr]">
          <div>
            <Logo />
            <p className="mt-4 max-w-sm text-sm font-light leading-relaxed text-muted">
              Describe your business. EmployAI designs, builds and safely runs a specialised AI workforce — with you in control.
            </p>
          </div>
          <nav aria-label="Footer">
            <p className="text-sm font-semibold text-ink">Product</p>
            <ul className="mt-3 space-y-2">
              {PRODUCT.map(l => (
                <li key={l.href}><a href={l.href} className="text-sm font-normal text-muted transition-colors hover:text-accent">{l.label}</a></li>
              ))}
              <li><Link href="/start" className="text-sm font-normal text-muted transition-colors hover:text-accent">Get started</Link></li>
            </ul>
          </nav>
          <div>
            <p className="text-sm font-semibold text-ink">Company</p>
            <ul className="mt-3 space-y-2">
              {PLACEHOLDERS.map(p => (
                <li key={p} className="text-sm font-normal text-muted">
                  {p} <span className="ml-1 rounded-full bg-surface-2 px-2 py-0.5 text-[0.6875rem] font-medium">Coming soon</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
        <div className="mt-10 flex flex-col gap-2 border-t border-line pt-6 text-xs font-light text-muted sm:flex-row sm:items-center sm:justify-between">
          <p>© 2026 EmployAI · Prototype built for NEAR HACKATHON 2026</p>
          <p>NEAR testnet only · Demo data is fictional and labelled</p>
        </div>
      </Container>
    </footer>
  );
}
