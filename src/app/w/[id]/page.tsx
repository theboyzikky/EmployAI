import { redirect } from "next/navigation";
import { Suspense } from "react";
import { WorkspaceSkeleton } from "@/components/workspace/WorkspaceShell";

// /w/[id] opens the Workflows tab. Ownership is checked by the tab page itself.
export default function WorkspaceIndex({ params }: PageProps<"/w/[id]">) {
  return (
    <Suspense fallback={<WorkspaceSkeleton tab="workflows" />}>
      <Go params={params} />
    </Suspense>
  );
}

async function Go({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/w/${encodeURIComponent(id)}/workflows`);
  return null;
}
