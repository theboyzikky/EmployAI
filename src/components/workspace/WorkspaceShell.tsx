import Link from "next/link";
import type { ReactNode } from "react";
import { Icon, ArrowLeftIcon, FlowArrowIcon, PlayCircleIcon, ReceiptIcon, ShieldCheckIcon, UsersThreeIcon } from "@/components/icons";
import { Logo } from "@/components/ui/Logo";
import { ThemeToggle } from "@/components/theme/ThemeToggle";
import { cx } from "@/lib/cx";
import { BusinessName } from "./BusinessName";
import { KillSwitchControl } from "./KillSwitchControl";

export type WorkspaceTab = "team" | "workflows" | "runs" | "ledger" | "security";

/**
 * Minimal business workspace: Team, Workflows and (M4) test Runs, with the in-app kill switch in the
 * header. The full dashboard (overview, security, ledger) arrives in later milestones and is not shown.
 */
export function WorkspaceShell({ businessId, businessName, tab, killSwitch, children }: { businessId: string; businessName: string | null; tab: WorkspaceTab; killSwitch: boolean; children: ReactNode }) {
  const tabs: Array<{ key: WorkspaceTab; label: string; href: string; icon: typeof UsersThreeIcon }> = [
    { key: "team", label: "Team", href: `/w/${businessId}/team`, icon: UsersThreeIcon },
    { key: "workflows", label: "Workflows", href: `/w/${businessId}/workflows`, icon: FlowArrowIcon },
    { key: "runs", label: "Runs", href: `/w/${businessId}/runs`, icon: PlayCircleIcon },
    { key: "ledger", label: "Ledger", href: `/w/${businessId}/ledger`, icon: ReceiptIcon },
    { key: "security", label: "Security", href: `/w/${businessId}/security`, icon: ShieldCheckIcon },
  ];
  return (
    <div className="flex min-h-dvh flex-col bg-canvas">
      <header className="sticky top-0 z-40 border-b border-line bg-surface/90 backdrop-blur-md">
        <div className="mx-auto flex h-16 w-full max-w-[1320px] items-center justify-between gap-2 px-3 sm:gap-3 sm:px-6">
          <div className="flex min-w-0 items-center gap-1 sm:gap-3">
            <Link href={`/start/${businessId}`} aria-label="Back to business discovery" className="icon-host inline-flex h-10 w-10 flex-none items-center justify-center rounded-full text-ink transition-colors hover:bg-accent-soft hover:text-accent">
              <Icon icon={ArrowLeftIcon} size={20} />
            </Link>
            <Logo compact />
            <span className="hidden h-6 w-px bg-line sm:block" aria-hidden="true" />
            {/* The name appears as soon as discovery has identified it; until then a neutral placeholder
                that can't be mistaken for a name. */}
            <BusinessName businessId={businessId} initial={businessName} />
          </div>
          <div className="flex flex-none items-center gap-1 sm:gap-2">
            <KillSwitchControl businessId={businessId} initialActive={killSwitch} />
            <ThemeToggle />
          </div>
        </div>
        <nav aria-label="Workspace" className="mx-auto w-full max-w-[1320px] px-4 sm:px-6">
          <ul className="flex gap-1">
            {tabs.map(t => {
              const active = t.key === tab;
              return (
                <li key={t.key}>
                  <Link
                    href={t.href}
                    aria-current={active ? "page" : undefined}
                    className={cx(
                      "icon-host inline-flex items-center gap-2 border-b-2 px-3 pb-2.5 pt-1 text-sm font-medium transition-colors",
                      active ? "border-accent-solid text-ink" : "border-transparent text-muted hover:text-ink",
                    )}
                  >
                    <Icon icon={t.icon} size={18} /> {t.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      </header>
      <main id="main" className="mx-auto w-full max-w-[1320px] flex-1 px-4 py-6 sm:px-6 lg:py-8">{children}</main>
    </div>
  );
}

export function WorkspaceSkeleton({ tab }: { tab: WorkspaceTab }) {
  return (
    <div className="flex min-h-dvh flex-col bg-canvas" aria-busy="true" aria-label={`Loading ${tab}`}>
      <div className="h-[106px] border-b border-line bg-surface" />
      <div className="mx-auto w-full max-w-[1320px] space-y-4 px-4 py-8 sm:px-6">
        <div className="h-24 animate-pulse rounded-2xl bg-surface motion-reduce:animate-none" />
        <div className="h-64 animate-pulse rounded-2xl bg-surface motion-reduce:animate-none" />
      </div>
    </div>
  );
}
