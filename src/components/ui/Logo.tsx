import Link from "next/link";
import { cx } from "@/lib/cx";

/**
 * EmployAI wordmark (owner's design direction, 2026-11-10): "Employ" in the ink colour with a custom E
 * whose middle bar is a slanted violet stroke, and "AI" in violet. Drawn as one geometric stroke system
 * (16-unit strokes, squared-rounded corners, tall x-height, flat terminals, even spacing) so it stays
 * crisp at any size and needs no extra font. The violet gradient is the logo's own brand colour (as in
 * the owner's reference); the rest of the UI keeps the design-system palette.
 * The gradient id is identical in every instance (same definition), so repeating the logo is safe.
 * `compact` is a slightly smaller wordmark on phones (full size from the `sm` breakpoint).
 */
export function Logo({ className, href = "/", compact = false }: { className?: string; href?: string; compact?: boolean }) {
  return (
    <Link href={href} className={cx("inline-flex flex-none items-center rounded-lg", className)} aria-label="EmployAI home">
      <svg
        viewBox="0 8 478 94" aria-hidden="true" focusable="false"
        className={cx("w-auto text-ink", compact ? "h-6 sm:h-[30px]" : "h-[30px]")}
        fill="none" strokeWidth="16" strokeLinecap="butt" strokeLinejoin="round"
      >
        <defs>
          <linearGradient id="employai-wordmark-violet" x1="0" y1="0" x2="478" y2="0" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#6b3fe8" />
            <stop offset="1" stopColor="#9a62ff" />
          </linearGradient>
        </defs>
        {/* E: open rounded form + a slanted violet middle bar */}
        <path d="M62 20H28Q8 20 8 40V52Q8 72 28 72H62" stroke="currentColor" />
        <path d="M16 38H66L57 54H16Z" fill="url(#employai-wordmark-violet)" stroke="none" />
        {/* m */}
        <path d="M79 80V50Q79 38 91 38H101Q113 38 113 50V80M113 50Q113 38 125 38H135Q147 38 147 50V80" stroke="currentColor" />
        {/* p */}
        <path d="M172 30V100M172 38H196Q208 38 208 50V60Q208 72 196 72H172" stroke="currentColor" />
        {/* l */}
        <path d="M233 12V80" stroke="currentColor" />
        {/* o */}
        <rect x="258" y="38" width="42" height="34" rx="12" stroke="currentColor" />
        {/* y */}
        <path d="M325 30V60Q325 72 337 72H361M361 30V82Q361 94 349 94H330" stroke="currentColor" />
        {/* A (open, no crossbar) and I, in violet */}
        <path d="M384 80L408 23Q413 12 418 23L442 80M468 12V80" stroke="url(#employai-wordmark-violet)" />
      </svg>
    </Link>
  );
}
