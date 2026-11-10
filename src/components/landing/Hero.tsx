import type { CSSProperties } from "react";
import type { Icon as PhosphorIcon } from "@phosphor-icons/react/dist/lib/types";
import {
  Icon, ArrowRightIcon, CalendarDotsIcon, ChartLineUpIcon, ChatCircleDotsIcon, LightningIcon,
  PlayCircleIcon, RobotIcon, ShieldCheckIcon, SparkleIcon, WalletIcon,
} from "@/components/icons";
import { ButtonLink } from "@/components/ui/Button";
import { cx } from "@/lib/cx";
import { HeroChat } from "./HeroChat";
import { isSharedStore } from "@/lib/kv";

type Floater = {
  icon: PhosphorIcon; label: string; pos: string; show: string; duration: number; delay: number; alt?: boolean;
  size: number; rotate: number; opacity: number; blur?: number; halo?: boolean;
};

// Decorative symbols (AI, automation, analytics, operations, security) drifting slowly in the hero margins.
// Borderless and container-free so they read as background design, not clickable UI. Static Regular — never Fill.
// Each one differs in size, rotation, transparency and depth blur; positions are deliberately uneven.
// md (768–1023): only the two top-corner symbols. lg+: all eight, kept in the outer margins.
const FLOATERS: Floater[] = [
  { icon: RobotIcon, label: "AI agents", pos: "left-[2%] top-[6%] xl:left-[6%] xl:top-[11%]", show: "md:flex", duration: 9, delay: 0, size: 44, rotate: -12, opacity: 0.5, halo: true },
  { icon: ChartLineUpIcon, label: "Analytics", pos: "left-[2.5%] top-[33%] xl:left-[14%] xl:top-[34%]", show: "lg:flex", duration: 10, delay: 1.1, alt: true, size: 30, rotate: 8, opacity: 0.38 },
  { icon: CalendarDotsIcon, label: "Scheduling", pos: "left-[1%] top-[54%] xl:left-[3%] xl:top-[52%]", show: "lg:flex", duration: 7.5, delay: 0.5, size: 54, rotate: 14, opacity: 0.18, blur: 1.5 },
  { icon: WalletIcon, label: "Payments", pos: "left-[3%] top-[82%] xl:left-[10%] xl:top-[80%]", show: "lg:flex", duration: 10, delay: 1.8, alt: true, size: 34, rotate: -6, opacity: 0.42 },
  { icon: LightningIcon, label: "Automation", pos: "right-[3%] top-[9%] xl:right-[9%] xl:top-[6%]", show: "md:flex", duration: 8.5, delay: 0.4, alt: true, size: 36, rotate: 18, opacity: 0.46 },
  { icon: ShieldCheckIcon, label: "Security", pos: "right-[1.5%] top-[28%] xl:right-[12%] xl:top-[27%]", show: "lg:flex", duration: 9, delay: 1.5, size: 50, rotate: -8, opacity: 0.55, halo: true },
  { icon: ChatCircleDotsIcon, label: "Customer messages", pos: "right-[2%] top-[60%] xl:right-[5%] xl:top-[58%]", show: "lg:flex", duration: 7.5, delay: 0.9, alt: true, size: 28, rotate: 10, opacity: 0.3 },
  { icon: SparkleIcon, label: "AI reasoning", pos: "right-[1%] top-[80%] xl:right-[7%] xl:top-[83%]", show: "lg:flex", duration: 6.5, delay: 2.2, size: 58, rotate: -16, opacity: 0.16, blur: 2 },
];

// Abstract accents woven into the background (no symbols).
const ACCENTS = [
  { cls: "deco-ring left-[9%] top-[22%] h-16 w-16", show: "lg:block" },
  { cls: "deco-dot right-[16%] top-[47%] h-2 w-2", show: "lg:block" },
  { cls: "deco-dot left-[7%] top-[69%] h-1.5 w-1.5", show: "lg:block" },
  { cls: "deco-ring right-[4%] top-[42%] h-9 w-9", show: "xl:block" },
];

