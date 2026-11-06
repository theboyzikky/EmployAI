"use client";

import { useEffect, useState } from "react";
import { Icon, CircleNotchIcon, FloppyDiskIcon, InfoIcon } from "@/components/icons";
import type { Params } from "@/lib/workflows/schema";
import type { WorkspaceView } from "@/lib/workflows/view-types";
import { ngn } from "./workspace-api";

type Limits = WorkspaceView["paramLimits"];

/**
 * The only owner-editable part of a workflow. Amounts are illustrative NGN for the restaurant demo;
 * NEAR-denominated contract limits and network fees are configured separately in M5. No conversion.
 */
export function WorkflowSettings({ params, limits, locked, lockedReason, saving, saveLabel = "Save settings", onSave }: {
  params: Params; limits: Limits; locked: boolean; lockedReason?: string;
  saving: boolean;
  /** "Save as new draft" when the shown version is approved (approved versions are locked). */
  saveLabel?: string;
  onSave: (patch: Partial<Params>) => Promise<boolean>;
}) {
  const [threshold, setThreshold] = useState(String(params.approval_threshold_ngn));
  const [max, setMax] = useState(String(params.max_payment_ngn));
  const [notifyCustomer, setNotifyCustomer] = useState(params.notify_customer);
  const [notifyOwner, setNotifyOwner] = useState(params.notify_owner);

  useEffect(() => {
    setThreshold(String(params.approval_threshold_ngn)); setMax(String(params.max_payment_ngn));
    setNotifyCustomer(params.notify_customer); setNotifyOwner(params.notify_owner);
  }, [params]);

  const t = Number(threshold), m = Number(max);
  const problem =
    !Number.isInteger(t) || t < limits.approval_threshold_ngn.min || t > limits.approval_threshold_ngn.max
      ? `Approval threshold must be a whole number from ${ngn(limits.approval_threshold_ngn.min)} to ${ngn(limits.approval_threshold_ngn.max)}.`
      : !Number.isInteger(m) || m < limits.max_payment_ngn.min || m > limits.max_payment_ngn.max
        ? `Maximum payment must be a whole number from ${ngn(limits.max_payment_ngn.min)} to ${ngn(limits.max_payment_ngn.max)}.`
        : t > m ? "The approval threshold can't be higher than the maximum payment." : null;

  const patch: Partial<Params> = {};
  if (t !== params.approval_threshold_ngn) patch.approval_threshold_ngn = t;
  if (m !== params.max_payment_ngn) patch.max_payment_ngn = m;
  if (notifyCustomer !== params.notify_customer) patch.notify_customer = notifyCustomer;
  if (notifyOwner !== params.notify_owner) patch.notify_owner = notifyOwner;
  const dirty = Object.keys(patch).length > 0;

  const input = "mt-1 w-full rounded-[12px] border border-line bg-surface px-3 py-2 text-sm text-ink outline-none focus:border-accent disabled:opacity-60";

  return (
    <form
      className="space-y-4"
      onSubmit={async e => { e.preventDefault(); if (!problem && dirty) await onSave(patch); }}
      aria-describedby="settings-currency-note"
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm font-medium text-ink">
          Ask me before paying more than
          <span className="relative block">
            <span className="pointer-events-none absolute left-3 top-1/2 mt-0.5 -translate-y-1/2 text-sm text-muted" aria-hidden="true">₦</span>
            <input type="number" inputMode="numeric" step={1000} min={limits.approval_threshold_ngn.min} max={limits.approval_threshold_ngn.max}
              value={threshold} disabled={locked} onChange={e => setThreshold(e.target.value)} className={`${input} pl-7`} aria-label="Approval threshold in naira (illustrative)" />
          </span>
        </label>
        <label className="block text-sm font-medium text-ink">
          Maximum per payment
          <span className="relative block">
            <span className="pointer-events-none absolute left-3 top-1/2 mt-0.5 -translate-y-1/2 text-sm text-muted" aria-hidden="true">₦</span>
            <input type="number" inputMode="numeric" step={1000} min={limits.max_payment_ngn.min} max={limits.max_payment_ngn.max}
              value={max} disabled={locked} onChange={e => setMax(e.target.value)} className={`${input} pl-7`} aria-label="Maximum payment in naira (illustrative)" />
          </span>
        </label>
      </div>
      <fieldset className="space-y-2" disabled={locked}>
        <legend className="sr-only">Notifications</legend>
        <label className="flex items-start gap-2.5 text-sm text-ink">
          <input type="checkbox" checked={notifyCustomer} onChange={e => setNotifyCustomer(e.target.checked)} className="mt-0.5 h-4 w-4 flex-none accent-[var(--color-accent-solid)]" />
          Confirm orders to the demo customer
        </label>
        <label className="flex items-start gap-2.5 text-sm text-ink">
          <input type="checkbox" checked={notifyOwner} onChange={e => setNotifyOwner(e.target.checked)} className="mt-0.5 h-4 w-4 flex-none accent-[var(--color-accent-solid)]" />
          Send me a summary at the end
        </label>
      </fieldset>
      <p id="settings-currency-note" className="flex items-start gap-2 rounded-xl bg-surface-2 px-3 py-2.5 text-xs leading-relaxed text-muted ring-1 ring-line">
        <Icon icon={InfoIcon} size={14} swap={false} className="mt-0.5 flex-none text-accent" />
        Illustrative amounts in Nigerian naira for the restaurant demo. NEAR contract limits and network fees are set separately in a later stage (M5). Nothing is converted between currencies.
      </p>
      {problem && dirty && <p role="alert" className="text-sm font-medium text-danger">{problem}</p>}
      {locked
        ? lockedReason && <p className="text-sm text-muted">{lockedReason}</p>
        : (
          <button type="submit" className="btn btn-secondary btn-sm icon-host" disabled={!dirty || !!problem || saving}>
            {saving ? <span className="animate-spin motion-reduce:animate-none"><Icon icon={CircleNotchIcon} size={16} swap={false} /></span> : <Icon icon={FloppyDiskIcon} size={16} />}
            {saveLabel}
          </button>
        )}
    </form>
  );
}
