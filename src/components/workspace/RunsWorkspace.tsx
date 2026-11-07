"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Icon, ArrowCounterClockwiseIcon, ArrowRightIcon, CheckCircleIcon, CircleNotchIcon, ClockIcon, HandPalmIcon, InfoIcon,
  PlayCircleIcon, ReceiptIcon, ShieldCheckIcon, TargetIcon, WarningIcon, XIcon,
} from "@/components/icons";
import type { GateDecision, RunStatus } from "@/lib/runs/types";
import type { RunView, RunsView } from "@/lib/runs/view-types";
import { cx } from "@/lib/cx";
import { callRuns, newIdempotencyKey, type RunsCall } from "./runs-api";
import { ngn, when } from "./workspace-api";

const ACTIVE: RunStatus[] = ["running", "waiting_approval", "paused", "interrupted"];
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const STATUS_TEXT: Record<RunStatus, string> = {
  running: "Running", waiting_approval: "Waiting for your approval", paused: "Paused", completed: "Completed", blocked: "Blocked",
  rejected: "Declined", failed: "Failed", interrupted: "Interrupted", cancelled: "Cancelled",
};
const END_TEXT: Record<string, string> = {
  completed: "Completed", no_reorder: "No reorder needed", manual_order: "Reorder handed to you", blocked: "Payment blocked", rejected: "You declined the payment",
  approval: "Waits for your approval", failed: "Failed", KILL_SWITCH_ACTIVE: "Stopped by the kill switch", STOPPED_BY_OWNER: "Stopped by you", WORKFLOW_CHANGED: "Workflow changed",
};

/**
 * M4 · Runs tab: run the APPROVED workflow as a labelled test run on fictional demo data and watch the
 * rule-based agents coordinate. The page asks the server to advance the run one bounded batch at a time
 * (one request in flight); reading the run never executes anything. No real orders, messages or payments.
 */
