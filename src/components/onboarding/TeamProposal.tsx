"use client";

import { useState } from "react";
import type { Icon as PhosphorIcon } from "@phosphor-icons/react/dist/lib/types";
import {
  Icon, CaretDownIcon, ChatCircleDotsIcon, CalendarDotsIcon, CheckCircleIcon, CircleNotchIcon, InfoIcon, MinusCircleIcon,
  PackageIcon, PlusCircleIcon, ReceiptIcon, ShieldCheckIcon, TreeStructureIcon, TruckIcon, UsersThreeIcon, WalletIcon, WarningIcon,
} from "@/components/icons";
import type { AgentKey } from "@/lib/catalogue/catalogue";
import type { DiscoveryView } from "@/lib/discovery/view-types";
import { cx } from "@/lib/cx";
import { EvidenceList } from "./AnalysisCard";

const AGENT_ICONS: Record<AgentKey, PhosphorIcon> = {
  orchestrator: TreeStructureIcon, order: ReceiptIcon, inventory: PackageIcon, procurement: TruckIcon,
  finance: WalletIcon, bookings: CalendarDotsIcon, messaging: ChatCircleDotsIcon,
};

type Team = NonNullable<DiscoveryView["team"]>;
type Agent = Team["agents"][number];
export type AgentPatch = { status?: "proposed" | "removed"; tasks?: Record<string, boolean>; owner_note?: string };

/** Stage 5: the recommended workforce. Proposed and configurable only; nothing runs in this stage. */
export function TeamProposal({ team, busy, onPatch, onApprove }: {
  team: Team; busy: string | null;
  onPatch: (key: AgentKey, patch: AgentPatch) => Promise<boolean>;
  onApprove: () => Promise<boolean>;
}) {
  const [confirming, setConfirming] = useState(false);
  const approved = !!team.approvedAt;
  const kept = team.agents.filter(a => a.status !== "removed");

  return (
    <section aria-labelledby="team-title" className="enter space-y-4">
      <div className="card px-5 py-4">
        <h2 id="team-title" className="flex items-center gap-2 text-base font-semibold text-ink">
          <Icon icon={UsersThreeIcon} size={20} swap={false} className="text-accent" />
          {approved ? "Your approved AI workforce" : "Your proposed AI workforce"}
        </h2>
        <p className="mt-1 text-sm font-light leading-relaxed text-muted">
          {team.agents.length === 0
            ? "Nothing in your answers clearly calls for an AI agent yet. You can edit the summary to add more detail."
            : `Chosen only from what you told me: ${kept.length} agent${kept.length === 1 ? "" : "s"} with a clear job for your business.`}
        </p>
        <p className="mt-3 flex items-start gap-2 rounded-xl bg-surface-2 px-3 py-2.5 text-xs font-normal leading-relaxed text-ink">
          <Icon icon={ShieldCheckIcon} size={16} swap={false} className="mt-px flex-none text-accent" />
          These agents are proposals you can configure. None of them is active: nothing runs, pays or contacts anyone at this stage, and workflows are only built after your approval in the next stage.
        </p>
      </div>

      {team.warnings.length > 0 && !approved && (
        <ul className="space-y-1.5 rounded-2xl border border-accent-line bg-accent-soft px-4 py-3" aria-label="Things to check">
          {team.warnings.map(w => (
            <li key={w} className="flex items-start gap-2 text-sm text-ink"><Icon icon={WarningIcon} size={16} swap={false} className="mt-0.5 flex-none text-accent" />{w}</li>
          ))}
        </ul>
      )}

      <div className="grid gap-4 xl:grid-cols-2">
        {team.agents.map(a => <AgentProposalCard key={a.key} agent={a} locked={approved} busy={busy} onPatch={p => onPatch(a.key, p)} />)}
      </div>

      {team.agents.length > 0 && (
        approved ? (
          <div role="status" className="card flex items-start gap-3 border-success/40 px-5 py-4">
            <Icon icon={CheckCircleIcon} size={22} swap={false} className="mt-0.5 flex-none text-success" />
            <div>
              <p className="text-sm font-semibold text-ink">Team approved on {new Date(team.approvedAt!).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}</p>
              <p className="mt-0.5 text-sm font-light text-muted">Nothing is running. In the next stage EmployAI generates the workflows for these agents, tests them and asks for your approval again before anything is deployed.</p>
            </div>
          </div>
        ) : (
          <div className="card flex flex-wrap items-center justify-between gap-3 px-5 py-4">
            <p className="text-sm text-muted">{confirming ? "Approve this team? Your approval is recorded with a timestamp. Nothing is deployed or run." : `${kept.length} of ${team.agents.length} agents kept.`}</p>
            <div className="flex gap-2">
              {confirming && <button type="button" className="btn btn-secondary btn-sm" onClick={() => setConfirming(false)} disabled={!!busy}>Not yet</button>}
              <button
                type="button"
                className="btn btn-primary btn-sm icon-host"
                disabled={!!busy || kept.length === 0}
                onClick={async () => { if (!confirming) { setConfirming(true); return; } if (await onApprove()) setConfirming(false); }}
              >
                {busy === "approving" ? <span className="animate-spin motion-reduce:animate-none"><Icon icon={CircleNotchIcon} size={16} swap={false} /></span> : <Icon icon={CheckCircleIcon} size={16} />}
                {confirming ? "Yes, approve the team" : "Approve team"}
              </button>
            </div>
          </div>
        )
      )}
    </section>
  );
}

