import { Icon, CheckCircleIcon, DatabaseIcon, WarningIcon, XIcon } from "@/components/icons";
import type { DemoScenario } from "@/lib/workflows/demo-data";
import type { ValidationResult, WorkflowStatus } from "@/lib/workflows/schema";
import type { WorkspaceWorkflow } from "@/lib/workflows/view-types";
import { cx } from "@/lib/cx";
import { ngn, when } from "./workspace-api";

export const STATUS_LABEL: Record<WorkflowStatus, string> = { draft: "Draft", approved: "Approved", superseded: "Superseded" };

export function StatusBadge({ status }: { status: WorkflowStatus }) {
  return (
    <span className={cx("whitespace-nowrap rounded-full px-2 py-0.5 text-[0.6875rem] font-semibold",
      status === "approved" ? "bg-surface text-success ring-1 ring-success/40" : status === "draft" ? "bg-accent-soft text-accent" : "bg-surface-2 text-muted ring-1 ring-line")}>
      {STATUS_LABEL[status]}
    </span>
  );
}

/** Every check the validator ran. A workflow with any failed check can't be approved. */
export function ValidationPanel({ validation }: { validation: ValidationResult }) {
  const failed = validation.checks.filter(c => !c.passed);
  return (
    <div>
      <p className={cx("flex items-start gap-2 text-sm font-semibold", failed.length ? "text-danger" : "text-success")} role="status">
        <Icon icon={failed.length ? WarningIcon : CheckCircleIcon} size={18} swap={false} className="mt-px flex-none" />
        {failed.length
          ? `${failed.length} of ${validation.checks.length} checks failed. This version can't be approved.`
          : `All ${validation.checks.length} checks passed.`}
      </p>
      <p className="mt-0.5 text-xs text-muted">Checked {when(validation.validated_at)}</p>
      <ul className="mt-3 space-y-2">
        {[...failed, ...validation.checks.filter(c => c.passed)].map(c => (
          <li key={c.code} className="flex items-start gap-2 text-sm">
            <Icon icon={c.passed ? CheckCircleIcon : XIcon} size={16} swap={false} className={cx("mt-0.5 flex-none", c.passed ? "text-success" : "text-danger")} />
            <span>
              <span className="font-medium text-ink">{c.label}</span>
              <span className="sr-only">{c.passed ? " (passed)" : " (failed)"}</span>
              {c.detail && !(c.passed && c.detail === "OK") && <span className="mt-0.5 block text-xs text-muted">{c.detail}</span>}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Fictional restaurant data for test runs. Always labelled, never mixed with the owner's business info. */
export function DemoDataCard({ data }: { data: DemoScenario }) {
  const th = "pb-1.5 pr-3 text-left text-xs font-semibold uppercase tracking-[0.06em] text-muted";
  const td = "py-1.5 pr-3 text-sm text-ink";
  return (
    <section aria-labelledby="demo-title" className="card p-5">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="demo-title" className="flex items-center gap-2 text-base font-semibold text-ink">
          <Icon icon={DatabaseIcon} size={20} swap={false} className="text-accent" /> Restaurant demo data
        </h2>
        <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[0.6875rem] font-semibold text-accent">Demo data · fictional</span>
      </div>
      <p className="mt-1 text-sm font-light text-muted">{data.label} Prices are illustrative naira.</p>
      <div className="mt-4 grid gap-5 lg:grid-cols-3">
        <div className="overflow-x-auto">
          <table className="w-full">
            <caption className="mb-2 text-left text-sm font-semibold text-ink">Menu</caption>
            <thead><tr><th className={th}>Item</th><th className={cx(th, "text-right")}>Price</th></tr></thead>
            <tbody className="divide-y divide-line">
              {data.menu.map(m => <tr key={m.item}><td className={td}>{m.item}</td><td className={cx(td, "text-right tabular-nums")}>{ngn(m.price_ngn)}</td></tr>)}
            </tbody>
          </table>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <caption className="mb-2 text-left text-sm font-semibold text-ink">Stock</caption>
            <thead><tr><th className={th}>Item</th><th className={cx(th, "text-right")}>On hand</th><th className={cx(th, "text-right")}>Reorder at</th></tr></thead>
            <tbody className="divide-y divide-line">
              {data.inventory.map(i => {
                const low = i.on_hand < i.reorder_point;
                return (
                  <tr key={i.item}>
                    <td className={td}>{i.item}{low && <span className="ml-1.5 rounded-full bg-accent-soft px-1.5 py-0.5 text-[0.6875rem] font-semibold text-accent">Low</span>}</td>
                    <td className={cx(td, "text-right tabular-nums")}>{i.on_hand} {i.unit}</td>
                    <td className={cx(td, "text-right tabular-nums")}>{i.reorder_point} {i.unit}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <caption className="mb-2 text-left text-sm font-semibold text-ink">Suppliers</caption>
            <thead><tr><th className={th}>Supplier</th><th className={cx(th, "text-right")}>Per kg</th></tr></thead>
            <tbody className="divide-y divide-line">
              {data.suppliers.map(s => (
                <tr key={s.name}>
                  <td className={td}>
                    {s.name}
                    <span className={cx("block text-xs", s.approved ? "text-success" : "text-danger")}>{s.approved ? "Approved supplier" : "Not approved: can never be paid"}</span>
                  </td>
                  <td className={cx(td, "text-right tabular-nums")}>{ngn(s.price_per_unit_ngn)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

export function VersionHistory({ workflows, shownId, onShow }: { workflows: WorkspaceWorkflow[]; shownId: string; onShow: (id: string) => void }) {
  return (
    <ul className="space-y-1.5">
      {workflows.map(w => (
        <li key={w.id}>
          <button
            type="button"
            onClick={() => onShow(w.id)}
            aria-current={w.id === shownId ? "true" : undefined}
            className={cx("flex w-full items-center justify-between gap-3 rounded-xl border px-3 py-2 text-left transition-colors",
              w.id === shownId ? "border-accent-solid bg-accent-soft" : "border-line hover:border-accent-line")}
          >
            <span>
              <span className="block text-sm font-semibold text-ink">Version {w.version}</span>
              <span className="block text-xs text-muted">{w.approvedAt ? `Approved ${when(w.approvedAt)}` : `Built ${when(w.createdAt)}`}</span>
            </span>
            <StatusBadge status={w.status} />
          </button>
        </li>
      ))}
    </ul>
  );
}
