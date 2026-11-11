import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { AutoRefresh } from "@/components/workspace/AutoRefresh";
import { WorkspaceShell, WorkspaceSkeleton } from "@/components/workspace/WorkspaceShell";
import { statusPill } from "@/components/workspace/platform-api";
import { getOwnedBusiness } from "@/lib/discovery/access";
import { buildActivityView } from "@/lib/platform/view";

export const metadata: Metadata = { title: "Activity — EmployAI", robots: { index: false } };

export default function Page({ params }: PageProps<"/w/[id]/activity">) {
  return (
    <Suspense fallback={<WorkspaceSkeleton tab="activity" />}>
      <Body params={params} />
    </Suspense>
  );
}

const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "medium", timeZone: "UTC" }) + " UTC";

async function Body({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const business = await getOwnedBusiness(id);
  if (!business) notFound();
  const a = await buildActivityView(business);
  return (
    <WorkspaceShell businessId={business.id} businessName={business.name} tab="activity" killSwitch={!!business.kill_switch}>
      <AutoRefresh seconds={15} />
      <div className="space-y-8">
        <section className="card px-5 py-5">
          <h1 className="text-xl font-semibold text-ink">Activity</h1>
          <p className="mt-1 text-sm font-light text-muted">Everything your AI workforce did, recorded as it happened. Outcomes are only marked delivered when the platform confirmed them.</p>
          <div className="mt-4 flex flex-wrap gap-2">
            <span className="pill">Background tasks queued: {a.tasks.queued}</span>
            <span className="pill">Running: {a.tasks.running}</span>
            <span className={a.tasks.dead ? "pill pill-warn" : "pill"}>Failed: {a.tasks.dead}</span>
            {a.tasks.nextDue && <span className="pill pill-accent">Next due: {when(a.tasks.nextDue)}</span>}
          </div>
        </section>

        {a.actions.length > 0 && (
          <section className="card px-5 py-5">
            <h2 className="text-base font-semibold text-ink">External actions</h2>
            <ul className="mt-3 divide-y divide-line">
              {a.actions.map(x => (
                <li key={x.id} className="row-between py-3 text-sm">
                  <div className="min-w-0">
                    <p className="font-semibold text-ink">{x.action} <span className="font-normal text-muted">by {x.agent}</span></p>
                    <p className="text-muted">{when(x.at)} · deliveries {x.deliveries}{x.notBefore ? ` · not before ${when(x.notBefore)}` : ""}{x.ref ? ` · ref ${x.ref}` : ""}</p>
                    {x.error && <p className="text-danger">{x.error}</p>}
                  </div>
                  <div className="flex items-center gap-2">
                    {x.link && <a className="font-semibold text-accent" href={x.link} target="_blank" rel="noreferrer">View</a>}
                    <span className={statusPill(x.status)}>{x.status}</span>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="card px-5 py-5">
          <h2 className="text-base font-semibold text-ink">Timeline</h2>
          {a.events.length === 0 ? <p className="mt-3 text-sm text-muted">Nothing yet.</p> : (
            <ul className="mt-3 divide-y divide-line">
              {a.events.map(e => (
                <li key={e.id} className="row-between py-3 text-sm">
                  <div className="min-w-0">
                    <p className="font-semibold text-ink">{e.label}</p>
                    <p className="text-muted">{when(e.at)} · {e.actor}{e.detail ? ` · ${e.detail}` : ""}</p>
                  </div>
                  {e.link ? <a className="font-semibold text-accent" href={e.link} target="_blank" rel="noreferrer">View post</a> : <span className="pill">{e.status}</span>}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </WorkspaceShell>
  );
}
