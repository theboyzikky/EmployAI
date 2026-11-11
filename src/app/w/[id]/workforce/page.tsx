import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { WorkforceWorkspace } from "@/components/workspace/WorkforceWorkspace";
import { WorkspaceShell, WorkspaceSkeleton } from "@/components/workspace/WorkspaceShell";
import { getOwnedBusiness } from "@/lib/discovery/access";
import "@/lib/integrations/providers";
import { buildPlatformView } from "@/lib/platform/view";

export const metadata: Metadata = { title: "Workforce — EmployAI", robots: { index: false } };

export default function Page({ params, searchParams }: PageProps<"/w/[id]/workforce">) {
  return (
    <Suspense fallback={<WorkspaceSkeleton tab="workforce" />}>
      <Body params={params} searchParams={searchParams} />
    </Suspense>
  );
}

async function Body({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { id } = await params;
  const q = await searchParams;
  // Back from a provider's consent page: say what happened, and the readiness panel picks up from here.
  const outcome = typeof q.oauth === "string" && /^[a-z]{2,20}$/.test(q.oauth) ? q.oauth : null;
  const provider = typeof q.provider === "string" && /^[a-z_]{1,32}$/.test(q.provider) ? q.provider : null;
  const business = await getOwnedBusiness(id);
  if (!business) notFound();
  const view = await buildPlatformView(business);
  return (
    <WorkspaceShell businessId={business.id} businessName={view.businessName} tab="workforce" killSwitch={!!business.kill_switch}>
      <WorkforceWorkspace initial={view} oauth={outcome && provider ? { outcome, provider } : null} />
    </WorkspaceShell>
  );
}
