"use client";

import Link from "next/link";
import { useState } from "react";
import {
  Icon, ArrowRightIcon, ArrowsClockwiseIcon, CheckCircleIcon, CircleNotchIcon, FlowArrowIcon, InfoIcon, ListBulletsIcon,
  ShieldCheckIcon, TreeStructureIcon, TrashIcon, XIcon,
} from "@/components/icons";
import type { Params, ValidationResult } from "@/lib/workflows/schema";
import type { WorkspaceView } from "@/lib/workflows/view-types";
import { cx } from "@/lib/cx";
import { StepDetail } from "./StepDetail";
import { StepList } from "./StepList";
import { WorkflowDiagram } from "./WorkflowDiagram";
import { WorkflowSettings } from "./WorkflowSettings";
import { DemoDataCard, StatusBadge, ValidationPanel, VersionHistory } from "./WorkflowPanels";
import { callWorkspace, when } from "./workspace-api";

type Busy = "generating" | "saving" | "approving" | "discarding" | null;

const NOT_RUNNING = "Not running — test runs arrive in the next stage. No real orders, messages or payments.";

/**
 * Workflows tab (M3): build, check, adjust and APPROVE the restaurant workflow. Approving records the
 * owner's decision only; nothing executes until the test runner in the next stage (M4).
 */
