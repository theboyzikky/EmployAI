"use client";

import { useEffect, useRef, useState, type CSSProperties, type ElementType, type ReactNode } from "react";
import { cx } from "@/lib/cx";

type RevealProps = {
  children: ReactNode;
  as?: ElementType;
  /** Delay before this element animates in (ms). Use 60–100 ms steps for staggering. */
  delay?: number;
  className?: string;
  id?: string;
  /** Set "group" when the element only provides a visibility trigger for children (e.g. .flow-step). */
  mode?: "self" | "group";
};

/**
 * Fades an element up once when it first scrolls into view (IntersectionObserver).
 * Reduced motion is handled in CSS (opacity only, 150 ms); without JS, a <noscript> rule shows it.
 */
export function Reveal({ children, as: Tag = "div", delay = 0, className, id, mode = "self" }: RevealProps) {
  const ref = useRef<HTMLElement | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") { setVisible(true); return; }
    const io = new IntersectionObserver(
      entries => {
        if (entries.some(e => e.isIntersecting)) { setVisible(true); io.disconnect(); }
      },
      { rootMargin: "0px 0px -10% 0px", threshold: 0.12 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const style = { "--reveal-delay": `${delay}ms` } as CSSProperties;
  return (
    <Tag ref={ref} id={id} className={cx(mode === "self" && "reveal", className)} data-visible={visible ? "true" : "false"} style={style}>
      {children}
    </Tag>
  );
}
