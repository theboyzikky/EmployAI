import Link from "next/link";
import type { ReactNode } from "react";
import { Logo } from "@/components/ui/Logo";
import { Icon, ArrowLeftIcon, CheckCircleIcon, LockKeyIcon } from "@/components/icons";
import { cx } from "@/lib/cx";
import { StageProgress } from "./StageProgress";
import { ThemeToggle } from "@/components/theme/ThemeToggle";

export { STAGES } from "./StageProgress";

/** Business-consultant workspace: top bar with stage progress, conversation column, context panel. */
export function ConsultantShell({ children, panel, stage = 0, complete = false, saved = false, badge }: {
  children: ReactNode; panel: ReactNode; stage?: number; complete?: boolean; saved?: boolean; badge?: ReactNode;
}) {
  return (
    <div className="flex min-h-dvh flex-col bg-canvas">
      <header className="sticky top-0 z-40 border-b border-line bg-surface/90 backdrop-blur-md">
        {/* Phones: back · logo … AI-mode badge · theme. The page name joins from the `sm` breakpoint
            (it is also announced by the page's heading), so the logo is always visible. */}
        <div className="mx-auto flex h-16 w-full max-w-[1320px] items-center justify-between gap-2 px-3 sm:gap-3 sm:px-6">
          <div className="flex min-w-0 items-center gap-1 sm:gap-3">
            <Link href="/" aria-label="Back to the EmployAI home page" className="icon-host inline-flex h-10 w-10 flex-none items-center justify-center rounded-full text-ink transition-colors hover:bg-accent-soft hover:text-accent">
              <Icon icon={ArrowLeftIcon} size={20} />
            </Link>
            <Logo compact />
            <span className="hidden h-6 w-px bg-line sm:block" aria-hidden="true" />
            <p className="hidden truncate text-sm font-semibold text-ink sm:block">Business discovery</p>
          </div>
          <div className="flex flex-none items-center gap-1.5 sm:gap-3">
            {badge}
            <p className={cx("hidden items-center gap-1.5 whitespace-nowrap text-xs font-medium sm:inline-flex", saved ? "text-success" : "text-muted")} aria-live="polite">
              <Icon icon={saved ? CheckCircleIcon : LockKeyIcon} size={16} swap={false} />
              {saved ? "Saved" : "Private session"}
            </p>
            <ThemeToggle />
          </div>
        </div>
        <StageProgress current={stage} complete={complete} />
      </header>

      <div className="mx-auto grid w-full max-w-[1320px] flex-1 grid-rows-[auto_1fr] gap-6 px-4 py-6 sm:px-6 lg:grid-cols-[minmax(0,1fr)_360px] lg:grid-rows-1 lg:py-8">
        <main id="main" className="flex min-w-0 flex-col">{children}</main>
        <aside aria-label="What I understand" className="order-first lg:order-none">{panel}</aside>
      </div>
    </div>
  );
}