export function Hero() {
  const hostedDemo = isSharedStore();   // the public, multi-visitor demo: show the privacy notice
  return (
    <section aria-labelledby="hero-title" className="relative isolate overflow-hidden">
      {/* Layered background: soft lavender wash, low-strength deep-purple glows, dot grid, rings. */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10">
        <div className="hero-bg absolute inset-0" />
        <div className="hero-grid absolute inset-0" />
        <div className="hero-ring absolute left-1/2 top-[42%] hidden h-[820px] w-[1220px] -translate-x-1/2 -translate-y-1/2 rounded-[50%] md:block" />
        <div className="hero-ring absolute left-1/2 top-[40%] hidden h-[580px] w-[920px] -translate-x-1/2 -translate-y-1/2 rounded-[50%] md:block" />
        <div className="absolute inset-x-0 bottom-0 h-40 bg-gradient-to-b from-transparent to-canvas" />
      </div>

      {/* Floating icons (decorative). */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 bottom-0 -z-10 mx-auto max-w-[1280px]">
        {FLOATERS.map(({ icon, pos, show, duration, delay, alt, size, rotate, opacity, blur, halo }, i) => (
          <span
            key={i}
            className={cx("float float-deco absolute isolate hidden items-center justify-center", alt && "float-alt", halo && "float-deco-halo", pos, show)}
            style={{
              "--float-duration": `${duration}s`, "--float-delay": `${delay}s`,
              "--r": `${rotate}deg`, "--o": opacity, "--b": `${blur ?? 0}px`,
            } as CSSProperties}
          >
            <Icon icon={icon} size={size} swap={false} />
          </span>
        ))}
        {ACCENTS.map(({ cls, show }, i) => (
          <span key={`a${i}`} className={cx("absolute hidden", cls, show)} />
        ))}
      </div>

      <div className="mx-auto flex w-full max-w-[1200px] flex-col items-center px-6 pb-16 pt-10 text-center sm:pt-14 lg:px-12 lg:pb-24">
        <span className="eyebrow enter" style={{ "--enter-delay": "0ms" } as CSSProperties}>
          <Icon icon={SparkleIcon} size={14} swap={false} />
          Your business, autonomous
        </span>

        <h1 id="hero-title" className="enter mt-6 max-w-[16ch] text-[2.5rem] font-bold leading-[1.05] tracking-[-0.035em] text-ink sm:text-[3.5rem] lg:text-[4.5rem]" style={{ "--enter-delay": "80ms" } as CSSProperties}>
          Build your Business&apos; <span className="text-accent-strong">AI Workforce.</span>
        </h1>

        <p className="enter mt-6 max-w-[38rem] text-lg font-light leading-relaxed text-muted sm:text-xl" style={{ "--enter-delay": "160ms" } as CSSProperties}>
          Describe your business and let AI design specialised agents and build checked workflows for your approval &mdash; while you stay in control of every rule, payment and permission.
        </p>

        <div className="enter mt-8 flex w-full flex-col items-stretch gap-3 sm:w-auto sm:flex-row sm:items-center" style={{ "--enter-delay": "240ms" } as CSSProperties}>
          <ButtonLink href="/start" size="lg" iconRight={ArrowRightIcon}>Build my AI team</ButtonLink>
          <ButtonLink href="#how-it-works" size="lg" variant="secondary" iconRight={PlayCircleIcon}>See how it works</ButtonLink>
        </div>

        <div className="relative mt-12 w-full max-w-[52rem]">
          <div aria-hidden="true" className="chat-glow pointer-events-none absolute -inset-x-10 -inset-y-8 -z-10" />
          <HeroChat />
          {hostedDemo && (
            <p className="mt-3 text-xs text-muted" role="note">
              Public demo: what you type is stored in this demo&apos;s database for up to 60 days after your last activity, and it&apos;s sent to NEAR AI to write the consultant&apos;s replies. Please don&apos;t enter personal or confidential information. Payments use NEAR testnet tokens only.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
