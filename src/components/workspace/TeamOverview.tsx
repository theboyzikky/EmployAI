import Link from "next/link";
import { Icon, ArrowRightIcon, CheckCircleIcon, InfoIcon } from "@/components/icons";
import type { WorkspaceView } from "@/lib/workflows/view-types";
import { cx } from "@/lib/cx";
import { DiscoveryNotice } from "./DiscoveryNotice";

/** Read-only view of the approved team. Changes to the team happen in discovery, before approval. */
export function TeamOverview({ view }: { view: WorkspaceView }) {
  const kept = view.agents.filter(a => a.status !== "removed");
  return (
    <div className="space-y-5">
      <div className="card px-5 py-4">
        <h1 className="text-xl font-semibold text-ink">Your AI team</h1>
        <p className="mt-1 text-sm font-light text-muted">
          {view.teamApproved
            ? `Approved on ${new Date(view.teamApprovedAt!).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}. Agents act only in test runs, on fictional demo data, from the Runs tab.`
            : "Your team hasn't been approved yet."}
        </p>
        {!view.runnable && (
          <p className="mt-3 flex items-start gap-2 rounded-xl bg-surface-2 px-3 py-2.5 text-sm text-ink">
            <Icon icon={InfoIcon} size={16} swap={false} className="mt-0.5 flex-none text-accent" />
            Preview: workflows are only supported for the restaurant demo in this prototype, so this team can't run yet.
          </p>
        )}
        {view.teamApproved && view.discoveryBeforeM35 && <DiscoveryNotice />}
        {!view.teamApproved && (
          <Link href={`/start/${view.businessId}`} className="btn btn-primary btn-sm icon-host mt-3">Back to discovery <Icon icon={ArrowRightIcon} size={16} /></Link>
        )}
      </div>
      <ul className="grid gap-4 md:grid-cols-2">
        {kept.map(a => (
          <li key={a.key} className="card p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-ink">{a.name}</h2>
                <p className="text-sm font-medium text-muted">{a.role}</p>
              </div>
              <span className={cx("whitespace-nowrap rounded-full px-2 py-0.5 text-[0.6875rem] font-semibold",
                a.runnable && a.status === "approved" ? "text-success ring-1 ring-success/40" : "bg-surface-2 text-muted ring-1 ring-line")}>
                {a.status === "paused" ? "Paused" : a.status === "approved" ? (a.runnable ? "Approved" : "Approved · Preview") : "Proposed"}
              </span>
            </div>
            <p className="mt-2 text-sm text-ink">{a.purpose}</p>
            <ul className="mt-3 space-y-1">
              {a.tasks.map(t => (
                <li key={t.id} className={cx("flex items-start gap-2 text-sm", t.enabled ? "text-ink" : "text-muted line-through")}>
                  <Icon icon={CheckCircleIcon} size={16} swap={false} className={cx("mt-0.5 flex-none", t.enabled ? "text-success" : "text-subtle")} />
                  {t.label}{!t.enabled && <span className="sr-only"> (switched off)</span>}
                </li>
              ))}
            </ul>
            <p className="mt-3 text-sm text-muted"><span className="font-medium text-ink">Money:</span> {a.financialPermissions}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