export function RunsWorkspace({ initialView, initialRun }: { initialView: RunsView; initialRun: RunView | null }) {
  const [view, setView] = useState(initialView);
  const [run, setRun] = useState<RunView | null>(initialRun);
  const [scenario, setScenario] = useState(initialView.scenarios[0]?.key ?? "standard");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"approve" | "reject" | "stop" | null>(null);
  const base = `/api/w/${view.businessId}`;
  const pumping = useRef<string | null>(null);
  const mounted = useRef(true);
  const shownSteps = useRef(initialRun?.steps.length ?? 0);
  // Set on every mount: StrictMode (dev) mounts, unmounts and mounts again.
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  // A server refresh (e.g. the kill switch in the header) brings fresh props: adopt them. The open run
  // is replaced only if it's the same run, so a run picked from history stays on screen.
  useEffect(() => {
    setView(initialView);
    setRun(cur => (initialRun && (!cur || cur.run.id === initialRun.run.id) ? initialRun : cur));
  }, [initialView, initialRun]);

  const apply = useCallback((r: RunsCall) => {
    if (r.view) setView(r.view);
    if (r.run) setRun(r.run);
  }, []);

  /** Advance the run until it waits or ends: one request at a time, retried with back-off on errors. */
  const pump = useCallback(async (runId: string) => {
    if (pumping.current === runId) return;
    pumping.current = runId;
    let failures = 0;
    try {
      for (let i = 0; i < 60 && mounted.current; i++) {
        const r = await callRuns(`${base}/runs/${runId}/advance`, "POST", {});
        if (!r.ok) {
          if ((r.status === 0 || r.status >= 500 || r.code === "BUSY") && failures < 3) { failures++; await sleep(1000 * 2 ** (failures - 1)); continue; }
          apply(r); setError(r.message); return;
        }
        failures = 0;
        apply(r);
        if (r.settling) { await sleep(2000); continue; }   // a step is still being checked after an interruption
        if (!r.more) return;
      }
    } finally { pumping.current = null; }
  }, [apply, base]);

  // Keep a running run moving; while it waits (approval, pause, interruption) only READ it, so other
  // tabs' decisions and expiry show up. Ended runs aren't polled.
  const status = run?.run.status;
  const runId = run?.run.id;
  useEffect(() => {
    if (!runId || !status) return;
    if (status === "running" && run?.more) { void pump(runId); return; }
    if (!ACTIVE.includes(status)) return;
    const t = setInterval(async () => {
      if (pumping.current) return;
      const r = await callRuns(`${base}/runs/${runId}`, "GET");
      if (r.ok) apply(r);
    }, 2000);
    return () => clearInterval(t);
  }, [runId, status, run?.more, base, pump, apply]);

  const act = async (label: string, path: string, body: unknown, headers?: Record<string, string>) => {
    setBusy(label); setError(null);
    const r = await callRuns(path, "POST", body, headers);
    setBusy(null); setConfirm(null);
    apply(r);
    if (!r.ok) setError(r.message);
    return r;
  };

  const start = async () => {
    if (!view.workflow) return;
    shownSteps.current = 0;
    const r = await act("start", `${base}/runs`, { workflow_id: view.workflow.id, scenario }, { "Idempotency-Key": newIdempotencyKey() });
    if (r.ok && r.run) void pump(r.run.run.id);
  };
  const decide = async (decision: "approve" | "reject") => {
    if (!run?.approval) return;
    const r = await act(decision, `${base}/approvals/${run.approval.id}`, { decision });
    if (r.ok && r.run) void pump(r.run.run.id);
  };
  const control = async (c: "pause" | "resume" | "stop") => {
    if (!run) return;
    const r = await act(c, `${base}/runs/${run.run.id}/${c}`, {});
    if (r.ok && c === "resume" && r.run) void pump(r.run.run.id);
  };
  const openRun = async (id: string) => {
    setError(null);
    const r = await callRuns(`${base}/runs/${id}`, "GET");
    shownSteps.current = r.ok && r.run ? r.run.steps.length : 0;
    apply(r);
  };
  const pauseAgent = async (key: string, paused: boolean) => {
    setBusy(`agent:${key}`); setError(null);
    const r = await callRuns(`${base}/team/${key}`, "PATCH", { status: paused ? "paused" : "approved" });
    setBusy(null);
    apply(r);
    if (!r.ok) setError(r.message);
    else if (run && ACTIVE.includes(run.run.status)) { const g = await callRuns(`${base}/runs/${run.run.id}`, "GET"); apply(g); }
  };

  const active = run && ACTIVE.includes(run.run.status);
  const canStart = view.eligibility.canRun && !busy && !view.activeRunId;
  const reveal = shownSteps.current;
  useEffect(() => { shownSteps.current = run?.steps.length ?? 0; }, [run?.steps.length]);

  return (
    <div className="space-y-5">
      <section aria-labelledby="runs-title" className="card px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 id="runs-title" className="text-xl font-semibold text-ink">Test runs</h1>
            <p className="mt-1 text-sm font-light text-muted">
              Run your approved workflow on fictional demo data and watch the agents coordinate. Nothing is ordered, sent or paid.
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Tag>Rule-based agents (offline)</Tag><Tag>Demo data · fictional</Tag><Tag>Test run — no transaction</Tag>
              {view.workflow && <Tag>Workflow version {view.workflow.version}</Tag>}
            </div>
          </div>
        </div>
        {!view.eligibility.canRun && <Eligibility view={view} />}
      </section>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
        <section aria-labelledby="addresses-title" className="card px-5 py-4">
          <h2 id="addresses-title" className="flex items-center gap-2 text-base font-semibold text-ink"><Icon icon={TargetIcon} size={18} swap={false} className="text-accent" />What this workflow addresses</h2>
          <p className="mt-0.5 text-xs text-muted">Your business information, from discovery. Test runs never change it.</p>
          {view.addresses.length ? (
            <ul className="mt-3 space-y-2">
              {view.addresses.map((a, i) => (
                <li key={i} className="rounded-xl bg-surface-2 px-3 py-2.5 text-sm">
                  <p className="font-medium text-ink">{a.kind === "goal" ? "Your goal: " : a.kind === "need" ? "You asked for: " : ""}{a.text}</p>
                  {a.cause && <p className="mt-0.5 text-xs text-muted">Cause: {a.cause}</p>}
                  <p className="mt-1 text-[0.6875rem] font-semibold text-accent">{a.basis}</p>
                </li>
              ))}
            </ul>
          ) : <p className="mt-3 text-sm text-muted">No confirmed problem is recorded for this business yet.</p>}
        </section>

        <section aria-labelledby="scenario-title" className="card px-5 py-4">
          <h2 id="scenario-title" className="text-base font-semibold text-ink">Choose a demo scenario</h2>
          <p className="mt-0.5 text-xs text-muted">{view.demoLabel} Security rules and your settings are the same in every scenario.</p>
          <fieldset className="mt-3 space-y-2" disabled={!view.eligibility.canRun || !!active}>
            <legend className="sr-only">Demo scenario</legend>
            {view.scenarios.map(s => (
              <label key={s.key} className={cx("flex cursor-pointer items-start gap-3 rounded-xl border px-3 py-2.5 text-sm transition-colors",
                scenario === s.key ? "border-accent-solid bg-accent-soft" : "border-line hover:bg-surface-2")}>
                <input type="radio" name="scenario" value={s.key} checked={scenario === s.key} onChange={() => setScenario(s.key)} className="mt-1 accent-[var(--color-accent-solid)]" />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium text-ink">{s.title}</span>
                    <span className="flex items-center gap-1.5 text-xs text-muted">Expected: {s.expected.decision ? <DecisionBadge decision={s.expected.decision} /> : <span className="font-medium text-ink">{END_TEXT[s.expected.end] ?? s.expected.end}</span>}</span>
                  </span>
                  <span className="mt-0.5 block text-xs text-muted">{s.changes} {s.description}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <button type="button" className="btn btn-primary btn-sm icon-host mt-4" onClick={start} disabled={!canStart}>
            {busy === "start" ? <Spinner /> : <Icon icon={PlayCircleIcon} size={16} />} Run demo order
          </button>
          {view.activeRunId && <p className="mt-2 text-xs text-muted">A test run is already active. Finish or stop it before starting another.</p>}
        </section>
      </div>

      {error && <p role="alert" className="rounded-xl bg-surface px-4 py-3 text-sm font-medium text-danger ring-1 ring-line">{error}</p>}

      {run && <RunPanel run={run} busy={busy} confirm={confirm} setConfirm={setConfirm} onDecide={decide} onControl={control} reveal={reveal} />}

      <div className="grid gap-5 lg:grid-cols-2">
        <section aria-labelledby="history-title" className="card px-5 py-4">
          <h2 id="history-title" className="text-base font-semibold text-ink">Run history</h2>
          {view.runs.length ? (
            <ul className="mt-3 divide-y divide-line">
              {view.runs.map(r => (
                <li key={r.id}>
                  <button type="button" onClick={() => openRun(r.id)} className={cx("flex w-full items-center justify-between gap-3 py-2.5 text-left text-sm hover:text-accent", run?.run.id === r.id && "font-semibold")}>
                    <span className="min-w-0"><span className="text-ink">{r.scenarioTitle}</span> <span className="text-xs text-muted">· v{r.workflowVersion} · {when(r.startedAt)}</span></span>
                    <RunStatusBadge status={r.status} />
                  </button>
                </li>
              ))}
            </ul>
          ) : <p className="mt-2 text-sm text-muted">No test runs yet.</p>}
        </section>
        <section aria-labelledby="agents-title" className="card px-5 py-4">
          <h2 id="agents-title" className="text-base font-semibold text-ink">Agents</h2>
          <p className="mt-0.5 text-xs text-muted">Pause an agent to stop its steps from starting. A paused Finance Agent's payment requests are blocked.</p>
          <ul className="mt-3 space-y-2">
            {view.agents.map(a => (
              <li key={a.key} className="flex items-center justify-between gap-3 rounded-xl bg-surface-2 px-3 py-2 text-sm">
                <span className="text-ink">{a.name} <span className="text-xs text-muted">· {a.status === "paused" ? "Paused" : a.runnable ? "Approved" : "Approved · Preview"}</span></span>
                <button type="button" className="btn btn-secondary btn-sm" disabled={!!busy || !a.runnable} onClick={() => pauseAgent(a.key, a.status !== "paused")}>
                  {busy === `agent:${a.key}` ? <Spinner /> : a.status === "paused" ? "Resume" : "Pause"}
                </button>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}

function RunPanel({ run, busy, confirm, setConfirm, onDecide, onControl, reveal }: {
  run: RunView; busy: string | null; confirm: "approve" | "reject" | "stop" | null; setConfirm: (c: "approve" | "reject" | "stop" | null) => void;
  onDecide: (d: "approve" | "reject") => void; onControl: (c: "pause" | "resume" | "stop") => void; reveal: number;
}) {
  const r = run.run;
  const active = ACTIVE.includes(r.status);
  return (
    <section aria-labelledby="run-title" className="card px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="run-title" className="flex flex-wrap items-center gap-2 text-base font-semibold text-ink">{r.scenarioTitle} <RunStatusBadge status={r.status} /></h2>
          <p className="mt-0.5 text-xs text-muted" aria-live="polite">
            Started {when(r.startedAt)} · workflow version {r.workflowVersion} · {r.stepsDone} steps
            {r.pauseReason?.startsWith("agent_paused:") ? ` · waiting because an agent is paused` : ""}
            {r.interruptedDetected ? " · a step was cut off; it will be marked interrupted" : r.settling ? " · checking a step that was cut off…" : ""}
          </p>
        </div>
        {active && confirm !== "stop" && (
          <div className="flex flex-wrap gap-2">
            {r.status === "running" && <button type="button" className="btn btn-secondary btn-sm icon-host" disabled={!!busy} onClick={() => onControl("pause")}><Icon icon={HandPalmIcon} size={16} /> Pause</button>}
            {(r.status === "paused" || r.status === "interrupted") && <button type="button" className="btn btn-secondary btn-sm icon-host" disabled={!!busy} onClick={() => onControl("resume")}><Icon icon={ArrowCounterClockwiseIcon} size={16} /> Resume</button>}
            <button type="button" className="btn btn-secondary btn-sm icon-host" disabled={!!busy} onClick={() => setConfirm("stop")}><Icon icon={XIcon} size={16} /> Stop</button>
          </div>
        )}
        {confirm === "stop" && (
          <div role="group" aria-label="Confirm stop" className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-ink">Stop this run? Nothing more will run, and a waiting approval is cancelled.</span>
            <button type="button" className="btn btn-primary btn-sm" disabled={!!busy} onClick={() => onControl("stop")}>{busy === "stop" ? <Spinner /> : "Stop run"}</button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setConfirm(null)}>Cancel</button>
          </div>
        )}
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl bg-surface-2 px-3 py-2.5 text-sm">
          <p className="text-xs font-semibold uppercase tracking-[0.06em] text-muted">Expected</p>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-ink">{r.expected.decision && <DecisionBadge decision={r.expected.decision} />}{END_TEXT[r.expected.end] ?? r.expected.end}</p>
        </div>
        <div className="rounded-xl bg-surface-2 px-3 py-2.5 text-sm">
          <p className="text-xs font-semibold uppercase tracking-[0.06em] text-muted">Actual</p>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-ink">{r.actual.decision && <DecisionBadge decision={r.actual.decision} />}{r.actual.end ? END_TEXT[r.actual.end] ?? r.actual.end : STATUS_TEXT[r.status]}</p>
        </div>
      </div>

      {run.approval && run.approval.status === "pending" && r.status === "waiting_approval" && (
        <div className="mt-4 rounded-2xl border border-accent-line bg-accent-soft px-4 py-3" role="region" aria-labelledby="approval-title">
          <h3 id="approval-title" className="flex items-center gap-2 text-sm font-semibold text-ink"><Icon icon={ShieldCheckIcon} size={18} swap={false} className="text-accent" />Your approval is needed</h3>
          <dl className="mt-2 grid gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
            <div><dt className="inline text-muted">Agent: </dt><dd className="inline text-ink">Finance Agent · payment request</dd></div>
            <div><dt className="inline text-muted">Pay: </dt><dd className="inline text-ink">{run.approval.beneficiary}</dd></div>
            <div><dt className="inline text-muted">Amount: </dt><dd className="inline font-semibold text-ink">{ngn(run.approval.amountNgn)} <span className="font-normal text-muted">(illustrative)</span></dd></div>
            <div><dt className="inline text-muted">Through: </dt><dd className="inline text-ink">{run.approval.channel}</dd></div>
            <div><dt className="inline text-muted">Your threshold: </dt><dd className="inline text-ink">{ngn(run.approval.thresholdNgn)} · maximum {ngn(run.approval.maxPaymentNgn)}</dd></div>
            <div><dt className="inline text-muted">Expires: </dt><dd className="inline text-ink">{run.approval.expiredNotPersisted ? "Expired" : when(run.approval.expiresAt)}</dd></div>
          </dl>
          <ul className="mt-2 space-y-1 text-sm">{run.approval.reasons.map(x => <li key={x.code} className="flex items-start gap-2 text-ink"><Icon icon={WarningIcon} size={16} swap={false} className="mt-0.5 flex-none text-accent" />{x.text}</li>)}</ul>
          {run.approval.rationale && <p className="mt-2 text-xs text-muted">{run.approval.rationale}</p>}
          <p className="mt-2 text-xs text-muted">Approving records only a simulated payment: test run, no transaction. Your approval is checked again before it takes effect.</p>
          {!run.approval.expiredNotPersisted && (confirm === "approve" || confirm === "reject" ? (
            <div role="group" aria-label="Confirm decision" className="mt-3 flex flex-wrap items-center gap-2">
              <span className="text-sm text-ink">{confirm === "approve" ? `Approve ${ngn(run.approval.amountNgn)} to ${run.approval.beneficiary}?` : "Decline this payment?"}</span>
              <button type="button" className="btn btn-primary btn-sm" disabled={!!busy} onClick={() => onDecide(confirm)}>{busy === confirm ? <Spinner /> : confirm === "approve" ? "Yes, approve" : "Yes, decline"}</button>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setConfirm(null)}>Back</button>
            </div>
          ) : (
            <div className="mt-3 flex flex-wrap gap-2">
              <button type="button" className="btn btn-primary btn-sm icon-host" disabled={!!busy} onClick={() => setConfirm("approve")}><Icon icon={CheckCircleIcon} size={16} /> Approve</button>
              <button type="button" className="btn btn-secondary btn-sm icon-host" disabled={!!busy} onClick={() => setConfirm("reject")}><Icon icon={XIcon} size={16} /> Reject</button>
            </div>
          ))}
        </div>
      )}

      <h3 className="mt-5 text-sm font-semibold text-ink">Collaboration timeline</h3>
      <ol className="mt-2 space-y-2" aria-live="polite">
        {run.steps.map((s, i) => (
          <li key={s.id} className={cx("rounded-xl px-3 py-2.5 text-sm", i >= reveal ? "enter" : "", s.status === "waiting" ? "border border-accent-line bg-accent-soft" : "bg-surface-2")}
            style={i >= reveal ? ({ "--enter-delay": `${(i - reveal) * 300}ms` } as React.CSSProperties) : undefined}>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <p className="font-medium text-ink">{s.title}</p>
              <StepStatus status={s.status} />
            </div>
            <p className="mt-0.5 text-xs text-muted">
              {s.requester === "orchestrator" && s.agentKey && s.agentKey !== "orchestrator" && s.agentKey !== "system" ? `Business Orchestrator → ${s.agentName}` : s.agentName}
              {s.task ? ` · ${s.task}` : ""}{s.attempt > 1 ? ` · attempt ${s.attempt}` : ""} · {new Date(s.startedAt).toLocaleTimeString("en-GB")}{s.durationMs !== null ? ` · ${s.durationMs} ms` : ""}
            </p>
            {s.reasoning && <p className="mt-1 text-ink">{s.reasoning}</p>}
            {s.error && <p className="mt-1 text-danger">{s.error.message} <span className="text-xs">({s.error.code})</span></p>}
            {(s.toolsUsed.length > 0 || s.simulated.length > 0) && (
              <p className="mt-1 flex flex-wrap gap-1.5 text-[0.6875rem]">
                {s.toolsUsed.map(t => <span key={t} className="rounded-full bg-surface px-2 py-0.5 text-muted ring-1 ring-line">{t}</span>)}
                {s.simulated.map(l => <span key={l} className="rounded-full bg-accent-soft px-2 py-0.5 font-semibold text-accent">{l}</span>)}
              </p>
            )}
          </li>
        ))}
        {r.status === "running" && <li className="flex items-center gap-2 px-3 py-2 text-sm text-muted"><Spinner /> Working…</li>}
      </ol>

      {run.decisions.length > 0 && (
        <div className="mt-4 rounded-xl bg-surface-2 px-3 py-2.5 text-sm">
          <p className="flex flex-wrap items-center gap-2 font-medium text-ink"><Icon icon={ShieldCheckIcon} size={16} swap={false} className="text-accent" />Security check {run.decisions.map(d => <DecisionBadge key={d.id} decision={d.decision} />)}</p>
          <ul className="mt-1 space-y-0.5 text-xs text-muted">{run.decisions.flatMap(d => d.reasons).map(x => <li key={x.code}>{x.text}</li>)}</ul>
          <p className="mt-1 text-xs text-muted">Test-run decision on demo data. On-chain checks run from the next stage.</p>
        </div>
      )}

      {run.ledger.length > 0 && (
        <div className="mt-3 rounded-xl bg-surface-2 px-3 py-2.5 text-sm">
          {run.ledger.map(l => (
            <p key={l.id} className="flex flex-wrap items-center gap-2 text-ink"><Icon icon={ReceiptIcon} size={16} swap={false} className="text-accent" />
              {ngn(l.amount)} to {l.counterparty} <span className="rounded-full bg-surface px-2 py-0.5 text-[0.6875rem] font-semibold text-ink ring-1 ring-line">{l.label}</span></p>
          ))}
        </div>
      )}

      {r.summary && <p className="mt-3 text-sm text-ink"><span className="font-semibold">Summary: </span>{r.summary}</p>}
      {r.error && <p className="mt-2 text-sm text-danger">{r.error.message}</p>}
    </section>
  );
}

function Eligibility({ view }: { view: RunsView }) {
  const to = view.eligibility.code === "DISCOVERY_INCOMPLETE" ? { href: `/start/${view.businessId}`, label: "Back to discovery" }
    : ["REAPPROVAL_REQUIRED", "WORKFLOW_NOT_APPROVED", "APPROVAL_FINGERPRINT_MISMATCH", "WORKFLOW_INVALID"].includes(view.eligibility.code ?? "") ? { href: `/w/${view.businessId}/workflows`, label: "Go to Workflows" }
    : view.eligibility.code === "TEAM_NOT_APPROVED" ? { href: `/start/${view.businessId}`, label: "Review your team" } : null;
  return (
    <div role="note" className="mt-3 rounded-xl bg-surface-2 px-3 py-2.5 text-sm text-ink">
      <p className="flex items-start gap-2"><Icon icon={InfoIcon} size={16} swap={false} className="mt-0.5 flex-none text-accent" />{view.eligibility.message}</p>
      {to && <Link href={to.href} className="btn btn-secondary btn-sm icon-host mt-2">{to.label} <Icon icon={ArrowRightIcon} size={16} /></Link>}
    </div>
  );
}

function DecisionBadge({ decision }: { decision: GateDecision }) {
  const m = {
    ALLOW: { cls: "text-success ring-1 ring-success/40", icon: CheckCircleIcon },
    WARN: { cls: "bg-accent-soft text-accent", icon: WarningIcon },
    BLOCK: { cls: "text-danger ring-1 ring-danger/40", icon: XIcon },
  }[decision];
  return <span className={cx("inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[0.6875rem] font-semibold", m.cls)}><Icon icon={m.icon} size={12} swap={false} />{decision}</span>;
}

function RunStatusBadge({ status }: { status: RunStatus }) {
  const cls = status === "completed" ? "text-success ring-1 ring-success/40"
    : status === "blocked" || status === "failed" ? "text-danger ring-1 ring-danger/40"
    : status === "waiting_approval" || status === "running" ? "bg-accent-soft text-accent"
    : "bg-surface-2 text-muted ring-1 ring-line";
  return <span className={cx("whitespace-nowrap rounded-full px-2 py-0.5 text-[0.6875rem] font-semibold", cls)}>{STATUS_TEXT[status]}</span>;
}

function StepStatus({ status }: { status: string }) {
  const m: Record<string, [string, typeof CheckCircleIcon, string]> = {
    succeeded: ["Done", CheckCircleIcon, "text-success"], failed: ["Failed", XIcon, "text-danger"], running: ["Running", CircleNotchIcon, "text-accent"],
    waiting: ["Waiting for you", ClockIcon, "text-accent"], cancelled: ["Cancelled", XIcon, "text-muted"], interrupted: ["Interrupted", WarningIcon, "text-muted"],
  };
  const [label, icon, cls] = m[status] ?? [status, InfoIcon, "text-muted"];
  return <span className={cx("inline-flex flex-none items-center gap-1 text-xs font-semibold", cls)}><Icon icon={icon} size={14} swap={false} />{label}</span>;
}

const Tag = ({ children }: { children: React.ReactNode }) => <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[0.6875rem] font-semibold text-muted ring-1 ring-line">{children}</span>;
const Spinner = () => <Icon icon={CircleNotchIcon} size={16} swap={false} className="animate-spin motion-reduce:animate-none" />;
