import type { Icon as PhosphorIcon } from "@phosphor-icons/react/dist/lib/types";
import {
  Icon, BriefcaseIcon, CaretDownIcon, ChatCircleDotsIcon, ClockIcon, GearSixIcon, InfoIcon, PackageIcon,
  StorefrontIcon, TargetIcon, TruckIcon, UsersThreeIcon, WarningIcon,
} from "@/components/icons";
import type { ProfileFieldKey } from "@/lib/discovery/profile";
import type { DiscoveryView, ViewCauseStatus, ViewUnderstanding } from "@/lib/discovery/view-types";
import { cx } from "@/lib/cx";

const ICONS: Record<ProfileFieldKey, PhosphorIcon> = {
  business_name: StorefrontIcon, industry: BriefcaseIcon, products_services: PackageIcon, customers_channels: ChatCircleDotsIcon,
  team_structure: UsersThreeIcon, daily_operations: ClockIcon, current_tools: GearSixIcon, suppliers: TruckIcon,
  challenges: WarningIcon, goals: TargetIcon,
};
const DEFAULT_FIELDS: DiscoveryView["fields"] = ([
  ["business_name", "Business name"], ["industry", "Industry"], ["products_services", "Products & services"], ["customers_channels", "How customers buy"],
  ["team_structure", "Team & structure"], ["daily_operations", "Daily operations"], ["current_tools", "Tools you use today"], ["suppliers", "Suppliers"],
  ["challenges", "Challenges"], ["goals", "Goals & automation wishes"],
] as Array<[ProfileFieldKey, string]>).map(([key, label]) => ({ key, label, value: null, status: "unknown", skipped: false, editedByOwner: false, sources: [] }));

/**
 * "What I understand" panel: every field shows what the consultant has captured and how sure it is:
 * Confirmed (you said it), Unconfirmed (an inference you should check), Skipped, or Not yet known.
 * Sticky on desktop; a collapsible section on mobile.
 */
