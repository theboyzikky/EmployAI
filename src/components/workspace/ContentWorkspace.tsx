"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { ContentItem } from "@/lib/content/model";
import type { PlatformView } from "@/lib/platform/view";
import { callPlatform, statusPill } from "./platform-api";

const STATUS: Record<string, string> = {
  idea: "Idea", draft: "Draft — awaiting your approval", needs_changes: "Needs changes", scheduled: "Scheduled", publishing: "Publishing",
  published: "Published", failed: "Failed", needs_attention: "Needs your attention", cancelled: "Cancelled",
};
const newKey = () => (crypto.randomUUID?.() ?? `${Date.now()}${Math.random()}`).replace(/[^A-Za-z0-9]/g, "").slice(0, 32);
const localInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

export function ContentWorkspace({ initial }: { initial: PlatformView }) {
  const [view, setView] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", description: "", price_text: "", offer_text: "", image_url: "" });
  const [file, setFile] = useState<File | null>(null);
  const [edits, setEdits] = useState<Record<string, { caption: string; hashtags: string }>>({});
  const [when, setWhen] = useState<Record<string, string>>({});
  const base = `/api/w/${view.businessId}`;
  const publisher = view.workforce?.employees.find(e => e.status === "active" && e.skills.some(s => s.id === "publish_social_post"));
  const writer = view.workforce?.employees.find(e => e.status === "active" && e.skills.some(s => s.id === "draft_caption"));
  const igConnected = view.connections.some(c => c.connector === "instagram" && c.status === "active");
  const live = view.content.some(i => i.status === "scheduled" || i.status === "publishing");

  // While something is scheduled, keep the page current. The page is NOT what publishes: the background worker is.
  useEffect(() => {
    if (!live) return;
    const t = setInterval(async () => { const r = await callPlatform(`${base}/workforce`, "GET"); if (r.ok && r.view) setView(r.view); }, 10_000);
    return () => clearInterval(t);
  }, [live, base]);

  async function post(label: string, body: unknown) {
    setBusy(label); setError(null);
    const r = await callPlatform(`${base}/content`, "POST", body);
    if (r.view) setView(r.view);
    if (!r.ok) setError(r.message);
    setBusy(null);
    return r.ok;
  }

  async function addProduct() {
    setBusy("product"); setError(null);
    let media_id: string | null = null;
    if (file) {
      const up = await callPlatform(`${base}/media`, "POST", undefined, { contentType: "image/jpeg", data: file });
      if (!up.ok) { setError(up.message); setBusy(null); return; }
      media_id = String(up.data.media_id);
    }
    const ok = await post("product", { action: "add_product", name: form.name, description: form.description, price_text: form.price_text || null, offer_text: form.offer_text || null, image_url: media_id ? null : form.image_url || null, media_id });
    if (ok) { setForm({ name: "", description: "", price_text: "", offer_text: "", image_url: "" }); setFile(null); }
  }

  const productName = (id: string | null) => view.products.find(p => p.id === id)?.name ?? "General post";
  const editOf = (i: ContentItem) => edits[i.id] ?? { caption: i.caption ?? "", hashtags: i.hashtags.join(" ") };
  const dirty = (i: ContentItem) => !!edits[i.id] && (edits[i.id].caption !== (i.caption ?? "") || edits[i.id].hashtags !== i.hashtags.join(" "));

  if (!view.workforce || view.workforce.status !== "approved") {
    return (
      <section className="card px-5 py-6">
        <h1 className="text-xl font-semibold text-ink">Content</h1>
        <p className="mt-2 text-sm text-muted">Plan and approve your AI workforce first. Content is created by the employees you approved, not by a fixed template.</p>
        <Link className="btn btn-primary btn-sm mt-4" href={`/w/${view.businessId}/workforce`}>Go to Workforce</Link>
      </section>
    );
  }

  return (
    <div className="space-y-8">
      <section className="card px-5 py-5">
        <div className="row-between">
          <div>
            <h1 className="text-xl font-semibold text-ink">Content</h1>
            <p className="mt-1 text-sm font-light text-muted">Your real products and photos → a content calendar → captions you approve → published by the background worker at the time you choose.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <span className={view.ai.live ? "pill pill-ok" : "pill"}>{view.ai.live ? "NEAR AI (live)" : view.ai.label}</span>
            <span className={igConnected ? "pill pill-ok" : "pill pill-warn"}>{igConnected ? "Instagram connected" : "Instagram not connected"}</span>
          </div>
        </div>
        <p className="notice mt-3">{view.background.note}</p>
        {error && <p className="notice mt-3" role="alert">{error}</p>}
      </section>

      <section className="card px-5 py-5">
        <h2 className="text-base font-semibold text-ink">1 · Products (your real photos and prices)</h2>
        <p className="mt-1 text-sm text-muted">EmployAI never invents products, prices or images. Captions may only mention the price and offer you enter here.</p>
        {view.products.length > 0 && (
          <ul className="mt-4 grid-2">
            {view.products.map(p => (
              <li key={p.id} className="flex gap-3 rounded-xl border border-line p-3">
                {p.preview ? <img className="thumb" src={p.preview} alt={p.name} /> : <div className="thumb" aria-hidden="true" />}
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-ink">{p.name}</p>
                  <p className="text-sm text-muted">{p.description}</p>
                  <p className="mt-1 text-sm text-ink">{p.price_text ?? "No price given"}{p.offer_text ? ` · ${p.offer_text}` : ""}</p>
                  <button type="button" className="btn btn-secondary btn-sm mt-2" disabled={!!busy} onClick={() => post(`rm-${p.id}`, { action: "remove_product", product_id: p.id })}>Remove</button>
                </div>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-4 grid-2">
          <div><label className="field-label" htmlFor="p-name">Product name</label><input id="p-name" className="field" maxLength={80} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></div>
          <div><label className="field-label" htmlFor="p-price">Price (exactly as customers should see it)</label><input id="p-price" className="field" maxLength={40} value={form.price_text} onChange={e => setForm({ ...form, price_text: e.target.value })} placeholder="e.g. ₦25,000" /></div>
          <div><label className="field-label" htmlFor="p-desc">Description</label><textarea id="p-desc" className="field" maxLength={500} value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} /></div>
          <div><label className="field-label" htmlFor="p-offer">Offer (optional)</label><input id="p-offer" className="field" maxLength={120} value={form.offer_text} onChange={e => setForm({ ...form, offer_text: e.target.value })} placeholder="e.g. Free delivery this week" /></div>
          <div><label className="field-label" htmlFor="p-file">Photo (JPEG, up to 4 MB)</label><input id="p-file" className="field" type="file" accept="image/jpeg" onChange={e => setFile(e.target.files?.[0] ?? null)} /></div>
          <div><label className="field-label" htmlFor="p-url">…or a public https link to a JPEG photo</label><input id="p-url" className="field" maxLength={2048} value={form.image_url} disabled={!!file} onChange={e => setForm({ ...form, image_url: e.target.value })} placeholder="https://…/dress.jpg" /></div>
        </div>
        {!view.background.publicUrl && <p className="mt-2 text-sm text-muted">This server has no public address, so Instagram can't fetch uploaded photos from it. Use a public https photo link here, or deploy.</p>}
        <button type="button" className="btn btn-primary btn-sm mt-4" disabled={!!busy || form.name.trim().length < 2 || form.description.trim().length < 2} onClick={addProduct}>{busy === "product" ? "Saving…" : "Add product"}</button>
      </section>

      <section className="card px-5 py-5">
        <div className="row-between">
          <div>
            <h2 className="text-base font-semibold text-ink">2 · Content calendar</h2>
            <p className="mt-1 text-sm text-muted">{writer ? `Planned and written by ${writer.name}.` : "No active employee can write captions."} {publisher ? `${publisher.name} publishes — only after you approve each post.` : "No active employee can publish."}</p>
          </div>
          <button type="button" className="btn btn-primary btn-sm" disabled={!!busy || view.products.length === 0} onClick={() => post("plan", { action: "plan", days: 7 })}>{busy === "plan" ? "Planning…" : "Plan the next 7 days"}</button>
        </div>
        {view.content.length === 0 ? <p className="mt-4 text-sm text-muted">No posts planned yet.</p> : (
          <ul className="mt-4 space-y-4">
            {view.content.map(i => {
              const ed = editOf(i);
              const editable = i.status === "draft" || i.status === "needs_changes";
              return (
                <li key={i.id} className="rounded-xl border border-line p-4">
                  <div className="row-between">
                    <p className="text-sm font-semibold text-ink">{i.planned_for} · {productName(i.product_id)}</p>
                    <span className={statusPill(i.status)}>{STATUS[i.status]}</span>
                  </div>
                  <p className="mt-1 text-sm text-muted">{i.theme} — {i.angle}</p>
                  {i.written_by && <p className="mt-1 text-xs text-muted">{i.written_by === "owner" ? "Edited by you" : `${i.caption === null ? "Planned" : "Written"} by ${i.written_by.mode === "live" ? `NEAR AI (${i.written_by.model})` : "offline rules (not AI)"}`}</p>}

                  {i.status === "idea" && <button type="button" className="btn btn-primary btn-sm mt-3" disabled={!!busy} onClick={() => post(`draft-${i.id}`, { action: "draft", item_id: i.id })}>{busy === `draft-${i.id}` ? "Writing…" : "Write caption"}</button>}

                  {i.caption !== null && (
                    <div className="mt-3 stack-sm">
                      <textarea className="field" aria-label="Caption" maxLength={2200} readOnly={!editable} value={ed.caption} onChange={e => setEdits({ ...edits, [i.id]: { ...ed, caption: e.target.value } })} />
                      <input className="field" aria-label="Hashtags" readOnly={!editable} value={ed.hashtags} onChange={e => setEdits({ ...edits, [i.id]: { ...ed, hashtags: e.target.value } })} />
                      {i.checks.length > 0 && (
                        <ul className="flex flex-wrap gap-2">{i.checks.map(c => <li key={c.code} className={c.passed ? "pill pill-ok" : "pill pill-warn"} title={c.detail}>{c.passed ? "✓" : "✕"} {c.label}</li>)}</ul>
                      )}
                      {i.checks.filter(c => !c.passed).map(c => <p key={c.code} className="text-sm text-danger">{c.detail}</p>)}
                    </div>
                  )}

                  {editable && (
                    <div className="mt-3 flex flex-wrap items-end gap-2">
                      {dirty(i) && <button type="button" className="btn btn-secondary btn-sm" disabled={!!busy} onClick={async () => { if (await post(`edit-${i.id}`, { action: "edit", item_id: i.id, caption: ed.caption, hashtags: ed.hashtags.split(/\s+/).filter(Boolean) })) setEdits(({ [i.id]: _, ...rest }) => rest); }}>Save edits</button>}
                      {i.status === "needs_changes" && <button type="button" className="btn btn-secondary btn-sm" disabled={!!busy} onClick={() => post(`draft-${i.id}`, { action: "draft", item_id: i.id })}>Rewrite</button>}
                      {i.status === "draft" && !dirty(i) && (
                        <>
                          <div>
                            <label className="field-label" htmlFor={`when-${i.id}`}>Publish at</label>
                            <input id={`when-${i.id}`} className="field" type="datetime-local" value={when[i.id] ?? localInput(new Date(Date.now() + 5 * 60_000))} onChange={e => setWhen({ ...when, [i.id]: e.target.value })} />
                          </div>
                          <button type="button" className="btn btn-primary btn-sm" disabled={!!busy || !igConnected} title={igConnected ? undefined : "Connect Instagram on the Workforce page first"}
                            onClick={() => post(`approve-${i.id}`, { action: "approve", item_id: i.id, scheduled_for: new Date(when[i.id] ?? localInput(new Date(Date.now() + 5 * 60_000))).toISOString(), approval_key: newKey() })}>
                            {busy === `approve-${i.id}` ? "Scheduling…" : "Approve & schedule"}
                          </button>
                        </>
                      )}
                    </div>
                  )}

                  {i.status === "scheduled" && (
                    <div className="mt-3 flex flex-wrap items-center gap-3">
                      <p className="text-sm text-ink">Publishes at <span className="font-semibold">{new Date(i.scheduled_for!).toLocaleString()}</span> — by the background worker, whether or not this page is open.</p>
                      <button type="button" className="btn btn-secondary btn-sm" disabled={!!busy} onClick={() => post(`cancel-${i.id}`, { action: "cancel", item_id: i.id })}>Cancel</button>
                    </div>
                  )}
                  {i.status === "published" && (
                    <p className="notice mt-3">Published and verified by Instagram · media ID <code>{i.media_id}</code>{i.permalink && <> · <a className="font-semibold text-accent" href={i.permalink} target="_blank" rel="noreferrer">View the post</a></>}</p>
                  )}
                  {(i.status === "failed" || i.status === "needs_attention") && i.error && <p className="notice mt-3">{i.error}</p>}
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <p className="text-sm text-muted">Every step is recorded in <Link className="font-semibold text-accent" href={`/w/${view.businessId}/activity`}>Activity</Link>.</p>
    </div>
  );
}
