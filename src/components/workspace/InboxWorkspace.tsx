"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { InboxView } from "@/lib/messaging/view";
import { callPlatform } from "./platform-api";

const CHANNEL: Record<string, string> = { telegram: "Telegram", instagram: "Instagram", messenger: "Messenger", whatsapp: "WhatsApp", gmail: "Gmail", outlook: "Outlook", webhook: "Webhook" };
const MSG_STATUS: Record<string, string> = { received: "", pending_approval: "Waiting for your approval", approved: "Approved, sending…", sending: "Sending…", sent: "Sent", failed: "Not sent", discarded: "Discarded", needs_attention: "Delivery unconfirmed" };
const newKey = () => (crypto.randomUUID?.() ?? `${Date.now()}${Math.random()}`).replace(/[^A-Za-z0-9]/g, "").slice(0, 32);

export function InboxWorkspace({ initial }: { initial: InboxView }) {
  const [view, setView] = useState(initial);
  const [open, setOpen] = useState<string | null>(initial.conversations[0]?.id ?? null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [compose, setCompose] = useState("");
  const [knowledge, setKnowledge] = useState(initial.settings.knowledge);
  const base = `/api/w/${view.businessId}/inbox`;

  // New messages are handled by the background worker; the page only refreshes what it shows.
  useEffect(() => {
    const t = setInterval(async () => { if (document.visibilityState !== "visible") return; const r = await callPlatform(base, "GET"); const v = r.ok ? (r.data.view as InboxView | undefined) : undefined; if (v) setView(v); }, 15_000);
    return () => clearInterval(t);
  }, [base]);

  async function post(label: string, body: Record<string, unknown>) {
    setBusy(label); setError(null);
    const r = await callPlatform(base, "POST", body);
    const v = (r.ok ? r.data.view : (r as { view?: unknown }).view) as InboxView | undefined;
    if (v) setView(v);
    if (!r.ok) setError(r.message);
    setBusy(null);
    return r.ok;
  }

  const conv = view.conversations.find(c => c.id === open) ?? null;
  const missing = view.channels.filter(c => c.status === "not_connected");
  const connectHref = (key: string) => `/w/${view.businessId}/integrations?connect=${key}&return=${encodeURIComponent(`/w/${view.businessId}/inbox`)}`;

  return (
    <div className="space-y-6">
      <section>
        <h1 className="text-xl font-semibold text-ink">Inbox</h1>
        <p className="mt-1 text-sm font-light text-muted">Customer messages from every connected channel, handled by {view.supportEmployee?.name ?? "your support employee"} in the background, with or without this page open. Complaints and anything uncertain wait for you.</p>
        {error && <p className="notice mt-3" role="alert">{error}</p>}
      </section>

      <section className="conn-card">
        <h2 className="text-base font-semibold text-ink">Channels</h2>
        <ul className="mt-2 flex flex-wrap gap-2">
          {view.channels.map(c => (
            <li key={c.key}>
              {c.status === "connected"
                ? <span className={c.employeeCanAnswer ? "pill pill-ok" : "pill pill-warn"} title={c.employeeCanAnswer ? "Connected and answered" : "Connected, but no employee may read and reply yet"}>{c.name}{c.account ? ` · ${c.account}` : ""}{c.employeeCanAnswer ? "" : " · allow an employee"}</span>
                : c.status === "unavailable" ? <span className="pill">{c.name} · not available</span>
                : <Link className={c.status === "not_connected" ? "pill pill-accent" : "pill pill-warn"} href={connectHref(c.key)}>{c.status === "not_connected" ? `Connect ${c.name}` : c.status === "pending" ? `${c.name} · finish connecting` : `${c.name} · reconnect`}</Link>}
            </li>
          ))}
        </ul>
        {!view.supportEmployee && <p className="mt-2 text-sm text-muted">No approved employee answers customers yet. Ask for one on the <Link className="font-semibold text-accent" href={`/w/${view.businessId}/workforce`}>Workforce</Link> tab (for example “handle customer enquiries”).</p>}
        {view.supportEmployee && view.channels.some(c => c.status === "connected" && !c.employeeCanAnswer) && <p className="mt-2 text-sm text-muted">Some connected channels aren&apos;t answered yet: allow {view.supportEmployee.name} to read and send messages there in <Link className="font-semibold text-accent" href={`/w/${view.businessId}/integrations`}>Integrations</Link> or on the Workforce tab.</p>}
        {missing.length > 0 && <p className="mt-2 text-xs text-muted">Not connected: {missing.map(m => m.name).join(", ")}.</p>}
      </section>

      <section className="conn-card">
        <div className="row-between">
          <h2 className="text-base font-semibold text-ink">How replies go out</h2>
          <div className="flex gap-2">
            <button type="button" className={view.settings.mode === "approve" ? "conn-pill conn-pill-on" : "conn-pill"} disabled={!!busy} onClick={() => post("mode", { action: "settings", mode: "approve" })}>I approve every reply</button>
            <button type="button" className={view.settings.mode === "auto" ? "conn-pill conn-pill-on" : "conn-pill"} disabled={!!busy} onClick={() => post("mode", { action: "settings", mode: "auto" })}>Routine replies go automatically</button>
          </div>
        </div>
        <p className="mt-1 text-xs text-muted">Automatic replies must pass every check (only your prices, no promises of refunds or discounts, no links). Complaints, refunds and sensitive messages always wait for you.</p>
        <label className="field-label mt-3" htmlFor="kb">Approved business knowledge (what the employee may tell customers)</label>
        <textarea id="kb" className="field" rows={4} maxLength={4000} value={knowledge} onChange={e => setKnowledge(e.target.value)} placeholder="Opening hours, delivery areas and times, returns policy, sizes, how to order…" />
        <button type="button" className="btn btn-secondary btn-sm mt-2" disabled={!!busy || knowledge === view.settings.knowledge} onClick={() => post("kb", { action: "settings", knowledge })}>{busy === "kb" ? "Saving…" : "Save knowledge"}</button>
      </section>

      <section className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
        <ul className="conn-card space-y-1" aria-label="Conversations">
          {view.conversations.length === 0 && <li className="text-sm text-muted">No conversations yet. They appear here as customers write.</li>}
          {view.conversations.map(c => {
            const last = c.messages[c.messages.length - 1];
            return (
              <li key={c.id}>
                <button type="button" className={`w-full rounded-xl px-3 py-2 text-left ${open === c.id ? "bg-accent-soft" : ""}`} onClick={() => setOpen(c.id)}>
                  <span className="row-between"><span className="text-sm font-semibold text-ink">{c.contact ?? c.thread}</span><span className="text-xs text-muted">{CHANNEL[c.channel] ?? c.channel}</span></span>
                  <span className="block truncate text-xs text-muted">{last?.text}</span>
                  <span className="mt-1 flex flex-wrap gap-1">
                    {c.status === "needs_owner" && <span className="pill pill-warn">Needs you</span>}
                    {c.pending > 0 && <span className="pill pill-accent">{c.pending} to approve</span>}
                    {c.order && <span className="pill pill-accent">Order to confirm</span>}
                    {c.lead && <span className="pill pill-ok">Lead</span>}
                    {c.status === "resolved" && <span className="pill">Resolved</span>}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>

        {conv && (
          <div className="conn-card">
            <div className="row-between">
              <div>
                <h2 className="text-base font-semibold text-ink">{conv.contact ?? conv.thread}</h2>
                <p className="text-xs text-muted">{CHANNEL[conv.channel] ?? conv.channel}{conv.intent ? ` · ${conv.intent}` : ""}{conv.lead ? ` · Lead: ${conv.lead.note}` : ""}</p>
              </div>
              <button type="button" className="btn btn-secondary btn-sm" disabled={!!busy} onClick={() => post("status", { action: "status", conversation_id: conv.id, status: conv.status === "resolved" ? "open" : "resolved" })}>{conv.status === "resolved" ? "Reopen" : "Mark resolved"}</button>
            </div>
            {conv.order && <p className="notice mt-3"><span className="font-semibold text-ink">Order captured, waiting for your confirmation:</span> {conv.order.quantity ? `${conv.order.quantity} × ` : ""}{conv.order.product}{conv.order.details ? ` · ${conv.order.details}` : ""}. Confirm it with the customer before treating it as an order.</p>}
            {conv.escalation && conv.status === "needs_owner" && <p className="notice mt-3">Waiting for you: {conv.escalation.reason}</p>}
            {!conv.windowOpen && <p className="notice mt-3">This customer last wrote more than 24 hours ago: {CHANNEL[conv.channel]} only allows approved message templates now, so replies can&apos;t be sent from here.</p>}
            <ul className="mt-3 space-y-2">
              {conv.messages.filter(m => m.status !== "discarded").map(m => (
                <li key={m.id} className={`rounded-xl px-3 py-2 text-sm ${m.direction === "in" ? "bg-surface-2 text-ink" : "border border-line text-ink"}`}>
                  <p className="text-xs text-muted">{m.direction === "in" ? (conv.contact ?? "Customer") : m.by === "owner" ? "You" : (view.supportEmployee?.name ?? m.by)} · {new Date(m.at).toLocaleString()}{MSG_STATUS[m.status] ? ` · ${MSG_STATUS[m.status]}` : ""}</p>
                  {m.status === "pending_approval" ? (
                    <div className="mt-1 stack-sm">
                      <textarea className="field" rows={3} maxLength={2000} value={edits[m.id] ?? m.text} onChange={e => setEdits({ ...edits, [m.id]: e.target.value })} aria-label="Reply" />
                      {m.checks?.filter(c => !c.passed).map(c => <p key={c.code} className="text-xs text-danger">{c.label}: {c.detail}</p>)}
                      {m.note && <p className="text-xs text-muted">{m.note}</p>}
                      <div className="flex gap-2">
                        <button type="button" className="btn btn-primary btn-sm" disabled={!!busy || !conv.windowOpen} onClick={() => post(`ap-${m.id}`, { action: "approve", conversation_id: conv.id, message_id: m.id, text: edits[m.id] ?? null, approval_key: newKey() })}>{busy === `ap-${m.id}` ? "Sending…" : "Approve & send"}</button>
                        <button type="button" className="btn btn-secondary btn-sm" disabled={!!busy} onClick={() => post(`di-${m.id}`, { action: "discard", conversation_id: conv.id, message_id: m.id })}>Discard</button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <p className="mt-1 whitespace-pre-wrap">{m.text}</p>
                      {m.note && m.direction === "out" && m.status !== "sent" && <p className="mt-1 text-xs text-muted">{m.note}</p>}
                    </>
                  )}
                </li>
              ))}
            </ul>
            <div className="mt-3 stack-sm">
              <textarea className="field" rows={2} maxLength={2000} value={compose} onChange={e => setCompose(e.target.value)} placeholder="Write a reply yourself…" aria-label="Your reply" disabled={!conv.windowOpen} />
              <button type="button" className="btn btn-primary btn-sm" disabled={!!busy || !compose.trim() || !conv.windowOpen} onClick={async () => { if (await post("compose", { action: "reply", conversation_id: conv.id, text: compose, approval_key: newKey() })) setCompose(""); }}>{busy === "compose" ? "Sending…" : "Send"}</button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
