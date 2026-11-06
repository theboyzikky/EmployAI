"use client";

import { useState } from "react";
import { Icon, CheckCircleIcon, CircleNotchIcon, FloppyDiskIcon, PencilSimpleIcon, WarningIcon } from "@/components/icons";
import type { ProfileFieldKey } from "@/lib/discovery/profile";
import type { DiscoveryView } from "@/lib/discovery/view-types";
import { cx } from "@/lib/cx";
import { StatusPill } from "./ContextPanel";

const SECTIONS: Array<{ title: string; fields: ProfileFieldKey[]; insights?: "bottlenecks" | "opportunities" }> = [
  { title: "Business overview", fields: ["business_name", "industry", "team_structure"] },
  { title: "Products & services", fields: ["products_services"] },
  { title: "Operational structure", fields: ["customers_channels", "daily_operations", "current_tools", "suppliers"] },
  { title: "Challenges", fields: ["challenges"], insights: "bottlenecks" },
  { title: "Automation opportunities", fields: [], insights: "opportunities" },
  { title: "Business goals", fields: ["goals"] },
];

type Props = {
  view: DiscoveryView;
  busy: string | null;
  onSave: (fields: Partial<Record<ProfileFieldKey, string | null>>) => Promise<boolean>;
  onConfirm: (fields: Partial<Record<ProfileFieldKey, string | null>>) => Promise<boolean>;
};

/** Stage 4: the owner reviews and corrects the summary, then confirms it. */
export function SummaryReview({ view, busy, onSave, onConfirm }: Props) {
  const editableStage = view.stage === "summary" || view.stage === "proposal";
  const confirmed = view.stage === "proposal" || view.stage === "approved";
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Partial<Record<ProfileFieldKey, string>>>({});
  const field = (k: ProfileFieldKey) => view.fields.find(f => f.key === k)!;
  const changes = () => Object.fromEntries(Object.entries(draft).filter(([k, v]) => (field(k as ProfileFieldKey).value ?? "") !== v.trim()).map(([k, v]) => [k, v.trim() || null]));
  const unconfirmed = view.fields.filter(f => f.value && f.status === "assumed").length;

  const startEditing = () => {
    setDraft(Object.fromEntries(view.fields.map(f => [f.key, f.value ?? ""])));
    setEditing(true);
  };

  return (
    <section aria-labelledby="summary-title" className="enter card overflow-hidden">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4">
        <div>
          <h2 id="summary-title" className="text-base font-semibold text-ink">Business summary</h2>
          <p className="mt-0.5 text-sm font-light text-muted">
            {confirmed ? "Confirmed by you. The proposed team is based on this." : "Check every section. Correct anything that isn't right before you confirm."}
          </p>
        </div>
        {confirmed
          ? <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-success"><Icon icon={CheckCircleIcon} size={16} swap={false} /> Confirmed</span>
          : unconfirmed > 0 && <span className="rounded-full bg-accent-soft px-2.5 py-1 text-xs font-semibold text-accent">{unconfirmed} unconfirmed item{unconfirmed === 1 ? "" : "s"}</span>}
      </header>

      <div className="divide-y divide-line">
        {SECTIONS.map(s => (
          <div key={s.title} className="px-5 py-4">
            <h3 className="text-sm font-semibold text-ink">{s.title}</h3>
            <dl className="mt-2 space-y-3">
              {s.fields.map(k => {
                const f = field(k);
                return (
                  <div key={k}>
                    <dt className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.06em] text-muted">
                      {f.label} {!editing && <StatusPill status={f.value ? f.status : f.skipped ? "skipped" : "unknown"} />}
                    </dt>
                    <dd className="mt-1">
                      {editing ? (
                        <>
                          <label htmlFor={`sum-${k}`} className="sr-only">{f.label}</label>
                          <textarea
                            id={`sum-${k}`}
                            value={draft[k] ?? ""}
                            maxLength={600}
                            rows={k === "business_name" || k === "industry" ? 1 : 2}
                            onChange={e => setDraft(d => ({ ...d, [k]: e.target.value }))}
                            placeholder="Not known yet (leave empty to keep it unknown)"
                            className="w-full resize-y rounded-[12px] border border-line bg-surface px-3 py-2 text-sm text-ink outline-none transition-[border-color,box-shadow] placeholder:font-light placeholder:text-subtle focus:border-accent focus:shadow-[0_0_0_4px_var(--eai-glow)]"
                          />
                        </>
                      ) : (
                        <p className={cx("text-sm leading-relaxed", f.value ? "text-ink" : "font-light text-muted")}>
                          {f.value ?? (f.skipped ? "You chose not to answer." : "Not known yet.")}
                          {f.value && f.status === "assumed" && <span className="ml-1 text-xs text-accent">(the consultant inferred this; please check)</span>}
                        </p>
                      )}
                    </dd>
                  </div>
                );
              })}
              {s.insights && view.analysis && view.analysis[s.insights].length > 0 && (
                <div>
                  <dt className="text-xs font-medium uppercase tracking-[0.06em] text-muted">{s.insights === "bottlenecks" ? "From the analysis" : "Identified from your answers"}</dt>
                  <dd className="mt-1">
                    <ul className="space-y-1">
                      {view.analysis[s.insights].map(i => (
                        <li key={i.title} className="flex gap-2 text-sm text-ink">
                          <span aria-hidden="true" className="mt-[0.5rem] h-1.5 w-1.5 flex-none rounded-full bg-accent" />
                          <span>{i.title}{i.basis === "assumed" && <span className="ml-1 text-xs text-accent">(assumption)</span>}{i.basis === "supported" && <span className="ml-1 text-xs text-muted">(supported, not confirmed)</span>}</span>
                        </li>
                      ))}
                    </ul>
                  </dd>
                </div>
              )}
            </dl>
          </div>
        ))}
      </div>

      {editableStage && (
        <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-line bg-surface-2 px-5 py-4">
          {confirmed && !editing && (
            <p className="mr-auto flex items-center gap-1.5 text-xs text-muted">
              <Icon icon={WarningIcon} size={14} swap={false} /> Editing a confirmed summary withdraws the current team proposal.
            </p>
          )}
          {editing ? (
            <>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => { setEditing(false); setDraft({}); }} disabled={!!busy}>Cancel</button>
              <button
                type="button"
                className="btn btn-primary btn-sm icon-host"
                disabled={!!busy}
                onClick={async () => { const c = changes(); if (Object.keys(c).length === 0 || await onSave(c)) { setEditing(false); setDraft({}); } }}
              >
                {busy === "saving" ? <span className="animate-spin motion-reduce:animate-none"><Icon icon={CircleNotchIcon} size={16} swap={false} /></span> : <Icon icon={FloppyDiskIcon} size={16} />}
                Save corrections
              </button>
            </>
          ) : (
            <>
              <button type="button" className="btn btn-secondary btn-sm icon-host" onClick={startEditing} disabled={!!busy}>
                <Icon icon={PencilSimpleIcon} size={16} /> {confirmed ? "Edit summary" : "Correct something"}
              </button>
              {!confirmed && (
                <button type="button" className="btn btn-primary btn-sm icon-host" disabled={!!busy || view.analysisStale} onClick={() => onConfirm({})}
                  title={view.analysisStale ? "Update the analysis first" : undefined}>
                  {busy === "confirming" ? <span className="animate-spin motion-reduce:animate-none"><Icon icon={CircleNotchIcon} size={16} swap={false} /></span> : <Icon icon={CheckCircleIcon} size={16} />}
                  Confirm summary
                </button>
              )}
            </>
          )}
        </footer>
      )}
    </section>
  );
}
