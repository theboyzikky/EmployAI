import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { Icon, ArrowRightIcon, ClockIcon } from "@/components/icons";
import { ConsultantShell } from "@/components/onboarding/ConsultantShell";
import { ContextPanel } from "@/components/onboarding/ContextPanel";
import { ConsultantMessage } from "@/components/onboarding/Messages";
import { StartComposer } from "@/components/onboarding/StartComposer";
import { latestUnfinished } from "@/lib/discovery/access";

export const metadata: Metadata = { title: "Business discovery — EmployAI" };

// Fresh onboarding: reached from "Get started" / "Build my AI team" without a hero message.
export default function StartPage() {
  return (
    <ConsultantShell panel={<ContextPanel />}>
      <h1 className="sr-only">Business discovery</h1>
      <div className="flex flex-1 flex-col gap-5 pb-6">
        <Suspense fallback={null}>
          <ResumeCard />
        </Suspense>
        <ConsultantMessage>
          <p>Hi, I&rsquo;m your EmployAI business consultant.</p>
          <p className="mt-2">
            Tell me what your business does, how customers buy from you, and what you&rsquo;d like to take off your plate.
            Plain language is perfect &mdash; I&rsquo;ll ask follow-up questions and design the right AI team with you.
          </p>
        </ConsultantMessage>
      </div>
      <div className="sticky bottom-0 -mx-4 border-t border-line bg-canvas/95 px-4 pb-4 pt-3 backdrop-blur sm:mx-0 sm:rounded-[var(--radius-card)] sm:border sm:bg-surface sm:px-4">
        <StartComposer />
      </div>
    </ConsultantShell>
  );
}

/** "Continue where you left off" for this browser's most recent unfinished discovery. */
async function ResumeCard() {
  const b = await latestUnfinished();
  if (!b) return null;
  const label = b.name ?? b.business_type ?? "your business";
  return (
    <div className="enter card flex flex-wrap items-center justify-between gap-3 border-accent-line px-5 py-4">
      <div className="flex items-start gap-3">
        <Icon icon={ClockIcon} size={20} swap={false} className="mt-0.5 text-accent" />
        <div>
          <p className="text-sm font-semibold text-ink">Continue where you left off</p>
          <p className="text-sm font-light text-muted">Your discovery for {label} is saved in this browser.</p>
        </div>
      </div>
      <Link href={`/start/${b.id}`} className="btn btn-primary btn-sm icon-host">
        Continue <Icon icon={ArrowRightIcon} size={16} />
      </Link>
    </div>
  );
}
