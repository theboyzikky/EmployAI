"use client";

import { useState } from "react";

/** M7 · Owner control: the public ledger is private by default; publishing creates an unguessable link. */
export function PublicLedgerToggle({ businessId, initialSlug }: { businessId: string; initialSlug: string | null }) {
  const [slug, setSlug] = useState(initialSlug);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const toggle = async (publish: boolean) => {
    setBusy(true); setErr(null);
    try {
      const r = await fetch(`/api/w/${businessId}/ledger/publish`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ public: publish }) });
      const j = await r.json().catch(() => null) as { ledger?: { publicSlug: string | null }; error?: { message: string } } | null;
      if (!r.ok) { setErr(j?.error?.message ?? "That didn't work."); return; }
      setSlug(j?.ledger?.publicSlug ?? null);
    } catch { setErr("We couldn't reach EmployAI."); } finally { setBusy(false); }
  };
  const url = slug ? `${typeof window === "undefined" ? "" : window.location.origin}/ledger/${slug}` : null;
  return (
    <div className="mt-4 rounded-xl bg-surface-2 px-3 py-2.5 text-sm">
      <p className="font-semibold text-ink">Public ledger: {slug ? "published" : "private"}</p>
      <p className="mt-0.5 text-xs text-muted">If you publish it, anyone with the link sees only your verified NEAR testnet payouts (amount, recipient account, transaction hash, time). Never business amounts, simulated runs or your business details.</p>
      {url && <p className="mt-1 break-all font-mono text-xs text-ink"><a href={url} target="_blank" rel="noreferrer" className="underline">{url}</a></p>}
      <button type="button" className="btn btn-secondary btn-sm mt-2" disabled={busy} onClick={() => toggle(!slug)}>{busy ? "Saving…" : slug ? "Make private" : "Publish"}</button>
      {err && <p role="alert" className="mt-1 text-xs text-danger">{err}</p>}
    </div>
  );
}
