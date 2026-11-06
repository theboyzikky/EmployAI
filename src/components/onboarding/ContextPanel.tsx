import type { Icon as PhosphorIcon } from "@phosphor-icons/react/dist/lib/types";
import {
  Icon, BriefcaseIcon, CaretDownIcon, ChatCircleDotsIcon, ClockIcon, GearSixIcon, InfoIcon, PackageIcon,
  StorefrontIcon, TargetIcon, TruckIcon, UsersThreeIcon, WarningIcon,
} from "@/components/icons";
import type { ProfileFieldKey } from "@/lib/discovery/profile";
import type { DiscoveryView } from "@/lib/discovery/view-types";
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
export function ContextPanel({ fields = DEFAULT_FIELDS }: { fields?: DiscoveryView["fields"] }) {
  const known = fields.filter(f => f.value).length;
  const missing = fields.filter(f => !f.value && !f.skipped);
  const body = (
    <>
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
            {f.value && <p className="mt-1.5 line-clamp-3 pl-[28px] text-sm font-normal leading-snug text-muted">{f.value}</p>}
          </li>
        ))}
      </ul>
      {missing.length > 0 && (
        <p className="mt-4 text-xs font-normal leading-relaxed text-muted">
          <span className="font-semibold text-ink">Still missing:</span> {missing.map(m => m.label.toLowerCase()).join(", ")}.
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
