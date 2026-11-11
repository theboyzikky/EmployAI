"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  CalendarBlankIcon, ChatsCircleIcon, EnvelopeIcon, FacebookLogoIcon, GoogleDriveLogoIcon, GoogleLogoIcon, Icon, InstagramLogoIcon,
  LinkedinLogoIcon, MicrosoftOutlookLogoIcon, TelegramLogoIcon, TiktokLogoIcon, WebhooksLogoIcon, WhatsappLogoIcon, XLogoIcon, YoutubeLogoIcon,
} from "@/components/icons";
import type { HubProvider, HubStatus, HubView, Permission } from "@/lib/platform/view";
import { callPlatform } from "./platform-api";

const ICONS: Record<string, typeof InstagramLogoIcon> = {
  instagram: InstagramLogoIcon, facebook: FacebookLogoIcon, tiktok: TiktokLogoIcon, linkedin: LinkedinLogoIcon, x: XLogoIcon, youtube: YoutubeLogoIcon,
  gmail: GoogleLogoIcon, outlook: MicrosoftOutlookLogoIcon, imap_smtp: EnvelopeIcon,
  whatsapp_business: WhatsappLogoIcon, whatsapp_personal: WhatsappLogoIcon, telegram: TelegramLogoIcon, webchat: ChatsCircleIcon,
  webhook: WebhooksLogoIcon, google_calendar: CalendarBlankIcon, google_drive: GoogleDriveLogoIcon,
};
/** Each provider's logo colour class (globals.css → .brand-*). */
const BRAND: Record<string, string> = {
  instagram: "brand-instagram", facebook: "brand-facebook", tiktok: "brand-tiktok", linkedin: "brand-linkedin", x: "brand-x", youtube: "brand-youtube",
  gmail: "brand-google", outlook: "brand-outlook", whatsapp_business: "brand-whatsapp", whatsapp_personal: "brand-whatsapp", telegram: "brand-telegram",
  google_calendar: "brand-calendar", google_drive: "brand-drive",
};
/** Gradients the Instagram and Google marks use (referenced from CSS by id). */
function BrandGradients() {
  return (
    <svg width="0" height="0" aria-hidden="true" focusable="false" style={{ position: "absolute" }}>
      <defs>
        <linearGradient id="eai-brand-instagram" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="#feda75" /><stop offset="0.3" stopColor="#fa7e1e" /><stop offset="0.55" stopColor="#d62976" /><stop offset="0.8" stopColor="#962fbf" /><stop offset="1" stopColor="#4f5bd5" />
        </linearGradient>
        <linearGradient id="eai-brand-google" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ea4335" /><stop offset="0.32" stopColor="#ea4335" /><stop offset="0.33" stopColor="#fbbc05" /><stop offset="0.5" stopColor="#fbbc05" />
          <stop offset="0.51" stopColor="#34a853" /><stop offset="0.7" stopColor="#34a853" /><stop offset="0.71" stopColor="#4285f4" /><stop offset="1" stopColor="#4285f4" />
        </linearGradient>
      </defs>
    </svg>
  );
}

const LABEL: Record<HubStatus, string> = {
  connected: "Connected", reauth_required: "Reconnection required", ready_to_connect: "Ready to connect", setup_required: "Developer setup required",
  not_connected: "Not connected", disabled: "Paused", not_implemented: "Available but not implemented", unsupported: "Unsupported",
};
const SECTION: Record<string, string> = { social: "Connect your social accounts", email: "Connect your email", messaging: "Connect your messaging", business: "Connect your business tools" };
const OAUTH_MSG: Record<string, string> = {
  connected: "is connected. Give your employees access below, or go back to your workforce setup to continue.",
  denied: "wasn't connected: the permission request was declined on its website. Nothing was stored.",
  insufficient: "was connected without every permission EmployAI asked for, so it needs reconnecting with all of them allowed.",
  error: "couldn't be connected. The reason is shown on its row below.",
};

