"use client";

import { Icon } from "@/components/icons";
import { layoutWorkflow, OUTCOME_LABELS, type LayoutEdge, type LayoutNode } from "@/lib/workflows/layout";
import type { Step, WorkflowDoc } from "@/lib/workflows/schema";
import { workflowStructure } from "@/lib/workflows/structure";
import type { WorkspaceAgent } from "@/lib/workflows/view-types";
import { cx } from "@/lib/cx";
import { STEP_META, stepKicker } from "./step-meta";

const NW = 248, NH = 76, GX = 112, GY = 34;
const x = (col: number) => col * (NW + GX);
const y = (row: number) => row * (NH + GY);

/** Safety-relevant steps get the accent outline so the payment guard is easy to follow. */
const GUARD = new Set(["security_check", "approval", "payment"]);

function route(a: LayoutNode, b: LayoutNode): { d: string; lx: number; ly: number; align: "left" | "center" } {
  const ax = x(a.col), ay = y(a.row), bx = x(b.col), by = y(b.row);
  if (a.col === b.col && b.row === a.row + 1) {
    return { d: `M${ax + NW / 2} ${ay + NH} V${by - 2}`, lx: ax + NW / 2 + 10, ly: ay + NH + GY / 2, align: "left" };
  }
  if (b.col > a.col && b.row === a.row) {
    return { d: `M${ax + NW} ${ay + NH / 2} H${bx - 2}`, lx: ax + NW + GX / 2, ly: ay + NH / 2, align: "center" };
  }
  if (b.col > a.col) {
    return { d: `M${ax + NW} ${ay + NH / 2} H${bx + NW / 2} V${by - 2}`, lx: ax + NW + GX / 2, ly: ay + NH / 2, align: "center" };
  }
  // Fallback (not produced by the restaurant template): out to the right-hand gutter and back in.
  const gx = Math.max(ax, bx) + NW + GX / 2;
  return { d: `M${ax + NW} ${ay + NH / 2} H${gx} V${by + NH / 2} H${bx + NW + 2}`, lx: gx, ly: (ay + by + NH) / 2, align: "center" };
}

