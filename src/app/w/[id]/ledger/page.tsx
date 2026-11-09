import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { LedgerWorkspace } from "@/components/workspace/LedgerWorkspace";
import { WorkspaceShell, WorkspaceSkeleton } from "@/components/workspace/WorkspaceShell";
import { getOwnedBusiness } from "@/lib/discovery/access";
import { buildLedgerView } from "@/lib/runs/ledger-view";

export const metadata: Metadata = { title: "Ledger — EmployAI", robots: { index: false } };

export default function LedgerPage({ params }: PageProps<"/w/[id]/ledger">) {
  return (
    <Suspense fallback={<WorkspaceSkeleton tab="ledger" />}>
      <Ledger params={params} />
    </Suspense>
  );
}

async function Ledger({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Owner only (404 otherwise). Read-only: nothing is executed, signed or sent from this page.
  const business = await getOwnedBusiness(id);
  if (!business) notFound();
  const view = await buildLedgerView(business.id);
  return (
    <WorkspaceShell businessId={business.id} businessName={business.name} tab="ledger" killSwitch={!!business.kill_switch}>
      <LedgerWorkspace view={view} />
    </WorkspaceShell>
  );
}
