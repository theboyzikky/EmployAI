"use client";

import { useEffect, useRef } from "react";
import { Icon, CheckIcon } from "@/components/icons";
import { cx } from "@/lib/cx";

export const STAGES = ["Introduce", "Discover", "Analyse", "Confirm summary", "Review team"] as const;

/**
 * Five-stage progress. On narrow screens the strip scrolls sideways; the active step (or the last
 * step once everything is done) is centred on first render, whenever the stage changes, and whenever
 * the strip's width changes (rotation, window resize), so it never sits off-screen.
 */
export function StageProgress({ current, complete }: { current: number; complete: boolean }) {
  const ref = useRef<HTMLOListElement>(null);
  useEffect(() => {
    const list = ref.current;
    const nav = list?.parentElement;
    if (!list || !nav) return;
    const centre = () => {
      const el = list.querySelector<HTMLElement>("[aria-current=step]")?.closest("li") ?? (list.lastElementChild as HTMLElement | null);
      if (!el || nav.scrollWidth <= nav.clientWidth) return;
      const target = el.offsetLeft + el.offsetWidth / 2 - nav.clientWidth / 2;
      nav.scrollTo({ left: Math.max(0, Math.min(target, nav.scrollWidth - nav.clientWidth)), behavior: "auto" });
    };
    centre();
    // Re-centre when the strip resizes (rotation, window) or its content does (web font swap).
    const ro = new ResizeObserver(centre);
    ro.observe(nav);
    ro.observe(list);
    let alive = true;
    document.fonts?.ready.then(() => { if (alive) centre(); });
    return () => { alive = false; ro.disconnect(); };
  }, [current, complete]);

  return (
    <nav aria-label="Discovery progress" className="relative mx-auto w-full max-w-[1320px] overflow-x-auto px-4 pb-3 [scrollbar-width:none] sm:px-6 [&::-webkit-scrollbar]:hidden">
      <ol ref={ref} className="flex min-w-max items-center gap-2">
        {STAGES.map((s, i) => {
          const state = complete || i < current ? "done" : i === current ? "current" : "upcoming";
          return (
            <li key={s} className="flex items-center gap-2">
              <span
                aria-current={state === "current" ? "step" : undefined}
                className={cx(
                  "inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-medium",
                  state === "current" && "bg-accent-soft text-accent",
                  state === "done" && "text-success",
                  state === "upcoming" && "text-muted",
                )}
              >
                <span className={cx("inline-flex h-5 w-5 items-center justify-center rounded-full text-[0.6875rem] font-semibold", state === "current" ? "bg-accent-solid text-on-accent" : state === "done" ? "bg-success/15" : "bg-canvas ring-1 ring-line")}>
                  {state === "done" ? <Icon icon={CheckIcon} size={12} swap={false} /> : i + 1}
                </span>
                {s}
                <span className="sr-only">{state === "current" ? "(current step)" : state === "done" ? "(done)" : "(not started)"}</span>
              </span>
              {i < STAGES.length - 1 && <span aria-hidden="true" className="h-px w-5 bg-line" />}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