export function WorkflowDiagram({ doc, agents, selected, onSelect }: { doc: WorkflowDoc; agents: WorkspaceAgent[]; selected: string | null; onSelect: (id: string) => void }) {
  const { disconnected } = workflowStructure(doc);
  const anchors = new Map(disconnected.filter(d => d.expected).map(d => [d.step.id, d.expected!.from.id]));
  const broken = new Set(disconnected.map(d => d.step.id));
  const { nodes, edges, rows, cols } = layoutWorkflow(doc, anchors);
  const pos = new Map(nodes.map(n => [n.id, n]));
  const byId = new Map(doc.steps.map(s => [s.id, s]));
  const width = cols * NW + (cols - 1) * GX;
  const height = rows * NH + (rows - 1) * GY;
  const ordered = [...nodes].sort((p, q) => p.row - q.row || p.col - q.col);
  // The connection a disconnected step is missing, drawn dashed in the danger colour.
  const missing: Array<LayoutEdge & { label: string }> = disconnected.filter(d => d.expected).map(d => ({
    from: d.expected!.from.id, to: d.step.id, labels: [d.expected!.outcome], primary: false,
    label: `${OUTCOME_LABELS[d.expected!.outcome] ?? d.expected!.outcome} expected`,
  }));

  return (
    <div className="overflow-x-auto pb-2">
      <div className="relative" style={{ width, height }}>
        <svg width={width} height={height} className="absolute inset-0" aria-hidden="true">
          <defs>
            <marker id="wf-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0 0 L10 5 L0 10 z" style={{ fill: "var(--color-muted)" }} />
            </marker>
            <marker id="wf-arrow-missing" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0 0 L10 5 L0 10 z" style={{ fill: "var(--color-danger)" }} />
            </marker>
          </defs>
          {edges.map(e => {
            const a = pos.get(e.from), b = pos.get(e.to);
            if (!a || !b) return null;
            return (
              <path key={`${e.from}>${e.to}`} d={route(a, b).d} fill="none" markerEnd="url(#wf-arrow)"
                style={{ stroke: "var(--color-muted)", strokeWidth: 1.5, strokeDasharray: e.primary ? undefined : "5 4", opacity: e.primary ? 0.9 : 0.8 }} />
            );
          })}
          {missing.map(e => {
            const a = pos.get(e.from), b = pos.get(e.to);
            if (!a || !b) return null;
            return <path key={`m-${e.to}`} d={route(a, b).d} fill="none" markerEnd="url(#wf-arrow-missing)" style={{ stroke: "var(--color-danger)", strokeWidth: 1.5, strokeDasharray: "2 4" }} />;
          })}
        </svg>

        {edges.map(e => {
          const a = pos.get(e.from), b = pos.get(e.to);
          const shown = e.labels.filter(l => l !== "next");
          if (!a || !b || shown.length === 0) return null;
          const r = route(a, b);
          return (
            <span key={`l-${e.from}>${e.to}`} aria-hidden="true"
              className={cx("pointer-events-none absolute whitespace-nowrap rounded-full bg-surface-2 px-2 py-0.5 text-[0.6875rem] font-semibold text-ink ring-1 ring-line",
                r.align === "center" ? "-translate-x-1/2 -translate-y-1/2" : "-translate-y-1/2")}
              style={{ left: r.lx, top: r.ly }}>
              {shown.map(l => OUTCOME_LABELS[l] ?? l).join(" / ")}
            </span>
          );
        })}
        {missing.map(e => {
          const a = pos.get(e.from), b = pos.get(e.to);
          if (!a || !b) return null;
          const r = route(a, b);
          return (
            <span key={`ml-${e.to}`} aria-hidden="true"
              className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded-full bg-surface px-2 py-0.5 text-[0.6875rem] font-semibold text-danger ring-1 ring-danger/50"
              style={{ left: r.lx, top: r.ly - 14 }}>
              {e.label}
            </span>
          );
        })}

        {/* Nodes in reading order, so keyboard order follows the flow. */}
        {ordered.map(n => {
          const s = byId.get(n.id)!;
          return <Node key={n.id} step={s} kicker={stepKicker(s, agents)} disconnected={broken.has(s.id)} active={selected === s.id} onSelect={() => onSelect(s.id)} style={{ left: x(n.col), top: y(n.row), width: NW, height: NH }} />;
        })}
      </div>
    </div>
  );
}

function Node({ step, kicker, disconnected, active, onSelect, style }: { step: Step; kicker: string; disconnected: boolean; active: boolean; onSelect: () => void; style: React.CSSProperties }) {
  const meta = STEP_META[step.type];
  const end = step.type === "end";
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      aria-label={disconnected ? `${step.title} (not connected: nothing leads to this step)` : undefined}
      className={cx(
        "icon-host absolute flex items-center gap-3 rounded-2xl border bg-surface px-3 text-left shadow-[var(--eai-shadow-card)] transition-colors",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-solid",
        disconnected
          ? cx("border-dashed border-danger", active && "ring-2 ring-danger/60")
          : active ? "border-accent-solid ring-2 ring-accent-solid" : GUARD.has(step.type) ? "border-accent-line hover:border-accent-solid" : "border-line hover:border-accent-line",
        end && !disconnected && "bg-surface-2",
      )}
      style={style}
    >
      <span className={cx("inline-flex h-9 w-9 flex-none items-center justify-center rounded-xl",
        disconnected ? "bg-surface-2 text-danger" : GUARD.has(step.type) ? "bg-accent-soft text-accent" : end ? "bg-surface text-muted ring-1 ring-line" : "bg-surface-2 text-ink")}>
        <Icon icon={meta.icon} size={18} />
      </span>
      <span className="min-w-0 flex-1">
        <span className={cx("block text-[0.6875rem] font-semibold uppercase tracking-[0.06em]", disconnected ? "text-danger" : "text-muted")}>
          {disconnected ? "Not connected" : kicker}
        </span>
        <span className="line-clamp-2 block text-sm font-semibold leading-snug text-ink">{step.title}</span>
      </span>
    </button>
  );
}
