import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { InboxWorkspace } from "@/components/workspace/InboxWorkspace";
import { WorkspaceShell, WorkspaceSkeleton } from "@/components/workspace/WorkspaceShell";
import { getOwnedBusiness } from "@/lib/discovery/access";
import "@/lib/integrations/providers";
import { buildInboxView } from "@/lib/messaging/view";

export const metadata: Metadata = { title: "Inbox — EmployAI", robots: { index: false } };

export default function Page({ params }: PageProps<"/w/[id]/inbox">) {
  return (
    <Suspense fallback={<WorkspaceSkeleton tab="inbox" />}>
      <Body params={params} />
    </Suspense>
  );
}

async function Body({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const business = await getOwnedBusiness(id);
  if (!business) notFound();
  const view = await buildInboxView(business);
  return (
    <WorkspaceShell businessId={business.id} businessName={business.name} tab="inbox" killSwitch={!!business.kill_switch}>
      <InboxWorkspace initial={view} />
    </WorkspaceShell>
  );
}
