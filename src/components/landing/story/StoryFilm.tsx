"use client";

import { useEffect, useRef, type CSSProperties } from "react";
import { Icon, ArrowDownIcon } from "@/components/icons";
import { cx } from "@/lib/cx";
import { AgentCard, BusinessCard, OperationCard, StepsPanel } from "./StoryCards";
import { AGENTS, FINALE, SCENES, STEPS } from "./story-data";
import {
  CAPTION_WINDOWS, ELEMENT_KEYS, FINALE_AT, LEAD_IN, LINES, NARROW, PROGRESS_WINDOWS, STEP_GAP, STEP_START, WIDE,
  range, sample, type ElKey, type Layout, type Values,
} from "./timeline";

const PERSPECTIVE = 1300;
const CAPTIONS = [...SCENES, FINALE];
/** Background layers move at different speeds from the cards (parallax depth). [x, y] travel in px over the film. */
const PARALLAX: Array<[number, number]> = [[50, -170], [-40, 130], [0, -70], [0, -460]];

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Slow, continuous "camera" drift added to every card so the whole scene breathes together. */
function drift(p: number) {
  return { rx: Math.cos(p * Math.PI * 1.1) * 1.5, ry: Math.sin(p * Math.PI * 1.4) * 3 };
}

function elementStyle(layout: Layout, key: ElKey, p: number): { transform: string; opacity: string; filter: string; visibility: "hidden" | "visible" } {
  const v = sample(layout.tracks[key], p);
  const d = key === "ring" ? { rx: 0, ry: 0 } : drift(p);
  return {
    transform:
      `translate(-50%, -50%) translate3d(${r2(v.x)}px, ${r2(v.y)}px, ${r2(v.z)}px) ` +
      `rotateX(${r2(v.rx + d.rx)}deg) rotateY(${r2(v.ry + d.ry)}deg) rotateZ(${r2(v.rz)}deg) scale(${r2(v.s)})`,
    opacity: String(r2(v.o)),
    filter: v.b > 0.05 ? `blur(${r2(v.b)}px)` : "none",
    visibility: v.o < 0.01 ? "hidden" : "visible",
  };
}

function captionOpacity(i: number, p: number) {
  const [a, b] = CAPTION_WINDOWS[i];
  const f = 0.014;
  return Math.min(range(p, a - f, a + f), 1 - range(p, b - f, b + f));
}

/**
 * "Watch your business come to life": a scroll-driven product film.
 * Native scrolling only — the stage is sticky (no wheel/touch interception, no scroll snapping),
 * so the visitor can scroll through or past it at any speed, or use "Skip the film".
 * Each frame is computed from scroll position in one rAF and written straight to the DOM
 * (transform / opacity only), so React never re-renders while scrolling.
 */
