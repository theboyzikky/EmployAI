import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { RunsWorkspace } from "@/components/workspace/RunsWorkspace";
import { WorkspaceShell, WorkspaceSkeleton } from "@/components/workspace/WorkspaceShell";
import { getOwnedBusiness } from "@/lib/discovery/access";
import { buildRunView, buildRunsView } from "@/lib/runs/view";

export const metadata: Metadata = { title: "Test runs — EmployAI", robots: { index: false } };

export default function RunsPage({ params }: PageProps<"/w/[id]/runs">) {
  return (
    <Suspense fallback={<WorkspaceSkeleton tab="runs" />}>
      <Runs params={params} />
    </Suspense>
  );
}

async function Runs({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Owner only; anyone else gets a 404 (no existence leak). Rendering only READS runs: nothing executes here.
  const business = await getOwnedBusiness(id);
  if (!business) notFound();
  const view = await buildRunsView(business);
  const focus = view.activeRunId ?? view.runs[0]?.id ?? null;
  const run = focus ? await buildRunView(business, focus) : null;
  return (
    <WorkspaceShell businessId={view.businessId} businessName={view.businessName} tab="runs" killSwitch={view.killSwitch}>
      <RunsWorkspace initialView={view} initialRun={run} />
    </WorkspaceShell>
  );
}
