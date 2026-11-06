import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ConsultantShell } from "@/components/onboarding/ConsultantShell";
import { ContextPanel } from "@/components/onboarding/ContextPanel";
import { DiscoveryWorkspace } from "@/components/onboarding/DiscoveryWorkspace";
import { getOwnedBusiness } from "@/lib/discovery/access";
import { buildView } from "@/lib/discovery/view";

export const metadata: Metadata = { title: "Business discovery — EmployAI", robots: { index: false } };

// The discovery workspace. The hero description is already saved as the first message (never re-asked).
export default function SessionPage({ params }: PageProps<"/start/[sessionId]">) {
  return (
    <Suspense fallback={<WorkspaceSkeleton />}>
      <Workspace params={params} />
    </Suspense>
  );
}

async function Workspace({ params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params;
  // Only the browser that created the session can open it; anyone else gets a 404 (no existence leak).
  const business = await getOwnedBusiness(sessionId);
  if (!business) notFound();
  return <DiscoveryWorkspace initialView={await buildView(business)} />;
}

function WorkspaceSkeleton() {
  return (
    <ConsultantShell panel={<ContextPanel />}>
      <div className="flex flex-1 flex-col gap-5 pb-6" aria-busy="true" aria-label="Loading your conversation">
        <div className="h-20 w-2/3 animate-pulse rounded-2xl bg-surface motion-reduce:animate-none" />
        <div className="ml-auto h-24 w-1/2 animate-pulse rounded-2xl bg-ink/10 motion-reduce:animate-none" />
      </div>
    </ConsultantShell>
  );
}