export function StoryFilm() {
  const trackRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const cameraRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const els = useRef<Partial<Record<ElKey, HTMLDivElement | null>>>({});
  const lines = useRef<Array<SVGLineElement | null>>([]);
  const captions = useRef<Array<HTMLDivElement | null>>([]);
  const progress = useRef<Array<HTMLSpanElement | null>>([]);
  const layers = useRef<Array<HTMLDivElement | null>>([]);

  useEffect(() => {
    const track = trackRef.current, stage = stageRef.current, world = worldRef.current, camera = cameraRef.current, svg = svgRef.current;
    if (!track || !stage || !world || !camera || !svg) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    const steps = [...camera.querySelectorAll<HTMLElement>(".film-step")];
    const learnPct = camera.querySelector<HTMLElement>(".film-learn-pct");
    let layout: Layout = WIDE;
    let raf = 0;
    let inView = false;
    const written = new WeakMap<object, Record<string, string>>();

    // Write only what changed, to keep style recalculation minimal.
    const write = (el: Element & { style: CSSStyleDeclaration }, props: Record<string, string>) => {
      const prev = written.get(el) ?? {};
      for (const k in props) {
        if (prev[k] !== props[k]) { el.style.setProperty(k, props[k]); prev[k] = props[k]; }
      }
      written.set(el, prev);
    };
    const attr = (el: Element, name: string, value: string) => { if (el.getAttribute(name) !== value) el.setAttribute(name, value); };

    const measure = () => {
      const r = world.getBoundingClientRect();
      layout = r.width < 620 ? NARROW : WIDE;
      const s = Math.max(0.4, Math.min(r.width / layout.w, r.height / layout.h, 1.35));
      attr(camera, "data-layout", layout.name);
      write(camera, { width: `${layout.w}px`, height: `${layout.h}px`, transform: `translate(-50%, -50%) scale(${r2(s)})` });
      attr(svg, "viewBox", `${-layout.w / 2} ${-layout.h / 2} ${layout.w} ${layout.h}`);
    };

    const render = () => {
      raf = 0;
      const rect = track.getBoundingClientRect();
      const pinned = Math.max(1, rect.height - stage.offsetHeight);
      const p = Math.max(LEAD_IN - 0.06, Math.min(1, -rect.top / pinned));

      // Cards
      const vals = {} as Record<ElKey, Values>;
      for (const key of ELEMENT_KEYS) {
        const el = els.current[key];
        vals[key] = sample(layout.tracks[key], p);
        if (!el) continue;
        const st = elementStyle(layout, key, p);
        write(el, { transform: st.transform, opacity: st.opacity, filter: st.filter, visibility: st.visibility });
      }

      // Connection lines follow the projected centres of the cards they join.
      LINES.forEach((ln, i) => {
        const el = lines.current[i];
        if (!el) return;
        const a = vals[ln.from], b = vals[ln.to];
        const pa = PERSPECTIVE / (PERSPECTIVE - a.z), pb = PERSPECTIVE / (PERSPECTIVE - b.z);
        const draw = range(p, ln.draw[0], ln.draw[1]);
        const fade = ln.fade ? 1 - range(p, ln.fade[0], ln.fade[1]) : 1;
        const o = draw > 0 ? fade * Math.min(a.o, b.o, 1) : 0;
        attr(el, "x1", String(r2(a.x * pa))); attr(el, "y1", String(r2(a.y * pa)));
        attr(el, "x2", String(r2(b.x * pb))); attr(el, "y2", String(r2(b.y * pb)));
        write(el as unknown as HTMLElement, { "stroke-dashoffset": String(r2(1 - draw)), opacity: String(r2(o)) });
      });

      // Captions cross-fade: the outgoing line drifts up as the next rises in.
      captions.current.forEach((el, i) => {
        if (!el) return;
        const o = captionOpacity(i, p);
        const leaving = p > CAPTION_WINDOWS[i][1] - 0.014;
        write(el, { opacity: String(r2(o)), transform: `translate3d(0, ${r2((1 - o) * (leaving ? -14 : 14))}px, 0)`, visibility: o < 0.01 ? "hidden" : "visible" });
      });
      progress.current.forEach((el, i) => {
        if (!el) return;
        const [a, b] = PROGRESS_WINDOWS[i];
        write(el, { transform: `scaleX(${r2(range(p, a, b))})` });
      });

      // Background parallax: slower and faster planes than the cards.
      layers.current.forEach((el, i) => {
        if (!el) return;
        const [x, y] = PARALLAX[i];
        const t = Math.max(-0.3, p);
        write(el, { transform: `translate3d(${r2(x * t)}px, ${r2(y * t)}px, 0)` });
      });

      // Scene 1: learning progress. Finale: coordinated.
      const learn = range(p, 0, 0.15);
      write(camera, { "--learn": String(r2(learn)) });
      if (learnPct) learnPct.textContent = `${Math.round(learn * 100)}%`;
      attr(camera, "data-phase", p >= FINALE_AT ? "done" : "learning");

      // Scene 4: steps light up in sequence; the agent doing the work is highlighted.
      let activeAgent: number | null = null;
      steps.forEach((el, i) => {
        const t = STEP_START + i * STEP_GAP;
        const state = p < t ? "pending" : p < t + STEP_GAP ? "active" : "done";
        attr(el, "data-state", state);
        if (state === "active" && i < STEPS.length) activeAgent = STEPS[i].agent;
      });
      const coordinating = p >= STEP_START && p < FINALE_AT;
      AGENTS.forEach((_, i) => {
        const el = els.current[`ag${i}` as ElKey];
        if (el) attr(el, "data-active", String(i === activeAgent || (i === 0 && coordinating)));
      });
    };

    const schedule = () => { if (!raf && inView && !reduce.matches) raf = requestAnimationFrame(render); };
    const onResize = () => { measure(); schedule(); };

    const io = new IntersectionObserver(entries => {
      inView = entries.some(e => e.isIntersecting);
      if (inView) { measure(); schedule(); }
    }, { rootMargin: "25% 0px 25% 0px" });
    io.observe(track);
    const ro = new ResizeObserver(onResize);
    ro.observe(world);
    window.addEventListener("scroll", schedule, { passive: true });
    reduce.addEventListener("change", onResize);

    return () => {
      io.disconnect(); ro.disconnect();
      window.removeEventListener("scroll", schedule);
      reduce.removeEventListener("change", onResize);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  // Server render = the first frame of the film (wide layout, before the lead-in), so nothing jumps on hydration.
  const initial = (key: ElKey) => elementStyle(WIDE, key, LEAD_IN - 0.06) as CSSProperties;
  const el = (key: ElKey) => (node: HTMLDivElement | null) => { els.current[key] = node; };

  return (
    <div ref={trackRef} className="film-track relative h-[300vh] md:h-[330vh] motion-reduce:hidden">
      <div ref={stageRef} className="sticky top-0 h-[100svh] overflow-hidden">
        {/* Ambient light and depth planes */}
        <div aria-hidden="true" className="pointer-events-none absolute inset-0">
          <div ref={n => { layers.current[0] = n; }} className="film-glow film-glow-a absolute" />
          <div ref={n => { layers.current[1] = n; }} className="film-glow film-glow-b absolute" />
          <div ref={n => { layers.current[2] = n; }} className="film-grid absolute inset-x-0 -bottom-24 top-0" />
          <div ref={n => { layers.current[3] = n; }} className="film-foreground absolute" />
        </div>

        <div aria-hidden="true" className="film-layout relative mx-auto flex h-full max-w-[1200px] flex-col px-6 pb-14 pt-[88px] lg:px-12 xl:flex-row xl:items-center xl:gap-12 xl:pb-12 xl:pt-[96px]">
          {/* Narration */}
          <div className="film-narration relative z-10 shrink-0 xl:w-[20rem]">
            <div className="flex gap-1.5">
              {PROGRESS_WINDOWS.map((_, i) => (
                <span key={i} className="h-[3px] flex-1 overflow-hidden rounded-full bg-line">
                  <span ref={n => { progress.current[i] = n; }} className="block h-full origin-left rounded-full bg-ink" style={{ transform: "scaleX(0)" }} />
                </span>
              ))}
            </div>
            <div className="mt-4 grid xl:mt-6">
              {CAPTIONS.map((c, i) => {
                const n = Math.min(i, 3) + 1;
                return (
                  <div
                    key={i}
                    ref={node => { captions.current[i] = node; }}
                    className="[grid-area:1/1]"
                    style={{ opacity: i === 0 ? 1 : 0, visibility: i === 0 ? "visible" : "hidden" }}
                  >
                    <p className="text-xs font-semibold uppercase tracking-[0.14em] text-accent">0{n} · {c.label}</p>
                    <p className="mt-2 text-xl font-semibold leading-tight tracking-[-0.015em] text-ink sm:text-2xl xl:text-[1.875rem]">{c.title}</p>
                    <p className="mt-2 max-w-[34rem] text-sm font-light leading-relaxed text-muted sm:text-[0.9375rem] xl:mt-3 xl:text-base [@media(max-height:620px)]:hidden">{c.body}</p>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Stage */}
          <div ref={worldRef} className="film-world relative mt-2 min-h-0 flex-1 self-stretch xl:mt-0">
            <div ref={cameraRef} className="film-camera absolute left-1/2 top-1/2" data-layout="wide" data-phase="learning" style={{ width: WIDE.w, height: WIDE.h, transform: "translate(-50%, -50%)" }}>
              <div ref={el("ring")} className="film-el film-el-ring film-ring" style={initial("ring")} />
              <svg ref={svgRef} className="film-lines absolute inset-0 h-full w-full overflow-visible" style={{ transform: "translateZ(-800px) scale(1.6154)" }} viewBox={`${-WIDE.w / 2} ${-WIDE.h / 2} ${WIDE.w} ${WIDE.h}`}>
                {LINES.map((_, i) => (
                  <line key={i} ref={n => { lines.current[i] = n; }} pathLength={1} strokeDasharray="1" strokeDashoffset="1" opacity="0" />
                ))}
              </svg>
              <div ref={el("panel")} className="film-el film-el-panel" style={initial("panel")}><StepsPanel /></div>
              <div ref={el("biz")} className="film-el film-el-biz" style={initial("biz")}><BusinessCard /></div>
              {[0, 1, 2, 3].map(i => (
                <div key={i} ref={el(`op${i}` as ElKey)} className="film-el film-el-op" style={initial(`op${i}` as ElKey)}><OperationCard index={i} /></div>
              ))}
              {AGENTS.map((_, i) => (
                <div key={i} ref={el(`ag${i}` as ElKey)} className={cx("film-el film-el-ag", i === 0 && "film-el-ag0")} data-active="false" style={initial(`ag${i}` as ElKey)}>
                  <AgentCard index={i} />
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Honest labelling + a way out that never depends on scrolling through. */}
        <div className="absolute inset-x-0 bottom-0 z-20">
          <div className="mx-auto flex max-w-[1200px] items-center justify-between gap-3 px-6 pb-4 lg:px-12">
            <p className="text-[0.75rem] font-medium text-muted">
              <span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-accent align-middle" aria-hidden="true" />
              Illustration with simulated data. No real orders, payments or integrations.
            </p>
            <a href="#agents" className="icon-host inline-flex flex-none items-center gap-1.5 rounded-full px-2 py-1 text-[0.8125rem] font-medium text-ink underline-offset-4 hover:text-accent hover:underline">
              Skip the film
              <Icon icon={ArrowDownIcon} size={14} />
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