export function WorkflowWorkspace({ initialView }: { initialView: WorkspaceView }) {
  const [view, setView] = useState(initialView);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [shownId, setShownId] = useState<string | null>(initialView.workflows[0]?.id ?? null);
  const [selected, setSelected] = useState<string | null>(null);
  const [mode, setMode] = useState<"diagram" | "list">("diagram");
  const [confirming, setConfirming] = useState(false);
  /** Set when the server has just refused an approval, so the blocked panel is announced. */
  const [refused, setRefused] = useState(false);
  const base = `/api/w/${view.businessId}/workflows`;

  const act = async (kind: Exclude<Busy, null>, path: string, method: "POST" | "PATCH", body: unknown, after?: (v: WorkspaceView) => void) => {
    setBusy(kind); setError(null); setRefused(false);
    const r = await callWorkspace(path, method, body);
    setBusy(null);
    if (r.view) {
      setView(r.view);
      after?.(r.view);
    }
    // A refused approval is explained once, by the blocked panel (built from the saved check results),
    // instead of also repeating the server's generic message.
    if (!r.ok && r.code === "WORKFLOW_INVALID" && r.view) setRefused(true);
    else if (!r.ok) setError(r.message);
    return r.ok;
  };
  const showNewest = (v: WorkspaceView) => { setShownId(v.workflows[0]?.id ?? null); setConfirming(false); };

  const generate = () => act("generating", `${base}/generate`, "POST", {}, showNewest);

  // ---- Gate states
  if (!view.teamApproved) {
    return (
      <Gate title="Approve your team first" icon={ShieldCheckIcon}>
        <p>Workflows are built only from an approved team. Review and approve your AI team in discovery, then come back here.</p>
        <Link href={`/start/${view.businessId}`} className="btn btn-primary btn-sm icon-host mt-4">Back to discovery <Icon icon={ArrowRightIcon} size={16} /></Link>
      </Gate>
    );
  }
  if (!view.runnable) {
    return (
      <Gate title="Workflows are in Preview for this business" icon={InfoIcon}>
        <p>This prototype builds workflows only for the restaurant demo. Your discovery answers and proposed team are saved, and the team stays in Preview: nothing is built, approved or run for it.</p>
        <Link href={`/w/${view.businessId}/team`} className="btn btn-secondary btn-sm icon-host mt-4">View your team <Icon icon={ArrowRightIcon} size={16} /></Link>
      </Gate>
    );
  }

  const wf = view.workflows.find(w => w.id === shownId) ?? view.workflows[0];
  if (!wf) {
    return (
      <div className="space-y-5">
        <Gate title="Build the workflow for your team" icon={FlowArrowIcon}>
          <p>EmployAI builds the “Order to restock” workflow from fixed templates, using only your approved agents and the tasks you kept. You can check every step and adjust the money settings before approving.</p>
          <p className="mt-2 flex items-start gap-2 text-muted"><Icon icon={InfoIcon} size={16} swap={false} className="mt-0.5 flex-none text-accent" />{NOT_RUNNING}</p>
          <button type="button" className="btn btn-primary btn-sm icon-host mt-4" onClick={generate} disabled={!!busy}>
            {busy === "generating" ? <Spinner /> : <Icon icon={TreeStructureIcon} size={16} />} Build workflow
          </button>
          {error && <p role="alert" className="mt-3 text-sm font-medium text-danger">{error}</p>}
        </Gate>
      </div>
    );
  }

  const draft = view.workflows.find(w => w.status === "draft");
  const isDraft = wf.status === "draft";
  const canApprove = isDraft && wf.validation.valid;
  const step = wf.doc.steps.find(s => s.id === selected) ?? null;

  const saveSettings = (patch: Partial<Params>) => act("saving", `${base}/${wf.id}`, "PATCH", { settings: patch }, showNewest);
  const approve = () => act("approving", `${base}/${wf.id}/approve`, "POST", {}, () => { setShownId(wf.id); setConfirming(false); });
  const discard = () => act("discarding", `${base}/${wf.id}/discard`, "POST", {}, showNewest);

  const settingsLock =
    wf.status === "superseded" ? { locked: true, reason: "This version was replaced and is kept for your records." }
    : wf.status === "approved" && draft ? { locked: true, reason: `Version ${draft.version} is a newer draft. Edit that one instead.` }
    : { locked: false, reason: undefined };

  return (
    <div className="space-y-5">
      {/* Header: name, version, status, actions */}
      <section aria-labelledby="wf-title" className="card px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 id="wf-title" className="text-xl font-semibold text-ink">{wf.doc.name}</h1>
              <span className="text-sm font-medium text-muted">Version {wf.version}</span>
              <StatusBadge status={wf.status} />
            </div>
            <p className="mt-1 text-sm font-light text-muted">
              {wf.status === "approved" && wf.approvedAt ? `You approved this version on ${when(wf.approvedAt)}.`
                : wf.status === "superseded" ? "An older version, replaced by a newer approval. Kept for your records."
                : "Draft. Check the steps and settings, then approve it."}
              {" "}{wf.doc.steps.length} steps, built from your approved team.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {isDraft && !confirming && (
              <>
                <button type="button" className="btn btn-secondary btn-sm icon-host" onClick={discard} disabled={!!busy}>
                  {busy === "discarding" ? <Spinner /> : <Icon icon={TrashIcon} size={16} />} Discard draft
                </button>
                <button type="button" className="btn btn-primary btn-sm icon-host" onClick={() => setConfirming(true)} disabled={!!busy || !canApprove}
                  aria-describedby={!canApprove ? "approve-blocked" : undefined}>
                  <Icon icon={CheckCircleIcon} size={16} /> Approve workflow
                </button>
              </>
            )}
            {!isDraft && !draft && (
              <button type="button" className="btn btn-secondary btn-sm icon-host" onClick={generate} disabled={!!busy}>
                {busy === "generating" ? <Spinner /> : <Icon icon={ArrowsClockwiseIcon} size={16} />} Rebuild as new draft
              </button>
            )}
            {!isDraft && draft && (
              <button type="button" className="btn btn-secondary btn-sm icon-host" onClick={() => { setShownId(draft.id); setSelected(null); }}>
                Open draft (version {draft.version}) <Icon icon={ArrowRightIcon} size={16} />
              </button>
            )}
          </div>
        </div>

        {confirming && isDraft && (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-accent-line bg-accent-soft px-4 py-3" role="group" aria-label="Confirm approval">
            <p className="text-sm text-ink">Approve version {wf.version}? Your approval is recorded with a timestamp. Approving doesn&rsquo;t run anything{view.workflows.some(w => w.status === "approved") ? ", and it replaces the version you approved before" : ""}.</p>
            <div className="flex gap-2">
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setConfirming(false)} disabled={!!busy}>Not yet</button>
              <button type="button" className="btn btn-primary btn-sm icon-host" onClick={approve} disabled={!!busy}>
                {busy === "approving" ? <Spinner /> : <Icon icon={CheckCircleIcon} size={16} />} Yes, approve workflow
              </button>
            </div>
          </div>
        )}
        {isDraft && !wf.validation.valid && <ApprovalBlocked id="approve-blocked" validation={wf.validation} justRefused={refused} />}
        <p className="mt-3 flex items-start gap-2 rounded-xl bg-surface-2 px-3 py-2.5 text-sm text-ink" role="note">
          <Icon icon={ShieldCheckIcon} size={16} swap={false} className="mt-0.5 flex-none text-accent" />
          {NOT_RUNNING}
        </p>
        {error && (
          <p role="alert" className="mt-3 flex items-start gap-2 text-sm font-medium text-danger">
            <Icon icon={XIcon} size={16} swap={false} className="mt-0.5 flex-none" />{error}
          </p>
        )}
        {wf.doc.notes.length > 0 && (
          <ul className="mt-3 space-y-1" aria-label="What was left out">
            {wf.doc.notes.map(n => <li key={n} className="flex items-start gap-2 text-sm text-muted"><Icon icon={InfoIcon} size={16} swap={false} className="mt-0.5 flex-none text-accent" />{n}</li>)}
          </ul>
        )}
      </section>

      {/* Steps: diagram (md and up) or accessible list */}
      <section aria-labelledby="steps-title" className="card p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 id="steps-title" className="text-base font-semibold text-ink">Steps</h2>
            <p className="text-sm font-light text-muted">Select a step to see who does it, what it may touch and where it goes next.</p>
          </div>
          <div className="hidden rounded-full border border-line p-0.5 md:flex" role="group" aria-label="Show steps as">
            {(["diagram", "list"] as const).map(m => (
              <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)}
                className={cx("icon-host inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-medium transition-colors",
                  mode === m ? "bg-ink text-on-ink" : "text-muted hover:text-ink")}>
                <Icon icon={m === "diagram" ? TreeStructureIcon : ListBulletsIcon} size={16} swap={false} /> {m === "diagram" ? "Diagram" : "List"}
              </button>
            ))}
          </div>
        </div>

        {mode === "diagram" && (
          <div className="mt-5 hidden gap-6 md:flex md:flex-col lg:flex-row lg:items-start">
            <div className="min-w-0 flex-none"><WorkflowDiagram doc={wf.doc} agents={view.agents} selected={selected} onSelect={setSelected} /></div>
            {/* On desktop the panel scrolls on its own, so every detail stays reachable on short screens. */}
            <aside aria-label="Step details" aria-live="polite" tabIndex={step ? 0 : undefined}
              className="min-w-0 flex-1 rounded-2xl border border-line p-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-solid lg:sticky lg:top-[124px] lg:max-h-[calc(100dvh-140px)] lg:overflow-y-auto lg:overscroll-contain">
              {step
                ? <StepDetail step={step} doc={wf.doc} agents={view.agents} onSelect={setSelected} />
                : <p className="text-sm text-muted">Select a step in the diagram to see its details. Steps outlined in violet guard the payment: the security check, your approval and the payment request.</p>}
            </aside>
          </div>
        )}

        <div className={cx("mt-4", mode === "diagram" && "md:hidden")}>
          <StepList doc={wf.doc} agents={view.agents} selected={selected} onSelect={setSelected}
            onToggle={id => setSelected(cur => (cur === id ? null : id))} />
        </div>
      </section>

      <div className="grid gap-5 lg:grid-cols-2">
        <section aria-labelledby="settings-title" className="card p-5">
          <h2 id="settings-title" className="text-base font-semibold text-ink">Money and notification settings</h2>
          <p className="mb-4 text-sm font-light text-muted">
            {wf.status === "approved" && !draft ? "This version is approved and locked. Saving a change creates a new draft for you to approve." : "The only parts you can change. Steps, agents, tools and who can be paid are fixed by the template."}
          </p>
          <WorkflowSettings params={wf.doc.params} limits={view.paramLimits} locked={settingsLock.locked} lockedReason={settingsLock.reason} saving={busy === "saving"} saveLabel={wf.status === "approved" ? "Save as new draft" : "Save settings"} onSave={saveSettings} />
        </section>
        <section aria-labelledby="checks-title" className="card p-5">
          <h2 id="checks-title" className="mb-3 scroll-mt-32 text-base font-semibold text-ink">Safety checks</h2>
          <ValidationPanel validation={wf.validation} />
        </section>
      </div>

      {view.demoData && <DemoDataCard data={view.demoData} />}

      <section aria-labelledby="history-title" className="card p-5">
        <h2 id="history-title" className="text-base font-semibold text-ink">Versions</h2>
        <p className="mb-3 text-sm font-light text-muted">Approved versions are locked and kept. Only one version is approved at a time.</p>
        <VersionHistory workflows={view.workflows} shownId={wf.id} onShow={id => { setShownId(id); setSelected(null); setConfirming(false); }} />
      </section>
    </div>
  );
}