/** The pill on the right of a row: what the owner can do, never more than is true. */
function pillFor(p: HubProvider): { label: string; cls: string } {
  switch (p.status) {
    case "connected": return { label: "Connected", cls: "conn-pill conn-pill-on" };
    case "reauth_required": return { label: "Reconnect", cls: "conn-pill conn-pill-warn" };
    case "disabled": return { label: "Paused", cls: "conn-pill conn-pill-warn" };
    case "ready_to_connect": case "not_connected": return { label: "Connect", cls: "conn-pill conn-pill-go" };
    case "setup_required": return { label: "Setup required", cls: "conn-pill conn-pill-soon" };
    case "unsupported": return { label: "Unsupported", cls: "conn-pill conn-pill-soon" };
    default: return { label: "Not available", cls: "conn-pill conn-pill-soon" };
  }
}
const yes = (v: boolean | null, t: string, f: string) => v === null ? null : <li className={v ? "text-ink" : "text-muted"}>{v ? "✓" : "–"} {v ? t : f}</li>;

export function IntegrationsWorkspace({ initial, focus, returnTo, oauth }: { initial: HubView; focus: string | null; returnTo: string | null; oauth: { outcome: string; provider: string } | null }) {
  const [view, setView] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(focus);
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
  /** Leave EmployAI for the provider's own sign-in and consent page; it sends the owner back here. */
  async function oauthConnect(p: HubProvider, connectionId: string | null) {
    const r = await post(`oauth-${p.key}`, { action: "connect_oauth", provider: p.key, connection_id: connectionId ?? p.reuseId, return_to: back ?? `/w/${view.businessId}/integrations` });
    if (r.ok && typeof r.data.redirect === "string") window.location.assign(r.data.redirect);
  }
  async function tokenConnect(p: HubProvider, connectionId: string | null) {
    const t = token; setToken("");                                   // the token never stays in the page
    await post(`token-${p.key}`, { action: "connect_token", provider: p.key, token: t, connection_id: connectionId ?? p.reuseId });
  }
  async function togglePermission(connId: string, employeeId: string, current: Permission[], perm: Permission, on: boolean) {
    await post(`perm-${connId}-${employeeId}`, { action: "permissions", connection_id: connId, employee_id: employeeId, permissions: on ? [...current, perm] : current.filter(x => x !== perm) });
  }
  function onPill(p: HubProvider) {
    const broken = p.connections.find(c => c.status === "reauth_required");
    if (p.status === "ready_to_connect") return void oauthConnect(p, null);
    if (broken && p.oauthReady) return void oauthConnect(p, broken.id);
    setOpen(open === p.key ? null : p.key);
  }

  const missing = view.readiness?.missing ?? [];
  const reconnect = view.readiness?.reconnect ?? [];
  const needsPermission = view.readiness?.needsPermission ?? [];

  return (
    <div className="space-y-6">
      <BrandGradients />
      <section>
        <h1 className="text-xl font-semibold text-ink">Integrations</h1>
        <p className="mt-1 text-sm font-light text-muted">Click Connect, sign in on the platform&apos;s own website, approve what EmployAI asks for, and you&apos;re brought back here. EmployAI never sees or asks for your passwords. Connecting an account gives no employee access until you allow it.</p>
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

      {(missing.length > 0 || reconnect.length > 0 || needsPermission.length > 0) && (
        <section className="conn-card">
          <h2 className="text-base font-semibold text-ink">Needed by your workforce</h2>
          <ul className="mt-2 space-y-2">
            {missing.map(m => (
              <li key={m.capability} className="text-sm text-muted">
                <span className="font-semibold text-ink">{m.label}.</span> {m.why} Connect {m.providers.map((p, i) => <span key={p.key}>{i > 0 && " or "}<a className="font-semibold text-accent" href={`#provider-${p.key}`} onClick={() => setOpen(p.key)}>{p.name}</a></span>)}.
              </li>
            ))}
            {reconnect.map(a => (
              <li key={`r-${a.employeeId}-${a.skill}`} className="text-sm text-muted"><span className="font-semibold text-ink">{a.skillLabel} · {a.employee}.</span> {a.provider.name} needs reconnecting.</li>
            ))}
            {needsPermission.map(a => (
              <li key={`p-${a.employeeId}-${a.skill}`} className="flex flex-wrap items-center gap-2 text-sm text-muted">
                <span><span className="font-semibold text-ink">{a.skillLabel} · {a.employee}.</span> {a.provider.name}{a.account ? ` (${a.account})` : ""} is connected; {a.employee} needs “{a.permissionLabel}”.</span>
                <button type="button" className="conn-pill conn-pill-go" disabled={!!busy} onClick={() => post(`grant-${a.employeeId}`, { action: "grant", connection_id: a.connectionId, employee_id: a.employeeId, permission: a.permission })}>Allow</button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {(["social", "email", "messaging", "business"] as const).map(cat => (
        <section key={cat} className="conn-card">
          <h2 className="text-lg font-semibold text-ink">{SECTION[cat]}</h2>
          <ul className="mt-1">
            {view.providers.filter(p => p.category === cat).map(p => {
              const pill = pillFor(p);
              const isOpen = open === p.key;
              const account = p.connections.find(c => c.status === "connected")?.account;
              const sub = account ?? (p.lastFailure ? "Last attempt didn't complete" : p.status === "setup_required" || p.status === "reauth_required" ? LABEL[p.status] : null);
              const ck = p.checklist;
              return (
                <li key={p.key} id={`provider-${p.key}`} className="conn-item">
                  <div className="conn-row">
                    <button type="button" className="conn-name text-left" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : p.key)}>
                      <Icon icon={ICONS[p.key] ?? ChatsCircleIcon} size={24} className={`brand-logo ${BRAND[p.key] ?? "brand-generic"}`} />
                      <span className="min-w-0">{p.name}{sub && <span className="conn-sub">{sub}</span>}</span>
                    </button>
                    <button type="button" className={pill.cls} disabled={!!busy && busy.endsWith(p.key)} title={LABEL[p.status]} onClick={() => onPill(p)}>
                      {busy === `oauth-${p.key}` ? "Opening…" : pill.label}
                    </button>
                  </div>

                  {isOpen && (
                    <div className="conn-detail stack-sm">
                      {!sub && <p className="text-xs font-semibold text-ink">{LABEL[p.status]}</p>}
                      {p.lastFailure && <p className="text-sm text-danger">Last attempt ({new Date(p.lastFailure.at).toLocaleString()}): {p.lastFailure.reason}</p>}
                      {p.support === "implemented" && (
                        <ul className="space-y-0.5 text-xs">
                          {yes(ck.oauthImplemented, "Sign-in on the platform's own website (OAuth) is built", "")}
                          {yes(ck.credentialsConfigured, "Developer app credentials are configured on this server", "Developer app credentials aren't configured on this server yet")}
                          {yes(ck.accountConnected, "An account is connected", "No account is connected")}
                          <li className="text-muted">Reads: {ck.dataAccess.length ? ck.dataAccess.join("; ") : "nothing"}</li>
                          <li className={ck.actions.length ? "text-ink" : "text-muted"}>Actions: {ck.actions.length ? ck.actions.join(", ") : "none built yet (connect only)"}</li>
                          {ck.actions.length > 0 && <li className="text-muted">{ck.backgroundAutomation ? "Runs in the background with approvals, scheduling and safe retries" : "Not automated"}</li>}
                        </ul>
                      )}
                      <p className="text-sm text-muted">{p.setup}</p>
                      {p.canOAuth && p.setupMissing.length > 0 && (
                        <div className="notice text-xs">
                          <p className="font-semibold text-ink">Not ready to connect yet: developer setup required</p>
                          <p className="mt-1">Whoever runs EmployAI registers one {p.name} developer app, then sets <code>{p.setupMissing.join(", ")}</code> on the server. Business owners never do this.</p>
                          <p className="mt-1">Callback URL to register: <code className="break-all">{p.callbackUrl ?? `https://<your EmployAI address>${p.callbackPath}`}</code></p>
                        </div>
                      )}

                      {p.connections.map(c => (
                        <div key={c.id} className="rounded-xl border border-line p-3">
                          <div className="row-between">
                            <p className="text-sm font-semibold text-ink">{c.account ?? p.name}</p>
                            <span className={c.status === "connected" ? "pill pill-ok" : "pill pill-warn"}>{c.expired && c.status === "reauth_required" ? "Expired: reconnect" : LABEL[c.status]}</span>
                          </div>
                          {c.expiresAt && <p className="mt-1 text-xs text-muted">Access expires {new Date(c.expiresAt).toLocaleString()}{c.method === "oauth" ? " (renewed automatically when the platform allows)" : ""}</p>}
                          {c.problem && <p className="mt-1 text-sm text-danger">{c.problem}</p>}
                          {c.note && <p className="mt-1 text-xs text-muted">{c.note}</p>}
                          <div className="mt-2 flex flex-wrap gap-2">
                            {c.status === "reauth_required" && p.oauthReady && <button type="button" className="btn btn-primary btn-sm" disabled={!!busy} onClick={() => oauthConnect(p, c.id)}>Reconnect on {p.name}</button>}
                            <button type="button" className="btn btn-secondary btn-sm" disabled={!!busy} onClick={() => post(`check-${c.id}`, { action: "check", connection_id: c.id })}>{busy === `check-${c.id}` ? "Checking…" : "Check"}</button>
                            <button type="button" className="btn btn-secondary btn-sm" disabled={!!busy} onClick={() => { if (window.confirm(`Disconnect ${p.name}? EmployAI deletes the stored access and every employee permission on it.`)) void post(`disc-${c.id}`, { action: "disconnect", connection_id: c.id }); }}>Disconnect</button>
                          </div>
                          {view.employees.length > 0 && c.permissions.length > 0 && (
                            <div className="mt-3 overflow-x-auto">
                              <p className="text-xs font-semibold text-ink">Which employees may use it (nobody until you tick it)</p>
                              <table className="mt-1 w-full text-left text-xs">
                                <thead><tr><th className="py-1 pr-2 font-semibold text-muted">Employee</th>{c.permissions.map(x => <th key={x.permission} className="py-1 pr-2 font-semibold text-muted" title={x.description}>{x.label}</th>)}</tr></thead>
                                <tbody>
                                  {view.employees.map(e => {
                                    const held = c.grants[e.id] ?? [];
                                    return (
                                      <tr key={e.id} className="border-t border-line">
                                        <td className="py-1 pr-2 text-ink">{e.name}</td>
                                        {c.permissions.map(x => (
                                          <td key={x.permission} className="py-1 pr-2">
                                            <input type="checkbox" aria-label={`${e.name}: ${x.label} on ${p.name}`} checked={held.includes(x.permission)} disabled={!!busy} onChange={ev => togglePermission(c.id, e.id, held, x.permission, ev.target.checked)} />
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

                      {p.support === "implemented" && (
                        <>
                          {p.oauthReady && <button type="button" className="btn btn-primary btn-sm" disabled={!!busy} onClick={() => oauthConnect(p, null)}>{p.connections.length ? `Connect another ${p.name} account` : `Connect on ${p.name}`}</button>}
                          {p.canToken && (
                            <div className="stack-sm">
                              <input className="field" type="password" autoComplete="off" value={token} onChange={e => setToken(e.target.value)} placeholder="Bot token from @BotFather" aria-label={`${p.name} bot token`} />
                              <button type="button" className="btn btn-primary btn-sm" disabled={!!busy || token.length < 10} onClick={() => tokenConnect(p, p.connections.find(c => c.status !== "connected")?.id ?? null)}>{busy === `token-${p.key}` ? "Checking with the provider…" : p.connections.length ? "Reconnect with this token" : "Connect bot"}</button>
                              <p className="text-xs text-muted">Telegram bots have no OAuth: the bot token is how Telegram connects a bot. Checked with Telegram, stored encrypted, never shown again.</p>
                            </div>
                          )}
                          {p.developerToken && (
                            <details className="text-xs">
                              <summary className="cursor-pointer text-muted">Developer testing only: connect with a token from the {p.name} developer console</summary>
                              <div className="mt-2 stack-sm">
                                <input className="field" type="password" autoComplete="off" value={token} onChange={e => setToken(e.target.value)} placeholder={`${p.name} access token (not a password)`} aria-label={`${p.name} developer token`} />
                                <button type="button" className="btn btn-secondary btn-sm" disabled={!!busy || token.length < 10} onClick={() => tokenConnect(p, p.connections.find(c => c.status !== "connected")?.id ?? null)}>Connect with developer token</button>
                              </div>
                            </details>
                          )}
                          {p.canWebhook && p.connections.length === 0 && (
                            <button type="button" className="btn btn-primary btn-sm" disabled={!!busy} onClick={async () => { const r = await post("webhook", { action: "connect_webhook", label: "Business system" }); if (r.ok) setReveal({ ...(r.data.reveal_once as Record<string, string>), webhook_path: String(r.data.webhook_path ?? "") }); }}>Create a signed webhook</button>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
