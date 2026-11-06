import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { WorkflowWorkspace } from "@/components/workspace/WorkflowWorkspace";
import { WorkspaceShell, WorkspaceSkeleton } from "@/components/workspace/WorkspaceShell";
import { getOwnedBusiness } from "@/lib/discovery/access";
import { buildWorkspaceView } from "@/lib/workflows/view";

export const metadata: Metadata = { title: "Workflows — EmployAI", robots: { index: false } };

export default function WorkflowsPage({ params }: PageProps<"/w/[id]/workflows">) {
  return (
    <Suspense fallback={<WorkspaceSkeleton tab="workflows" />}>
      <Workflows params={params} />
    </Suspense>
  );
}

async function Workflows({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Owner only; anyone else gets a 404 (no existence leak).
  const business = await getOwnedBusiness(id);
  if (!business) notFound();
  const view = await buildWorkspaceView(business);
  return (
    <WorkspaceShell businessId={view.businessId} businessName={view.businessName} tab="workflows">
      <WorkflowWorkspace initialView={view} />
    </WorkspaceShell>
  );
}
