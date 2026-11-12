import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ContentWorkspace } from "@/components/workspace/ContentWorkspace";
import { WorkspaceShell, WorkspaceSkeleton } from "@/components/workspace/WorkspaceShell";
import { getOwnedBusiness } from "@/lib/discovery/access";
import "@/lib/integrations/providers";
import { buildPlatformView } from "@/lib/platform/view";

export const metadata: Metadata = { title: "Content — EmployAI", robots: { index: false } };

export default function Page({ params }: PageProps<"/w/[id]/content">) {
  return (
    <Suspense fallback={<WorkspaceSkeleton tab="content" />}>
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
    <WorkspaceShell businessId={business.id} businessName={view.businessName} tab="content" killSwitch={!!business.kill_switch}>
      <ContentWorkspace initial={view} />
    </WorkspaceShell>
  );
}
