import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { WorkforceWorkspace } from "@/components/workspace/WorkforceWorkspace";
import { WorkspaceShell, WorkspaceSkeleton } from "@/components/workspace/WorkspaceShell";
import { getOwnedBusiness } from "@/lib/discovery/access";
import "@/lib/integrations/providers";
import { buildPlatformView } from "@/lib/platform/view";

export const metadata: Metadata = { title: "Workforce — EmployAI", robots: { index: false } };

export default function Page({ params }: PageProps<"/w/[id]/workforce">) {
  return (
    <Suspense fallback={<WorkspaceSkeleton tab="workforce" />}>
      <Body params={params} />
    </Suspense>
  );
}

async function Body({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const business = await getOwnedBusiness(id);
  if (!business) notFound();
  const view = await buildPlatformView(business);
  return (
    <WorkspaceShell businessId={business.id} businessName={view.businessName} tab="workforce" killSwitch={!!business.kill_switch}>
      <WorkforceWorkspace initial={view} />
    </WorkspaceShell>
  );
}
