import { ArrowRightIcon } from "@/components/icons";
import { ButtonLink } from "@/components/ui/Button";
import { Container } from "@/components/ui/Section";
import { Reveal } from "@/components/motion/Reveal";

export function FinalCta() {
  return (
    <section aria-labelledby="cta-title" className="py-20 sm:py-28">
      <Container>
        <Reveal>
          <div className="relative isolate overflow-hidden rounded-[var(--radius-panel)] border border-line bg-surface px-6 py-14 text-center shadow-[var(--shadow-card)] sm:px-12 sm:py-20">
            {/* Soft lavender wash with low-strength deep-purple glows (decorative). */}
            <div aria-hidden="true" className="absolute inset-0 -z-10 bg-[radial-gradient(70%_80%_at_50%_0%,var(--color-accent-soft),transparent_70%)]" />
            <div aria-hidden="true" className="absolute -right-24 -top-24 -z-10 h-72 w-72 rounded-full bg-[radial-gradient(closest-side,var(--eai-glow),transparent)]" />
            <div aria-hidden="true" className="absolute -bottom-24 -left-24 -z-10 h-72 w-72 rounded-full bg-[radial-gradient(closest-side,var(--eai-glow),transparent)]" />
            <h2 id="cta-title" className="mx-auto max-w-[20ch] text-[2rem] font-bold leading-[1.1] tracking-[-0.03em] text-ink sm:text-[2.75rem]">
              Ready to meet your <span className="text-accent-strong">AI workforce?</span>
            </h2>
            <p className="mx-auto mt-4 max-w-xl text-lg font-light text-muted">
              Start with a conversation about your business. It takes a few minutes, and nothing runs without your approval.
            </p>
            <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <ButtonLink href="/start" size="lg" iconRight={ArrowRightIcon}>Start business discovery</ButtonLink>
              <ButtonLink href="#describe" size="lg" variant="secondary">Describe it in the hero</ButtonLink>
            </div>
          </div>
        </Reveal>
      </Container>
    </section>
  );
}
