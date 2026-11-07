import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { TeamOverview } from "@/components/workspace/TeamOverview";
import { WorkspaceShell, WorkspaceSkeleton } from "@/components/workspace/WorkspaceShell";
import { getOwnedBusiness } from "@/lib/discovery/access";
import { buildWorkspaceView } from "@/lib/workflows/view";

export const metadata: Metadata = { title: "Team — EmployAI", robots: { index: false } };

export default function TeamPage({ params }: PageProps<"/w/[id]/team">) {
  return (
    <Suspense fallback={<WorkspaceSkeleton tab="team" />}>
      <Team params={params} />
    </Suspense>
  );
}

async function Team({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const business = await getOwnedBusiness(id);
  if (!business) notFound();
  const view = await buildWorkspaceView(business);
  return (
    <WorkspaceShell businessId={view.businessId} businessName={view.businessName} tab="team" killSwitch={!!business.kill_switch}>
      <TeamOverview view={view} />
    </WorkspaceShell>
  );
}
