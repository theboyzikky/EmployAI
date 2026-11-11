import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { IntegrationsWorkspace } from "@/components/workspace/IntegrationsWorkspace";
import { WorkspaceShell, WorkspaceSkeleton } from "@/components/workspace/WorkspaceShell";
import { getOwnedBusiness } from "@/lib/discovery/access";
import "@/lib/integrations/providers";
import { buildHubView } from "@/lib/integrations/hub";

export const metadata: Metadata = { title: "Integrations — EmployAI", robots: { index: false } };

export default function Page({ params, searchParams }: PageProps<"/w/[id]/integrations">) {
  return (
    <Suspense fallback={<WorkspaceSkeleton tab="integrations" />}>
      <Body params={params} searchParams={searchParams} />
    </Suspense>
  );
}

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : null);

async function Body({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { id } = await params;
  const q = await searchParams;
  const business = await getOwnedBusiness(id);
  if (!business) notFound();
  const view = await buildHubView(business);
  const focus = one(q.connect) ?? one(q.provider);
  const oauth = one(q.oauth) && one(q.provider) ? { outcome: one(q.oauth)!, provider: one(q.provider)! } : null;
  return (
    <WorkspaceShell businessId={business.id} businessName={business.name} tab="integrations" killSwitch={!!business.kill_switch}>
      <IntegrationsWorkspace initial={view} focus={focus && /^[a-z_]{2,32}$/.test(focus) ? focus : null} returnTo={one(q.return)} oauth={oauth} />
    </WorkspaceShell>
  );
}
