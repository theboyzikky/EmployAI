"use client";

import Link from "next/link";
import { useState } from "react";
import type { PlatformView } from "@/lib/platform/view";
import { callPlatform, statusPill } from "./platform-api";

const SKILL_STATUS: Record<string, string> = { operational: "Operational", preview: "Demo data", planned: "Planned" };

const RETURN_MSG: Record<string, string> = {
  connected: "is connected. Your setup continues below. Allow the employees that need it, and EmployAI takes it from there.",
  denied: "wasn't connected: the permission request was declined on its website. Nothing was stored.",
  insufficient: "was connected without every permission EmployAI asked for. Reconnect it and allow all of them.",
  error: "couldn't be connected. Open Integrations to see why.",
};

export function WorkforceWorkspace({ initial, oauth }: { initial: PlatformView; oauth?: { outcome: string; provider: string } | null }) {
  const [view, setView] = useState(initial);
  const [request, setRequest] = useState(initial.workforce?.request ?? "");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const base = `/api/w/${view.businessId}`;
  const wf = view.workforce;
  const rd = view.readiness;
  // Connecting returns here, to this page, so the owner never repeats the request.
  const connectHref = (provider: string) => `/w/${view.businessId}/integrations?connect=${provider}&return=${encodeURIComponent(`/w/${view.businessId}/workforce`)}`;
  /** Connect: straight to the platform's own sign-in and consent page, returning here to continue the setup. */
  async function connect(provider: string, connectionId: string | null = null) {
    if (view.connectModes[provider] !== "oauth") { window.location.assign(connectHref(provider)); return; }
    setBusy(`connect-${provider}`); setError(null);
    const r = await callPlatform(`${base}/integrations`, "POST", { action: "connect_oauth", provider, connection_id: connectionId, return_to: `/w/${view.businessId}/workforce` });
    if (r.ok && typeof r.data.redirect === "string") { window.location.assign(r.data.redirect); return; }
    if (!r.ok) setError(r.message);
    setBusy(null);
  }
  /** The owner explicitly allows one employee one permission on a connected account. */
  async function allow(connectionId: string, employeeId: string, permission: string) {
    setBusy(`allow-${employeeId}`); setError(null);
    const r = await callPlatform(`${base}/integrations`, "POST", { action: "grant", connection_id: connectionId, employee_id: employeeId, permission });
    if (!r.ok) setError(r.message);
    const v = await callPlatform(`${base}/workforce`, "GET");
    if (v.ok && v.view) setView(v.view);
    setBusy(null);
  }

  async function act(label: string, path: string, body: unknown) {
    setBusy(label); setError(null);
    const r = await callPlatform(path, "POST", body);
    if (r.view) setView(r.view);
    if (!r.ok) setError(r.message);
    setBusy(null);
    return r.ok;
  }

  return (
    <div className="space-y-8">
      <section className="card px-5 py-5">
        <div className="row-between">
          <div>
            <h1 className="text-xl font-semibold text-ink">Your AI workforce</h1>
            <p className="mt-1 text-sm font-light text-muted">Describe the work you want taken off your hands. EmployAI proposes employees built from real skills; you approve them before they act.</p>
          </div>
          <span className={view.ai.live ? "pill pill-ok" : "pill"} title="Which AI writes the plan">{view.ai.live ? "NEAR AI (live)" : view.ai.label}</span>
        </div>
        <label className="field-label mt-4" htmlFor="wf-request">What should EmployAI handle?</label>
        <textarea id="wf-request" className="field" maxLength={1000} value={request} onChange={e => setRequest(e.target.value)}
          placeholder="e.g. I sell dresses. I want my Instagram updated consistently to attract customers — handle content creation and publishing." />
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" className="btn btn-primary btn-sm" disabled={!!busy || request.trim().length < 5} onClick={() => act("plan", `${base}/workforce`, { action: "plan", request })}>
            {busy === "plan" ? "Planning…" : wf ? "Re-plan workforce" : "Plan my AI workforce"}
          </button>
          {wf && wf.status !== "approved" && <button type="button" className="btn btn-secondary btn-sm" disabled={!!busy} onClick={() => act("approve", `${base}/workforce`, { action: "approve" })}>{busy === "approve" ? "Approving…" : "Approve workforce"}</button>}
        </div>
        {oauth && <p className="notice mt-3" role="status">{oauth.provider.replace(/_/g, " ").replace(/^./, c => c.toUpperCase())} {RETURN_MSG[oauth.outcome] ?? RETURN_MSG.error}</p>}
        {error && <p className="notice mt-3" role="alert">{error}</p>}
      </section>

      {wf && (
        <section className="space-y-4">
          <div className="card px-5 py-4">
            <div className="row-between">
              <h2 className="text-base font-semibold text-ink">{wf.status === "approved" ? "Approved workforce" : "Proposed workforce"}</h2>
              <span className={wf.planned_by.mode === "live" ? "pill pill-ok" : "pill"}>{wf.planned_by.mode === "live" ? `Planned by NEAR AI · ${wf.planned_by.model}` : "Planned by offline rules (not AI)"}</span>
            </div>
            <p className="mt-2 text-sm text-ink">{wf.summary}</p>
            {wf.approvals.length > 0 && <p className="mt-2 text-sm text-muted"><span className="font-semibold text-ink">Needs your approval each time:</span> {wf.approvals.join(" · ")}</p>}
          </div>
          <ul className="grid-2">
            {wf.employees.map(e => (
              <li key={e.id} className="card p-5">
                <div className="row-between">
                  <div>
                    <h3 className="text-base font-semibold text-ink">{e.name}</h3>
                    {e.title !== e.name && <p className="text-sm font-medium text-muted">{e.title}</p>}
                  </div>
                  <span className={statusPill(e.status)}>{e.status === "active" ? "Active" : e.status === "paused" ? "Paused" : "Proposed"}</span>
                </div>
                <p className="mt-2 text-sm text-muted">{e.reason}</p>
                <ul className="mt-3 stack-sm">
                  {e.skills.map(s => (
                    <li key={s.id} className="flex flex-wrap items-center gap-2 text-sm text-ink">
                      {s.label}
                      <span className={statusPill(s.status)}>{SKILL_STATUS[s.status]}</span>
                      {s.autonomy === "approval" && <span className="pill">Owner approval</span>}
                    </li>
                  ))}
                </ul>
                {e.integrations.length > 0 && (
                  <p className="mt-3 text-sm text-muted"><span className="font-semibold text-ink">Needs:</span> {e.integrations.map(i => i.label).join(", ")}</p>
                )}
                <details className="mt-3 text-sm">
                  <summary className="cursor-pointer font-medium text-ink">Rules and escalation</summary>
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-muted">{[...e.restrictions, ...e.escalation.map(x => `Escalates: ${x}`)].map(x => <li key={x}>{x}</li>)}</ul>
                </details>
                {wf.status === "approved" && e.status !== "proposed" && (
                  <button type="button" className="btn btn-secondary btn-sm mt-3" disabled={!!busy} onClick={() => act(`emp-${e.id}`, `${base}/workforce`, { action: "employee", employee_id: e.id, status: e.status === "active" ? "paused" : "active" })}>
                    {e.status === "active" ? "Pause" : "Resume"}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {wf && rd && (
        <section id="readiness" className="card px-5 py-5">
          <h2 className="text-base font-semibold text-ink">What your workforce can do with your connected accounts</h2>
          <p className="mt-1 text-sm text-muted">EmployAI checked your real connections. It prepares what it can do now and asks only for what is missing.</p>
          {rd.ready.length > 0 && (
            <div className="mt-4">
              <p className="text-sm font-semibold text-ink">Ready now</p>
              <ul className="mt-2 stack-sm">{rd.ready.map(r => <li key={`${r.employeeId}-${r.skill}`} className="flex flex-wrap items-center gap-2 text-sm text-ink">{r.skillLabel} <span className="text-muted">· {r.employee}</span> <span className="pill pill-ok">{r.via}</span></li>)}</ul>
            </div>
          )}
          {rd.missing.length > 0 && (
            <div className="mt-4">
              <p className="text-sm font-semibold text-ink">Needs a connection</p>
              <ul className="mt-2 space-y-3">{rd.missing.map(m => (
                <li key={m.capability} className="text-sm">
                  <p className="text-ink">{m.label} <span className="text-muted">— {m.why}</span></p>
                  <div className="mt-1 flex flex-wrap gap-2">{m.providers.map(p => view.connectModes[p.key] === "setup_required"
                    ? <Link key={p.key} className="btn btn-secondary btn-sm" href={connectHref(p.key)} title="This server has no developer app for it yet">{p.name}: developer setup required</Link>
                    : <button key={p.key} type="button" className="btn btn-primary btn-sm" disabled={!!busy} onClick={() => connect(p.key)}>{busy === `connect-${p.key}` ? "Opening…" : `Connect ${p.name}`}</button>)}</div>
                </li>
              ))}</ul>
            </div>
          )}
          {(rd.needsPermission.length > 0 || rd.reconnect.length > 0) && (
            <div className="mt-4">
              <p className="text-sm font-semibold text-ink">Needs your attention</p>
              <ul className="mt-2 stack-sm">
                {rd.reconnect.map(r => <li key={`${r.employeeId}-${r.skill}`} className="text-sm text-ink">{r.skillLabel} · {r.employee}: {r.provider.name} needs reconnecting. <button type="button" className="font-semibold text-accent" disabled={!!busy} onClick={() => connect(r.provider.key, r.connectionId)}>Reconnect</button></li>)}
                {rd.needsPermission.map(r => <li key={`${r.employeeId}-${r.skill}`} className="text-sm text-ink">{r.skillLabel} · {r.provider.name}{r.account ? ` (${r.account})` : ""} is connected; {r.employee} needs “{r.permissionLabel}”. <button type="button" className="btn btn-primary btn-sm ml-1" disabled={!!busy} onClick={() => allow(r.connectionId, r.employeeId, r.permission)}>{busy === `allow-${r.employeeId}` ? "Allowing…" : "Allow"}</button></li>)}
              </ul>
            </div>
          )}
          {(rd.notYet.length > 0 || rd.demo.length > 0) && (
            <div className="mt-4">
              <p className="text-sm font-semibold text-ink">Not possible yet</p>
              <ul className="mt-2 stack-sm">
                {rd.notYet.map(r => <li key={`${r.employeeId}-${r.skill}`} className="text-sm text-muted">{r.skillLabel} · {r.employee}: {r.reason}</li>)}
                {rd.demo.map(r => <li key={`${r.employeeId}-${r.skill}`} className="text-sm text-muted">{r.skillLabel} · {r.employee}: runs on demo data only.</li>)}
              </ul>
            </div>
          )}
          {rd.ready.some(r => r.capability === "publish_social_post") && <p className="notice mt-4">Publishing is set up. Next: add products and plan content in <Link className="font-semibold text-accent" href={`/w/${view.businessId}/content`}>Content</Link>.</p>}
        </section>
      )}
    </div>
  );
}