function Spinner() {
  return <span className="animate-spin motion-reduce:animate-none"><Icon icon={CircleNotchIcon} size={16} swap={false} /></span>;
}

function Gate({ title, icon, children }: { title: string; icon: typeof InfoIcon; children: React.ReactNode }) {
  return (
    <section className="card mx-auto max-w-2xl px-6 py-6">
      <span className="inline-flex h-11 w-11 items-center justify-center rounded-xl bg-accent-soft text-accent"><Icon icon={icon} size={22} swap={false} /></span>
      <h1 className="mt-3 text-xl font-semibold text-ink">{title}</h1>
      <div className="mt-2 text-sm leading-relaxed text-ink">{children}</div>
    </section>
  );
}

/** One explanation when a draft can't be approved: which checks failed, and where to read why. */
function ApprovalBlocked({ id, validation, justRefused }: { id: string; validation: ValidationResult; justRefused: boolean }) {
  const failed = validation.checks.filter(c => !c.passed);
  return (
    <div id={id} role={justRefused ? "alert" : undefined} className="mt-3 rounded-xl border border-danger/50 px-4 py-3">
      <p className="flex items-start gap-2 text-sm font-semibold text-danger">
        <Icon icon={XIcon} size={16} swap={false} className="mt-0.5 flex-none" />
        {justRefused
          ? `Approval refused: when this draft was re-checked, ${failed.length} of ${validation.checks.length} safety checks failed.`
          : `This draft can’t be approved: ${failed.length} of ${validation.checks.length} safety checks failed.`}
      </p>
      <ul className="ml-6 mt-1.5 list-disc space-y-0.5 pl-4 text-sm text-ink">
        {failed.map(c => <li key={c.code}>{c.label}</li>)}
      </ul>
      <a href="#checks-title" className="ml-6 mt-1.5 inline-block text-sm font-medium text-accent underline-offset-2 hover:underline">See why in Safety checks</a>
    </div>
  );
}