export function ContextPanel({ fields = DEFAULT_FIELDS, understanding }: { fields?: DiscoveryView["fields"]; understanding?: ViewUnderstanding }) {
  const known = fields.filter(f => f.value).length;
  const missing = fields.filter(f => !f.value && !f.skipped);
  const u = understanding;
  const toResolve = u?.contradictions.filter(c => c.status === "open") ?? [];
  const corrected = u?.contradictions.filter(c => c.status === "resolved") ?? [];
  const body = (
    <>
      {u?.preM35 && (
        <p className="mt-3 rounded-xl bg-surface-2 px-3 py-2 text-xs leading-normal text-muted ring-1 ring-line">
          Captured before the consultant could investigate causes, so problems below are your own descriptions, not diagnosed.
        </p>
      )}
      {u && (u.owner.name || u.owner.business) && (
        <p className="mt-3 text-sm leading-normal text-ink">
          {u.owner.name && <>Talking with <span className="font-semibold">{u.owner.name}</span></>}
          {u.owner.name && u.owner.business && <span className="text-muted"> · </span>}
          {u.owner.business && <span className="text-muted">{u.owner.business}</span>}
        </p>
      )}
      {u && (u.goals.length > 0 || u.needs.length > 0) && (
        <section className="mt-4" aria-labelledby="ctx-goals">
          <h3 id="ctx-goals" className="text-xs font-semibold uppercase tracking-[0.06em] text-muted">Your goals and needs</h3>
          <ul className="mt-2 space-y-1.5">
            {u.goals.map(g => <li key={g} className="text-sm leading-normal text-ink">&ldquo;{g}&rdquo;</li>)}
            {u.needs.map(n => (
              <li key={n.label} className="flex items-start justify-between gap-2 text-xs leading-normal">
                <span className="text-muted">{n.label}</span>
                <span className="flex-none whitespace-nowrap rounded-full bg-surface px-2 py-0.5 text-[0.6875rem] font-semibold text-muted ring-1 ring-line">{n.status === "stated" ? "You asked for this" : "From a problem you described"}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {u && u.solutions.length > 0 && (
        <section className="mt-4" aria-labelledby="ctx-solutions">
          <h3 id="ctx-solutions" className="text-xs font-semibold uppercase tracking-[0.06em] text-muted">Possible solutions · not decided</h3>
          <ul className="mt-2 space-y-1.5">
            {u.solutions.map(s => (
              <li key={s.agent} className="flex items-start justify-between gap-2 text-xs leading-normal">
                <span className="text-muted"><span className="font-semibold text-ink">{s.agent}</span>, for {s.for.length > 70 ? `${s.for.slice(0, 69)}…` : lowerFirstWord(s.for)}</span>
                {s.preview && <span className="flex-none whitespace-nowrap rounded-full bg-surface px-2 py-0.5 text-[0.6875rem] font-semibold text-muted ring-1 ring-line">Preview</span>}
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-xs leading-normal text-muted">I&rsquo;ll only recommend agents in the analysis, and you choose the team.</p>
        </section>
      )}
      {u && u.inferences.some(i => i.kind === "implied") && (
        <section className="mt-4" aria-labelledby="ctx-inferred">
          <h3 id="ctx-inferred" className="text-xs font-semibold uppercase tracking-[0.06em] text-muted">Inferred from what you said · please check</h3>
          <ul className="mt-2 space-y-1.5">
            {u.inferences.filter(i => i.kind === "implied").map(i => (
              <li key={i.statement} className="text-xs leading-normal">
                <span className="text-ink">{i.statement}.</span> <span className="text-muted">{i.status === "confirmed" ? (i.settledBy === "summary_review" ? "Inferred; you approved it in the summary." : "Inferred; you've confirmed it.") : `${i.reason}.`}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {u && u.inferences.some(i => i.kind === "typical") && (
        <section className="mt-4" aria-labelledby="ctx-typical">
          <h3 id="ctx-typical" className="text-xs font-semibold uppercase tracking-[0.06em] text-muted">Typical for your industry · not known about yours</h3>
          <ul className="mt-2 space-y-1.5">
            {u.inferences.filter(i => i.kind === "typical").map(i => (
              <li key={i.statement} className="text-xs leading-normal">
                <span className="text-ink">{i.statement}.</span> <span className="text-muted">{i.status === "confirmed" ? "You've said this applies to you." : `${i.reason}.`}</span>
                {i.ownerWords && <span className="mt-0.5 block text-ink">What you said: &ldquo;{i.ownerWords}&rdquo;</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
      {u && u.problems.length > 0 && (
        <section className="mt-4" aria-labelledby="ctx-problems">
          <h3 id="ctx-problems" className="text-xs font-semibold uppercase tracking-[0.06em] text-muted">Problems I&rsquo;m investigating</h3>
          <ul className="mt-2 space-y-2">
            {u.problems.map(p => (
              <li key={p.id} className="rounded-xl bg-surface-2 px-3 py-2.5">
                <div className="flex items-start justify-between gap-2">
                  <p className="text-sm font-medium text-ink">{p.fromGoal ? <><span className="text-muted">Behind your goal: </span>{p.symptom}</> : p.symptom}</p>
                  <ResolutionPill resolution={p.resolution} />
                </div>
                {p.ownerView && (
                  <p className="mt-1 text-xs leading-normal text-muted">
                    <span className="font-semibold text-ink">{p.ownerViewStatus === "confirmed" ? "Your view, confirmed:" : p.ownerViewStatus === "questioned" ? "Your view, now doubted:" : "Your view, not yet verified:"}</span> &ldquo;{p.ownerView}&rdquo;
                  </p>
                )}
                {!p.recognisedAs && <p className="mt-1 text-xs leading-normal text-muted">I don&rsquo;t recognise this kind of problem yet, so I won&rsquo;t guess at causes.</p>}
                {p.causes.length > 0 && (
                  <ul className="mt-1.5 space-y-1" aria-label="Possible causes">
                    {p.causes.map(c => (
                      <li key={c.label} className="flex items-start justify-between gap-2 text-xs leading-normal">
                        <span className={cx("text-muted", c.status === "ruled_out" && "line-through")}>{c.label}</span>
                        <CausePill status={c.status} />
                      </li>
                    ))}
                  </ul>
                )}
                {p.uncertainty && p.resolution !== "cause_confirmed" && <p className="mt-1.5 text-xs leading-normal text-muted">{p.uncertainty}</p>}
              </li>
            ))}
          </ul>
        </section>
      )}
      {toResolve.length > 0 && (
        <section className="mt-4 rounded-xl border border-accent-line bg-accent-soft px-3 py-2.5" aria-labelledby="ctx-resolve">
          <h3 id="ctx-resolve" className="text-xs font-semibold uppercase tracking-[0.06em] text-accent">To resolve</h3>
          {toResolve.map(c => <p key={c.label + c.b} className="mt-1 text-xs leading-normal text-ink">{c.label}: &ldquo;{c.a}&rdquo; or &ldquo;{c.b}&rdquo;?</p>)}
        </section>
      )}
      {corrected.length > 0 && (
        <p className="mt-3 text-xs leading-normal text-muted">
          <span className="font-semibold text-ink">Corrected:</span> {corrected.map(c => `${c.label.toLowerCase()} “${c.a}” → “${c.resolution}”`).join("; ")}.
        </p>
      )}
      {u && u.unrecognised.length > 0 && (
        <section className="mt-4" aria-labelledby="ctx-kept">
          <h3 id="ctx-kept" className="text-xs font-semibold uppercase tracking-[0.06em] text-muted">Kept as you said it</h3>
          <ul className="mt-2 space-y-1.5">
            {u.unrecognised.map(x => (
              <li key={x.text} className="text-xs leading-normal text-muted">&ldquo;{x.text}&rdquo;{x.clarification && <> <span className="text-ink">You added: &ldquo;{x.clarification}&rdquo;</span></>}</li>
            ))}
          </ul>
          <p className="mt-1.5 text-xs leading-normal text-muted">I didn&rsquo;t fully follow these, so they&rsquo;re kept in your words rather than guessed at.</p>
        </section>
      )}
      {u?.asking && (
        <p className="mt-3 text-xs leading-normal text-muted"><span className="font-semibold text-ink">Now asking about:</span> {u.asking.label}</p>
      )}
      {u && <h3 className="mt-4 text-xs font-semibold uppercase tracking-[0.06em] text-muted">Facts</h3>}
      <div className="mt-3 flex items-center gap-3" aria-hidden="true">
        <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2">
          <span className="block h-full rounded-full bg-accent-solid transition-[width] duration-500" style={{ width: `${(known / fields.length) * 100}%` }} />
        </span>
        <span className="text-xs font-medium text-muted">{known} of {fields.length}</span>
      </div>
      <ul className="mt-4 space-y-2">
        {fields.map(f => (
          <li key={f.key} className={cx("rounded-xl px-3 py-2.5", f.value ? "bg-surface-2" : "border border-dashed border-line")}>
            <div className="flex items-center gap-2.5">
              <Icon icon={ICONS[f.key]} size={18} state={f.value ? "default" : "disabled"} swap={false} className={f.value ? "text-ink" : undefined} />
              <span className="flex-1 text-sm font-medium text-ink">{f.label}</span>
              <StatusPill status={f.value ? f.status : f.skipped ? "skipped" : "unknown"} />
            </div>
            {f.value && <p className="mt-1.5 line-clamp-3 pl-[28px] text-sm font-normal leading-normal text-muted">{f.value}</p>}
          </li>
        ))}
      </ul>
      {missing.length > 0 && (
        <p className="mt-4 text-xs font-normal leading-relaxed text-muted">
          <span className="font-semibold text-ink">{u ? "Not discussed yet:" : "Still missing:"}</span> {missing.map(m => m.label.toLowerCase()).join(", ")}.{u && " I'll only ask about these if they'd change what I suggest."}
        </p>
      )}
      <p className="mt-3 flex gap-2 text-xs font-light leading-relaxed text-muted">
        <Icon icon={InfoIcon} size={16} swap={false} className="mt-px flex-none" />
        Only what you tell the consultant is recorded. You&rsquo;ll review and correct everything before any agents are proposed.
      </p>
    </>
  );
  return (
    <>
      <div className="card hidden p-5 lg:sticky lg:top-[136px] lg:block lg:max-h-[calc(100dvh-160px)] lg:overflow-y-auto">
        <h2 className="text-base font-semibold text-ink">What I understand</h2>
        {body}
      </div>
      <details className="faq card p-4 lg:hidden">
        <summary className="icon-host flex cursor-pointer items-center justify-between gap-3 text-base font-semibold text-ink">
          <span>What I understand <span className="ml-1 text-sm font-medium text-muted">{known}/{fields.length}</span></span>
          <span className="faq-caret inline-flex"><Icon icon={CaretDownIcon} size={20} /></span>
        </summary>
        <div className="faq-body">{body}</div>
      </details>
    </>
  );
}

/** "I spend hours…" stays as written; "Automated customer communication" reads mid-sentence in lower case. */
const lowerFirstWord = (s: string) => (/^(?:I\b|I'|[A-Z]{2})/.test(s) ? s : s.charAt(0).toLowerCase() + s.slice(1));

export function StatusPill({ status }: { status: "confirmed" | "assumed" | "unknown" | "skipped" }) {
  const map = {
    confirmed: ["Confirmed", "text-success ring-1 ring-success/40"],
    assumed: ["Unconfirmed", "bg-accent-soft text-accent"],
    skipped: ["Skipped", "bg-surface-2 text-muted ring-1 ring-line"],
    unknown: ["Not yet known", "text-muted"],
  } as const;
  const [label, cls] = map[status];
  return <span className={cx("whitespace-nowrap rounded-full px-2 py-0.5 text-[0.6875rem] font-semibold", cls)}>{label}</span>;
}

function ResolutionPill({ resolution }: { resolution: ViewUnderstanding["problems"][number]["resolution"] }) {
  const map = {
    open: ["Investigating", "bg-accent-soft text-accent"],
    cause_confirmed: ["Cause confirmed", "text-success ring-1 ring-success/40"],
    cause_supported: ["Likely cause", "bg-surface text-ink ring-1 ring-line"],
    unknown: ["Cause unknown", "bg-surface text-muted ring-1 ring-line"],
  } as const;
  const [label, cls] = map[resolution];
  return <span className={cx("whitespace-nowrap rounded-full px-2 py-0.5 text-[0.6875rem] font-semibold", cls)}>{label}</span>;
}

function CausePill({ status }: { status: ViewCauseStatus }) {
  const map = {
    checking: ["Checking", "bg-surface text-muted ring-1 ring-line"],
    supported: ["Supported", "bg-accent-soft text-accent"],
    ruled_out: ["Ruled out", "bg-surface text-muted ring-1 ring-line"],
    confirmed: ["Confirmed by you", "text-success ring-1 ring-success/40"],
  } as const;
  const [label, cls] = map[status];
  return <span className={cx("flex-none whitespace-nowrap rounded-full px-2 py-0.5 text-[0.6875rem] font-semibold", cls)}>{label}</span>;
}
