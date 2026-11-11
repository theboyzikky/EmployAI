"use client";

import Link from "next/link";
import { useState } from "react";
import type { PlatformView } from "@/lib/platform/view";
import { callPlatform, statusPill } from "./platform-api";

const SKILL_STATUS: Record<string, string> = { operational: "Operational", preview: "Demo data", planned: "Planned" };
const PROVIDER_STATUS: Record<string, string> = { connected: "Connected", available: "Available", planned: "Planned" };

export function WorkforceWorkspace({ initial }: { initial: PlatformView }) {
  const [view, setView] = useState(initial);
  const [request, setRequest] = useState(initial.workforce?.request ?? "");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState("");
  const base = `/api/w/${view.businessId}`;
  const wf = view.workforce;

  async function act(label: string, path: string, body: unknown) {
    setBusy(label); setError(null);
    const r = await callPlatform(path, "POST", body);
    if (r.view) setView(r.view);
    if (!r.ok) setError(r.message);
    setBusy(null);
    return r.ok;
  }
  async function connectInstagram() {
    setBusy("connect"); setError(null);
    const r = await callPlatform(`${base}/connections`, "POST", { connector: "instagram", label: "Instagram", setup: { access_token: token } });
    setToken("");                                   // never kept in the page
    if (!r.ok) setError(r.message);
    const v = await callPlatform(`${base}/workforce`, "GET");
    if (v.ok && v.view) setView(v.view);
    setBusy(null);
  }
  const igConnected = view.connections.some(c => c.connector === "instagram" && c.status === "active");
  const needsPublishing = view.integrations.some(i => i.capability === "social.publish");

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

      {wf && view.integrations.length > 0 && (
        <section className="card px-5 py-5">
          <h2 className="text-base font-semibold text-ink">Integrations this workforce needs</h2>
          <p className="mt-1 text-sm text-muted">Connected = live in your workspace · Available = a real connector exists · Planned = not built yet (never shown as working).</p>
          <ul className="mt-4 space-y-4">
            {view.integrations.map(i => (
              <li key={i.capability}>
                <p className="text-sm font-semibold text-ink">{i.label} <span className="font-normal text-muted">· for {i.neededBy.join(", ")}</span></p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {i.providers.map(p => <span key={p.connector} className={statusPill(p.status)}>{p.name}: {PROVIDER_STATUS[p.status]}{p.account ? ` (@${p.account})` : ""}</span>)}
                </div>
              </li>
            ))}
          </ul>
          {needsPublishing && !igConnected && (
            <div className="mt-5 rounded-xl border border-line p-4">
              <p className="text-sm font-semibold text-ink">Connect Instagram</p>
              <p className="mt-1 text-sm text-muted">Paste the access token from the Meta App Dashboard (Instagram → API setup with Instagram login). It is checked with Instagram, stored encrypted, and never shown again.</p>
              {wf.status !== "approved" && <p className="notice mt-2">Approve the workforce first, so the publishing employee receives permission.</p>}
              <input className="field mt-3" type="password" autoComplete="off" value={token} onChange={e => setToken(e.target.value)} placeholder="Instagram access token" aria-label="Instagram access token" />
              <button type="button" className="btn btn-primary btn-sm mt-3" disabled={!!busy || token.length < 20 || wf.status !== "approved"} onClick={connectInstagram}>{busy === "connect" ? "Checking with Instagram…" : "Connect Instagram"}</button>
            </div>
          )}
          {igConnected && <p className="notice mt-4">Instagram is connected. Next: add products and plan content in <Link className="font-semibold text-accent" href={`/w/${view.businessId}/content`}>Content</Link>.</p>}
        </section>
      )}
    </div>
  );
}
