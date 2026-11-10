import type { CSSProperties } from "react";
import { Container, SectionHeader } from "@/components/ui/Section";
import { cx } from "@/lib/cx";
import { AgentCard, BusinessCard, OperationCard, StepsPanel } from "./StoryCards";
import { AGENTS, SCENES } from "./story-data";
import { StoryFilm } from "./StoryFilm";

/**
 * "Watch your business come to life" — a four-scene product film between How It Works and the
 * Workforce section. With motion allowed, the scroll-driven film plays (the moving stage is hidden
 * from assistive tech) and the static storyboard below is read by screen readers instead.
 * With prefers-reduced-motion (or without JavaScript), the static storyboard is shown on the page.
 */
export function ProductStory() {
  return (
    <section id="see-it-work" aria-labelledby="film-title" className="relative isolate">
      <Container className="pt-20 sm:pt-28">
        <SectionHeader
          id="film-title"
          eyebrow="See it in motion"
          title="Watch your business come to life."
          intro="From understanding your business to coordinating everyday operations, watch your AI workforce turn complex tasks into connected workflows."
        />
      </Container>
      <StoryFilm />
      <StoryStatic />
    </section>
  );
}

/** Readable, motion-free storyboard of the same four scenes. */
function StoryStatic() {
  const visuals = [
    <div key="biz" data-phase="learning" style={{ "--learn": 1 } as CSSProperties}><BusinessCard /></div>,
    <div key="ops" className="grid gap-3 sm:grid-cols-2">{[0, 1, 2, 3].map(i => <OperationCard key={i} index={i} />)}</div>,
    <div key="agents" className="grid gap-3 sm:grid-cols-2">
      {AGENTS.map((_, i) => <AgentCard key={i} index={i} className={cx(i === 0 && "sm:col-span-2")} />)}
    </div>,
    <StepsPanel key="steps" staticDone />,
  ];
  return (
    <div className="film-static sr-only motion-reduce:not-sr-only">
      <Container className="pb-20 pt-12 sm:pb-28">
        <ol className="grid gap-8 lg:grid-cols-2">
          {SCENES.map((s, i) => (
            <li key={s.label} className="card flex flex-col gap-5 p-6">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-accent">0{i + 1} · {s.label}</p>
                <h3 className="mt-2 text-xl font-semibold leading-tight text-ink">{s.title}</h3>
                <p className="mt-2 text-[0.9375rem] font-light leading-relaxed text-muted">{s.body}</p>
              </div>
              {visuals[i]}
            </li>
          ))}
        </ol>
        <p className="mt-6 text-center text-sm font-light text-muted">
          Illustration with simulated data. No real orders, payments or integrations are shown.
        </p>
      </Container>
    </div>
  );
}
