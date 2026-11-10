"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Logo } from "@/components/ui/Logo";
import { ButtonLink } from "@/components/ui/Button";
import { Icon, ArrowRightIcon, ListIcon, XIcon } from "@/components/icons";
import { cx } from "@/lib/cx";
import { ThemeToggle } from "@/components/theme/ThemeToggle";

export const NAV_LINKS = [
  { href: "#how-it-works", label: "How it works" },
  { href: "#agents", label: "Agents" },
  { href: "#security", label: "Security" },
  { href: "#faq", label: "FAQ" },
] as const;

export function Navbar() {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const close = useCallback((returnFocus = true) => {
    setOpen(false);
    if (returnFocus) toggleRef.current?.focus();
  }, []);

  // Mobile menu: Escape closes, body scroll is locked, focus moves into the panel.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panelRef.current?.querySelector<HTMLElement>("a,button")?.focus();
    return () => { document.removeEventListener("keydown", onKey); document.body.style.overflow = prev; };
  }, [open, close]);

  // Close the panel if the viewport grows to desktop width.
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 768px)");
    const onChange = () => { if (mq.matches) setOpen(false); };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  return (
    <header
      className={cx(
        "sticky top-0 z-50 transition-[background-color,box-shadow,border-color] duration-200",
        scrolled || open ? "border-b border-line/80 bg-canvas/85 backdrop-blur-md" : "border-b border-transparent bg-transparent",
      )}
    >
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-3 focus:z-[60] focus:rounded-full focus:bg-ink focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-on-ink">
        Skip to content
      </a>
      <nav aria-label="Main" className="mx-auto flex h-[72px] w-full max-w-[1200px] items-center justify-between px-6 lg:px-12">
        <Logo />

        <div className="hidden items-center gap-8 md:flex">
          <ul className="flex items-center gap-7">
            {NAV_LINKS.map(l => (
              <li key={l.href}>
                <a href={l.href} className="rounded-md text-[0.9375rem] font-medium text-ink/80 transition-colors duration-200 hover:text-accent">
                  {l.label}
                </a>
              </li>
            ))}
          </ul>
          <span aria-hidden="true" className="h-6 w-px bg-line" />
          <div className="flex items-center gap-3">
            <ThemeToggle />
            <ButtonLink href="/start" size="sm" iconRight={ArrowRightIcon}>Get started</ButtonLink>
          </div>
        </div>

        <div className="flex items-center gap-2 md:hidden">
          <ThemeToggle />
          <button
            ref={toggleRef}
            type="button"
            className="icon-btn icon-host"
            aria-expanded={open}
            aria-controls="mobile-menu"
            aria-label={open ? "Close menu" : "Open menu"}
            onClick={() => setOpen(o => !o)}
          >
            <Icon icon={open ? XIcon : ListIcon} size={22} />
          </button>
        </div>
      </nav>

      {/* Mobile drawer */}
      <div
        id="mobile-menu"
        ref={panelRef}
        hidden={!open}
        className="border-t border-line/80 bg-canvas px-4 pb-6 pt-2 md:hidden"
      >
        <ul className="flex flex-col">
          {NAV_LINKS.map(l => (
            <li key={l.href}>
              <a href={l.href} onClick={() => close(false)} className="flex h-12 items-center rounded-lg px-2 text-base font-medium text-ink transition-colors hover:bg-accent-soft hover:text-accent">
                {l.label}
              </a>
            </li>
          ))}
        </ul>
        <ButtonLink href="/start" iconRight={ArrowRightIcon} className="mt-3 w-full" onClick={() => close(false)}>Get started</ButtonLink>
        <p className="mt-3 text-center text-xs font-light text-muted">Prototype for NEAR HACKATHON 2026 · NEAR testnet only</p>
      </div>
    </header>
  );
}
