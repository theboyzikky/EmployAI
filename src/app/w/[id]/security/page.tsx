import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { SecurityWorkspace } from "@/components/workspace/SecurityWorkspace";
import { WorkspaceShell, WorkspaceSkeleton } from "@/components/workspace/WorkspaceShell";
import { getOwnedBusiness } from "@/lib/discovery/access";
import { listBlocklist } from "@/lib/runs/blocklist-service";

export const metadata: Metadata = { title: "Security — EmployAI", robots: { index: false } };

export default function SecurityPage({ params }: PageProps<"/w/[id]/security">) {
  return (
    <Suspense fallback={<WorkspaceSkeleton tab="security" />}>
      <Security params={params} />
    </Suspense>
  );
}

async function Security({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const business = await getOwnedBusiness(id);
  if (!business) notFound();
  const entries = await listBlocklist(business.id);
  return (
    <WorkspaceShell businessId={business.id} businessName={business.name} tab="security" killSwitch={!!business.kill_switch}>
      <SecurityWorkspace businessId={business.id} initial={entries} />
    </WorkspaceShell>
  );
}
