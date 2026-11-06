import Link from "next/link";
import { cx } from "@/lib/cx";

/**
 * EmployAI wordmark with a provisional symbol. PRD §17.1: the symbol is a placeholder until a final
 * logo asset is approved; the wordmark ("EmployAI", exact casing) is the brand.
 * The symbol uses the accent colour (deep purple; readable lavender-purple in dark mode) at three
 * opacities — one hue only — and no SVG ids, so it can appear several times on a page.
 * `compact` is a slightly smaller mark and wordmark on phones (full size from the `sm` breakpoint),
 * for dense top bars; the logo itself is never hidden.
 */
export function Logo({ className, href = "/", compact = false }: { className?: string; href?: string; compact?: boolean }) {
  return (
    <Link href={href} className={cx("inline-flex flex-none items-center rounded-lg", compact ? "gap-2 sm:gap-2.5" : "gap-2.5", className)} aria-label="EmployAI home">
      <svg width="30" height="30" viewBox="0 0 32 32" aria-hidden="true" focusable="false" className={cx("text-accent", compact && "h-6 w-6 sm:h-[30px] sm:w-[30px]")}>
        <rect x="6" y="4" width="21" height="7" rx="3.5" transform="skewX(-14)" fill="currentColor" />
        <rect x="9" y="12.5" width="18" height="7" rx="3.5" transform="skewX(-14)" fill="currentColor" opacity="0.8" />
        <rect x="12" y="21" width="15" height="7" rx="3.5" transform="skewX(-14)" fill="currentColor" opacity="0.6" />
      </svg>
      <span className={cx("font-bold tracking-[-0.02em] text-ink", compact ? "text-[1.1875rem] sm:text-[1.375rem]" : "text-[1.375rem]")}>EmployAI</span>
    </Link>
  );
}
