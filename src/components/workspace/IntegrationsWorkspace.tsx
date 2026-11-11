"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { HubProvider, HubStatus, HubView, Permission } from "@/lib/platform/view";
import { callPlatform } from "./platform-api";

const LABEL: Record<HubStatus, string> = {
  connected: "Connected", not_connected: "Not connected", expired: "Connection expired", reauth_required: "Reconnection required",
  disabled: "Paused", not_implemented: "Available but not yet implemented", unsupported: "Unsupported",
};
const PILL: Record<HubStatus, string> = {
  connected: "pill pill-ok", not_connected: "pill pill-accent", expired: "pill pill-warn", reauth_required: "pill pill-warn", disabled: "pill pill-warn", not_implemented: "pill", unsupported: "pill",
};
const CATEGORY: Record<string, string> = { social: "Social media", email: "Email", messaging: "Messaging", business: "Business tools" };
const OAUTH_MSG: Record<string, string> = {
  connected: "connected. Your AI employees that need it can use it now — nothing to repeat.",
  denied: "wasn't connected: the permission request was declined.",
  insufficient: "was connected without every permission EmployAI asked for, so it needs reconnecting with all of them allowed.",
  error: "couldn't be connected. Try again; if it keeps failing, check the developer setup.",
};

export function IntegrationsWorkspace({ initial, focus, returnTo, oauth }: { initial: HubView; focus: string | null; returnTo: string | null; oauth: { outcome: string; provider: string } | null }) {
  const [view, setView] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tokenFor, setTokenFor] = useState<string | null>(focus);
  const [token, setToken] = useState("");
  const [reveal, setReveal] = useState<Record<string, string> | null>(null);
  const base = `/api/w/${view.businessId}/integrations`;
  const back = returnTo && returnTo.startsWith(`/w/${view.businessId}/`) ? returnTo : null;

  useEffect(() => { if (focus) document.getElementById(`provider-${focus}`)?.scrollIntoView({ behavior: "smooth", block: "center" }); }, [focus]);

  async function post(label: string, body: Record<string, unknown>) {
    setBusy(label); setError(null);
    const r = await callPlatform(base, "POST", body);
    const v = (r.ok ? r.data.view : (r as { view?: unknown }).view) as HubView | undefined;
    if (v) setView(v);
    if (!r.ok) setError(r.message);
    setBusy(null);
    return r;
  }
  async function oauthConnect(p: HubProvider, connectionId: string | null) {
    const r = await post(`oauth-${p.key}`, { action: "connect_oauth", provider: p.key, connection_id: connectionId ?? p.reuseId, return_to: back ?? `/w/${view.businessId}/integrations` });
    if (r.ok && typeof r.data.redirect === "string") window.location.assign(r.data.redirect);
  }
  async function tokenConnect(p: HubProvider, connectionId: string | null) {
    const t = token; setToken("");                                   // the token never stays in the page
    const r = await post(`token-${p.key}`, { action: "connect_token", provider: p.key, token: t, connection_id: connectionId ?? p.reuseId });
    if (r.ok) setTokenFor(null);
  }
  async function togglePermission(connId: string, employeeId: string, current: Permission[], perm: Permission, on: boolean) {
    await post(`perm-${connId}-${employeeId}`, { action: "permissions", connection_id: connId, employee_id: employeeId, permissions: on ? [...current, perm] : current.filter(x => x !== perm) });
  }

  const missing = view.readiness?.missing ?? [];
  const attention = [...(view.readiness?.reconnect ?? []), ...(view.readiness?.needsPermission ?? [])];

  return (
    <div className="space-y-8">
      <section className="card px-5 py-5">
        <h1 className="text-xl font-semibold text-ink">Integrations</h1>
        <p className="mt-1 text-sm font-light text-muted">Connect each account once. Your AI employees use only the accounts and permissions you allow, and approvals for posts, messages and payments still apply. EmployAI never asks for your passwords.</p>
        {oauth && <p className="notice mt-3" role="status">{view.providers.find(p => p.key === oauth.provider)?.name ?? "The account"} {OAUTH_MSG[oauth.outcome] ?? OAUTH_MSG.error}</p>}
        {back && <p className="mt-3 text-sm"><Link className="font-semibold text-accent" href={back}>← Back to your workforce setup</Link></p>}
        {error && <p className="notice mt-3" role="alert">{error}</p>}
        {reveal && (
          <div className="notice mt-3">
            <p className="font-semibold text-ink">Copy these now — they are shown only once.</p>
            {Object.entries(reveal).map(([k, v]) => <p key={k} className="mt-1 break-all font-mono text-xs">{k}: {v}</p>)}
            <button type="button" className="btn btn-secondary btn-sm mt-2" onClick={() => setReveal(null)}>I&apos;ve copied them</button>
          </div>
        )}
      </section>

      {(missing.length > 0 || attention.length > 0) && (
        <section className="card px-5 py-5">
          <h2 className="text-base font-semibold text-ink">Needed by your workforce</h2>
          <ul className="mt-3 space-y-3">
            {missing.map(m => (
              <li key={m.capability} className="text-sm">
                <p className="font-semibold text-ink">{m.label}</p>
                <p className="text-muted">{m.why} Connect one of: {m.providers.map((p, i) => <span key={p.key}>{i > 0 && ", "}<a className="font-semibold text-accent" href={`#provider-${p.key}`} onClick={() => setTokenFor(p.key)}>{p.name}</a></span>)}</p>
              </li>
            ))}
            {attention.map(a => (
              <li key={`${a.employeeId}-${a.skill}`} className="text-sm">
                <p className="font-semibold text-ink">{a.skillLabel} · {a.employee}</p>
                <p className="text-muted">{"problem" in a ? `${a.provider.name} needs reconnecting.` : `${a.employee} doesn't have permission on ${a.provider.name} yet — tick it below.`}</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {(["social", "email", "messaging", "business"] as const).map(cat => (
        <section key={cat} className="space-y-3">
          <h2 className="text-base font-semibold text-ink">{CATEGORY[cat]}</h2>
          <ul className="grid-2">
            {view.providers.filter(p => p.category === cat).map(p => (
              <li key={p.key} id={`provider-${p.key}`} className={`card p-5 ${focus === p.key ? "ring-2 ring-accent" : ""}`}>
                <div className="row-between">
                  <h3 className="text-base font-semibold text-ink">{p.name}</h3>
                  <span className={PILL[p.status]}>{LABEL[p.status]}</span>
                </div>
                {p.capabilities.length > 0 && <p className="mt-1 text-xs text-muted">{p.capabilities.map((c, i) => <span key={c.label}>{i > 0 && " · "}{c.label}{p.support === "implemented" && !c.working ? " (not yet)" : ""}</span>)}</p>}
                <details className="mt-2 text-sm" open={p.support === "implemented" && p.connections.length === 0 && p.setupMissing.length > 0}>
                  <summary className="cursor-pointer font-medium text-ink">Setup requirements</summary>
                  <p className="mt-1 text-muted">{p.setup}</p>
                </details>

                {p.connections.map(c => (
                  <div key={c.id} className="mt-3 rounded-xl border border-line p-3">
                    <div className="row-between">
                      <p className="text-sm font-semibold text-ink">{c.account ?? p.name}</p>
                      <span className={PILL[c.status]}>{LABEL[c.status]}</span>
                    </div>
                    {c.expiresAt && <p className="mt-1 text-xs text-muted">Access token expires {new Date(c.expiresAt).toLocaleString()}{c.method === "oauth" ? " (renewed automatically when possible)" : ""}</p>}
                    {c.problem && <p className="mt-1 text-sm text-danger">{c.problem}</p>}
                    {c.note && <p className="mt-1 text-xs text-muted">{c.note}</p>}
                    <div className="mt-2 flex flex-wrap gap-2">
                      <button type="button" className="btn btn-secondary btn-sm" disabled={!!busy} onClick={() => post(`check-${c.id}`, { action: "check", connection_id: c.id })}>{busy === `check-${c.id}` ? "Checking…" : "Check"}</button>
                      {(c.status === "reauth_required" || c.status === "expired") && (p.canOAuth && !p.setupMissing.length
                        ? <button type="button" className="btn btn-primary btn-sm" disabled={!!busy} onClick={() => oauthConnect(p, c.id)}>Reconnect</button>
                        : p.canToken && <button type="button" className="btn btn-primary btn-sm" onClick={() => setTokenFor(p.key)}>Reconnect with a new token</button>)}
                      <button type="button" className="btn btn-secondary btn-sm" disabled={!!busy} onClick={() => { if (window.confirm(`Disconnect ${p.name}? EmployAI deletes the stored access and every employee permission on it.`)) void post(`disc-${c.id}`, { action: "disconnect", connection_id: c.id }); }}>Disconnect</button>
                    </div>
                    {view.employees.length > 0 && c.permissions.length > 0 && (
                      <div className="mt-3 overflow-x-auto">
                        <table className="w-full text-left text-xs">
                          <thead><tr><th className="py-1 pr-2 font-semibold text-ink">Employee</th>{c.permissions.map(x => <th key={x.permission} className="py-1 pr-2 font-semibold text-ink" title={x.description}>{x.label}</th>)}</tr></thead>
                          <tbody>
                            {view.employees.map(e => {
                              const held = c.grants[e.id] ?? [];
                              return (
                                <tr key={e.id} className="border-t border-line">
                                  <td className="py-1 pr-2 text-ink">{e.name}</td>
                                  {c.permissions.map(x => (
                                    <td key={x.permission} className="py-1 pr-2">
                                      <input type="checkbox" aria-label={`${e.name}: ${x.label} on ${p.name}`} checked={held.includes(x.permission)} disabled={!!busy || c.status === "not_connected"} onChange={ev => togglePermission(c.id, e.id, held, x.permission, ev.target.checked)} />
                                    </td>
                                  ))}
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                ))}

                {p.support === "implemented" && (p.connections.length === 0 || tokenFor === p.key) && (
                  <div className="mt-3 stack-sm">
                    {p.canOAuth && p.connections.length === 0 && (p.setupMissing.length
                      ? <p className="text-sm text-muted">One-click connect needs developer setup on this server: <code>{p.setupMissing.join(", ")}</code>.</p>
                      : <button type="button" className="btn btn-primary btn-sm" disabled={!!busy} onClick={() => oauthConnect(p, null)}>{busy === `oauth-${p.key}` ? "Opening…" : `Connect with ${p.name}`}</button>)}
                    {p.canToken && (tokenFor === p.key ? (
                      <div className="stack-sm">
                        <input className="field" type="password" autoComplete="off" value={token} onChange={e => setToken(e.target.value)} placeholder={p.key === "telegram" ? "Bot token from @BotFather" : `${p.name} access token`} aria-label={`${p.name} token`} />
                        <button type="button" className="btn btn-primary btn-sm" disabled={!!busy || token.length < 10} onClick={() => tokenConnect(p, p.connections.find(c => c.status !== "connected")?.id ?? null)}>{busy === `token-${p.key}` ? "Checking with the provider…" : "Connect"}</button>
                        <p className="text-xs text-muted">Checked with {p.name}, stored encrypted, never shown again.</p>
                      </div>
                    ) : <button type="button" className="btn btn-secondary btn-sm" onClick={() => setTokenFor(p.key)}>{p.canOAuth ? "Use a token instead" : "Connect with a token"}</button>)}
                    {p.canWebhook && p.connections.length === 0 && (
                      <button type="button" className="btn btn-primary btn-sm" disabled={!!busy} onClick={async () => { const r = await post("webhook", { action: "connect_webhook", label: "Business system" }); if (r.ok) setReveal({ ...(r.data.reveal_once as Record<string, string>), webhook_path: String(r.data.webhook_path ?? "") }); }}>Create a signed webhook</button>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
