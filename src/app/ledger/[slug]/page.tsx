import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { publicLedgerBySlug } from "@/lib/runs/public-ledger";

export const metadata: Metadata = { title: "Public ledger — EmployAI", robots: { index: false } };

/**
 * M7 · Public ledger: shown only when the owner published it. Lists ONLY verified NEAR testnet payouts
 * (facts already public on chain), each with its transaction hash so anyone can check it independently.
 */
export default function PublicLedgerPage({ params }: { params: Promise<{ slug: string }> }) {
  return (
    <Suspense fallback={<main className="mx-auto min-h-dvh w-full max-w-3xl bg-canvas px-4 py-10" aria-busy="true" />}>
      <PublicLedger params={params} />
    </Suspense>
  );
}

async function PublicLedger({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const view = await publicLedgerBySlug(slug);
  if (!view) notFound();
  return (
    <main className="mx-auto min-h-dvh w-full max-w-3xl bg-canvas px-4 py-10">
      <Link href="/" className="text-sm font-semibold text-accent">EmployAI</Link>
      <h1 className="mt-4 text-2xl font-semibold text-ink">{view.businessName} · public ledger</h1>
      <p className="mt-2 text-sm text-muted">
        Supplier payments made by this business&apos;s Finance Agent on <strong>NEAR testnet</strong>, through its treasury contract, after the owner approved each one.
        Every row was verified by EmployAI against the chain; check any of them yourself with its transaction hash. Simulated test runs are never listed here.
      </p>
      <p className="mt-4 rounded-xl bg-surface-2 px-3 py-2.5 text-sm text-ink">Total paid: <strong>{view.totalNear} NEAR</strong> in {view.rows.length} verified payment{view.rows.length === 1 ? "" : "s"}.</p>
      {view.rows.length === 0 ? <p className="mt-4 text-sm text-muted">No verified payments yet.</p> : (
        <ul className="mt-4 divide-y divide-line rounded-xl bg-surface px-3 ring-1 ring-line">
          {view.rows.map(r => (
            <li key={r.txHash} className="py-3 text-sm">
              <p className="text-ink"><strong>{r.amountText}</strong> to <span className="break-all font-mono text-xs">{r.recipient}</span></p>
              <p className="mt-0.5 text-xs text-muted">{new Date(r.occurredAt).toUTCString()}</p>
              <p className="mt-1 break-all font-mono text-xs text-ink">{r.txHash}</p>
              <p className="mt-1 flex gap-3 text-xs">
                <a href={r.explorer.primary} target="_blank" rel="noreferrer" className="font-medium text-accent underline">View on NEAR Rocks</a>
                <a href={r.explorer.secondary} target="_blank" rel="noreferrer" className="text-muted underline">NearBlocks</a>
              </p>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-6 text-xs text-muted">Testnet only: these are test tokens with no monetary value. The owner can make this page private again at any time.</p>
    </main>
  );
}
