"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Icon, CircleNotchIcon, PowerIcon } from "@/components/icons";
import { cx } from "@/lib/cx";
import { callRuns } from "./runs-api";

/**
 * M4 · D8: the in-app kill switch in the workspace header. Turning it on needs a confirm step; it stops
 * new test runs, cancels active ones and invalidates pending approvals. (The on-chain pause joins it in M5.)
 */
export function KillSwitchControl({ businessId, initialActive }: { businessId: string; initialActive: boolean }) {
  const router = useRouter();
  const [active, setActive] = useState(initialActive);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = async (next: boolean) => {
    setBusy(true); setError(null);
    const r = await callRuns(`/api/w/${businessId}/kill-switch`, "POST", { active: next });
    setBusy(false); setConfirming(false);
    if (r.ok) { setActive(next); router.refresh(); } else setError(r.message);
  };

  if (confirming) {
    return (
      <div role="group" aria-label="Confirm the kill switch" className="flex items-center gap-1.5">
        <span className="hidden text-xs font-medium text-ink md:inline">Stop all test runs?</span>
        <button type="button" className="btn btn-sm icon-host bg-danger text-white hover:opacity-90" onClick={() => set(true)} disabled={busy}>
          {busy ? <Icon icon={CircleNotchIcon} size={16} swap={false} className="animate-spin motion-reduce:animate-none" /> : <Icon icon={PowerIcon} size={16} />} Switch on
        </button>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => setConfirming(false)} disabled={busy}>Cancel</button>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2">
      {error && <span role="alert" className="hidden text-xs font-medium text-danger md:inline">{error}</span>}
      <button
        type="button"
        aria-pressed={active}
        onClick={() => (active ? set(false) : setConfirming(true))}
        disabled={busy}
        className={cx("btn btn-sm icon-host", active ? "bg-danger text-white hover:opacity-90" : "btn-secondary")}
        title={active ? "The kill switch is on: no test runs can start. Click to switch it off." : "Stop all test runs and invalidate pending approvals."}
      >
        <Icon icon={PowerIcon} size={16} />
        <span className="hidden sm:inline">{active ? "Kill switch on" : "Kill switch"}</span>
        <span className="sr-only sm:hidden">{active ? "Kill switch on" : "Kill switch"}</span>
      </button>
    </div>
  );
}