function AgentProposalCard({ agent, locked, busy, onPatch }: { agent: Agent; locked: boolean; busy: string | null; onPatch: (p: AgentPatch) => Promise<boolean> }) {
  const removed = agent.status === "removed";
  const [note, setNote] = useState(agent.ownerNote);
  const disabled = locked || !!busy;
  return (
    <article className={cx("card flex flex-col p-5", removed && "opacity-60")} aria-label={agent.name}>
      <div className="flex items-start gap-3">
        <span className={cx("inline-flex h-11 w-11 flex-none items-center justify-center rounded-xl", agent.key === "orchestrator" ? "bg-ink text-on-ink" : "bg-accent-soft text-accent")}>
          <Icon icon={AGENT_ICONS[agent.key]} size={22} swap={false} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-semibold leading-tight text-ink">{agent.name}</h3>
          <p className="text-sm font-medium text-muted">{agent.role}</p>
        </div>
        <span className={cx("whitespace-nowrap rounded-full px-2 py-0.5 text-[0.6875rem] font-semibold",
          agent.status === "approved" ? "text-success ring-1 ring-success/40" : removed ? "bg-surface-2 text-muted ring-1 ring-line" : "bg-accent-soft text-accent")}>
          {agent.status === "approved" ? "Approved · not active" : removed ? "Removed" : "Proposed"}
        </span>
      </div>
      {!agent.executable && (
        <p className="mt-3 rounded-lg bg-surface-2 px-2.5 py-1.5 text-xs font-medium text-muted ring-1 ring-line">Preview — not executable in this prototype</p>
      )}
      <p className="mt-3 text-sm leading-relaxed text-ink">{agent.purpose}</p>

      <h4 className="mt-4 text-xs font-semibold uppercase tracking-[0.06em] text-muted">Why your business needs it</h4>
      <ul className="mt-1.5 space-y-2.5">
        {agent.reasons.map(r => (
          <li key={r.title} className="text-sm">
            <p className="font-medium text-ink">{r.title}{r.basis === "assumed" && <span className="ml-1.5 rounded-full bg-accent-soft px-2 py-0.5 text-[0.6875rem] font-semibold text-accent">Based on an assumption</span>}</p>
            <EvidenceList evidence={r.evidence} />
          </li>
        ))}
      </ul>

      <h4 className="mt-4 text-xs font-semibold uppercase tracking-[0.06em] text-muted">What it will handle</h4>
      <ul className="mt-1.5 space-y-1.5">
        {agent.tasks.map(t => (
          <li key={t.id}>
            <label className={cx("flex items-start gap-2.5 text-sm", t.enabled ? "text-ink" : "text-muted line-through", !disabled && !removed && "cursor-pointer")}>
              <input
                type="checkbox"
                checked={t.enabled}
                disabled={disabled || removed}
                onChange={e => onPatch({ tasks: { [t.id]: e.target.checked } })}
                className="mt-0.5 h-4 w-4 flex-none accent-[var(--color-accent-solid)]"
              />
              {t.label}
            </label>
          </li>
        ))}
      </ul>

      {agent.collaboratesWith.length > 0 && (
        <p className="mt-4 text-sm text-muted"><span className="font-medium text-ink">Works with:</span> {agent.collaboratesWith.join(", ")}</p>
      )}

      <details className="faq mt-4 rounded-xl border border-line px-3 py-2">
        <summary className="icon-host flex cursor-pointer items-center justify-between text-sm font-medium text-ink">
          Permissions and limits
          <span className="faq-caret inline-flex"><Icon icon={CaretDownIcon} size={16} /></span>
        </summary>
        <div className="faq-body mt-2 space-y-2 pb-1 text-sm">
          <p className="text-muted"><span className="font-medium text-ink">Tools (fixed by the catalogue):</span> {agent.tools.map(t => t.replace(/_/g, " ")).join(", ")}</p>
          <p className="text-muted"><span className="font-medium text-ink">Money:</span> {agent.financialPermissions}</p>
          <div>
            <p className="font-medium text-ink">It will never:</p>
            <ul className="mt-1 space-y-0.5">{agent.prohibited.map(p => <li key={p} className="flex gap-2 text-muted"><span aria-hidden="true">×</span>{p}</li>)}</ul>
          </div>
          <p className="text-muted"><span className="font-medium text-ink">Needs your approval:</span> {agent.approvals.join(" ")}</p>
        </div>
      </details>

      {!locked && !removed && (
        <div className="mt-4">
          <label htmlFor={`note-${agent.key}`} className="text-xs font-semibold uppercase tracking-[0.06em] text-muted">Your note for this agent (optional)</label>
          <textarea
            id={`note-${agent.key}`}
            value={note}
            maxLength={500}
            rows={2}
            onChange={e => setNote(e.target.value)}
            onBlur={() => { if (note.trim() !== agent.ownerNote) onPatch({ owner_note: note }); }}
            placeholder="For example: only reorder from the market on Mondays."
            className="mt-1 w-full resize-y rounded-[12px] border border-line bg-surface px-3 py-2 text-sm text-ink outline-none placeholder:font-light placeholder:text-subtle focus:border-accent"
          />
          <p className="mt-1 flex items-start gap-1.5 text-xs font-light text-muted"><Icon icon={InfoIcon} size={12} swap={false} className="mt-0.5" />Guidance for later stages. A note can&rsquo;t grant permissions or change limits.</p>
        </div>
      )}
      {locked && agent.ownerNote && <p className="mt-4 text-sm text-muted"><span className="font-medium text-ink">Your note:</span> {agent.ownerNote}</p>}

      {!locked && (
        <div className="mt-auto pt-4">
          <button type="button" className="btn btn-secondary btn-sm icon-host" disabled={disabled} onClick={() => onPatch({ status: removed ? "proposed" : "removed" })}>
            <Icon icon={removed ? PlusCircleIcon : MinusCircleIcon} size={16} /> {removed ? "Add back" : "Remove from team"}
          </button>
        </div>
      )}
    </article>
  );
}
