import { Icon, ReceiptIcon, CheckCircleIcon, XIcon, ClockIcon, InfoIcon } from "@/components/icons";
import type { LedgerRowView, LedgerView } from "@/lib/runs/ledger-view";
import { cx } from "@/lib/cx";

const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
const ngn = (n: number) => `₦${n.toLocaleString("en-NG")}`;

const KIND: Record<LedgerRowView["kind"], { text: string; cls: string; icon: typeof CheckCircleIcon }> = {
  onchain_paid: { text: "Paid on NEAR testnet · verified", cls: "text-success ring-1 ring-success/40", icon: CheckCircleIcon },
  onchain_failed: { text: "Failed on-chain · not paid", cls: "text-danger ring-1 ring-danger/40", icon: XIcon },
  simulated: { text: "Simulated · test run, no transaction", cls: "bg-surface-2 text-muted ring-1 ring-line", icon: InfoIcon },
};

/** M5 · Private owner ledger: read-only, server-rendered. Real and simulated rows are never mixed up. */
export function LedgerWorkspace({ view }: { view: LedgerView }) {
  const t = view.totals;
  return (
    <div className="space-y-5">
      <section aria-labelledby="ledger-title" className="card px-5 py-4">
        <h1 id="ledger-title" className="flex items-center gap-2 text-xl font-semibold text-ink"><Icon icon={ReceiptIcon} size={22} swap={false} className="text-accent" />Ledger</h1>
        <p className="mt-1 text-sm font-light text-muted">
          Private to you. Real payments appear here only after EmployAI verified them on NEAR testnet. Test runs are listed separately and never moved money.
        </p>
        <dl className="mt-4 grid gap-3 sm:grid-cols-4">
          <Stat label="Paid on NEAR testnet" value={`${t.paidNear} NEAR`} note={`${t.paidCount} verified payment${t.paidCount === 1 ? "" : "s"}`} />
          <Stat label="Failed on-chain" value={String(t.failedCount)} note="Nothing paid" />
          <Stat label="In progress" value={String(t.pendingCount)} note="Not counted as paid" />
          <Stat label="Simulated (test runs)" value={String(t.simulatedCount)} note="No transaction" />
        </dl>
      </section>

      {view.pending.length > 0 && (
        <section aria-labelledby="pending-title" className="card px-5 py-4">
          <h2 id="pending-title" className="flex items-center gap-2 text-base font-semibold text-ink"><Icon icon={ClockIcon} size={18} swap={false} className="text-accent" />Payments in progress</h2>
          <p className="mt-0.5 text-xs text-muted">Not verified yet, so not shown as paid. Open the run to check its status.</p>
          <ul className="mt-3 space-y-2">
            {view.pending.map(p => (
              <li key={p.attemptId} className="rounded-xl bg-surface-2 px-3 py-2.5 text-sm">
                <p className="text-ink">{p.amountText} to <span className="break-all font-mono text-xs">{p.recipient}</span> · <span className="font-semibold">{p.status}</span></p>
                {p.txHash && <p className="mt-0.5 break-all font-mono text-xs text-muted">{p.txHash}</p>}
                <p className="mt-0.5 text-xs text-muted">Since {when(p.since)}</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="rows-title" className="card px-5 py-4">
        <h2 id="rows-title" className="text-base font-semibold text-ink">All payments</h2>
        {view.rows.length === 0 ? <p className="mt-2 text-sm text-muted">No payments yet.</p> : (
          <ul className="mt-3 divide-y divide-line">
            {view.rows.map(r => {
              const k = KIND[r.kind];
              return (
                <li key={r.id} className="py-3 text-sm">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <p className="text-ink"><span className="font-semibold">{r.amountText}</span> to <span className={cx(r.kind !== "simulated" && "break-all font-mono text-xs")}>{r.recipient}</span>{r.supplier ? ` (${r.supplier})` : ""}</p>
                    <span className={cx("inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[0.6875rem] font-semibold", k.cls)}><Icon icon={k.icon} size={12} swap={false} />{k.text}</span>
                  </div>
                  <p className="mt-0.5 text-xs text-muted">
                    {when(r.occurredAt)}{r.kind !== "simulated" ? ` · business amount ${ngn(r.businessAmountNgn)} (illustrative, not converted)` : ""}{r.batch ? ` · batch ${r.batch}` : ""}
                  </p>
                  {r.txHash && <p className="mt-1 break-all font-mono text-xs text-ink">Transaction {r.txHash}</p>}
                  {r.explorer && (
                    <p className="mt-1 flex flex-wrap gap-3 text-xs">
                      <a href={r.explorer.primary} target="_blank" rel="noreferrer" className="font-medium text-accent underline">View on NEAR Rocks</a>
                      <a href={r.explorer.secondary} target="_blank" rel="noreferrer" className="text-muted underline">NearBlocks</a>
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

const Stat = ({ label, value, note }: { label: string; value: string; note: string }) => (
  <div className="rounded-xl bg-surface-2 px-3 py-2.5">
    <dt className="text-xs font-semibold uppercase tracking-[0.06em] text-muted">{label}</dt>
    <dd className="mt-1 text-lg font-semibold text-ink">{value}</dd>
    <dd className="text-xs text-muted">{note}</dd>
  </div>
);
