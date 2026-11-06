// Grid layout for the read-only workflow diagram. The "main line" follows each step's primary outcome
// (next / yes / allow / approved); other outcomes branch to the right. Pure and deterministic.
import type { WorkflowDoc } from "./schema";

export const PRIMARY_OUTCOMES = new Set(["next", "yes", "allow", "approved"]);

export type LayoutNode = { id: string; row: number; col: number };
export type LayoutEdge = { from: string; to: string; labels: string[]; primary: boolean };

/**
 * `anchors` (optional) places a disconnected step beside the step that normally leads to it, so the
 * missing connection can be drawn; without an anchor it goes to the bottom.
 */
export function layoutWorkflow(doc: WorkflowDoc, anchors: Map<string, string> = new Map()): { nodes: LayoutNode[]; edges: LayoutEdge[]; rows: number; cols: number } {
  const byId = new Map(doc.steps.map(s => [s.id, s]));
  const pos = new Map<string, LayoutNode>();
  const taken = new Set<string>();
  const place = (id: string, row: number, col: number) => {
    while (taken.has(`${row}:${col}`)) col++;
    const n = { id, row, col };
    pos.set(id, n); taken.add(`${row}:${col}`);
    return n;
  };
  const primaryNext = (id: string) => Object.entries(byId.get(id)?.next ?? {}).find(([o]) => PRIMARY_OUTCOMES.has(o))?.[1];

  // Main line
  let row = 0;
  for (let id: string | undefined = doc.start; id && !pos.has(id); id = primaryNext(id)) place(id, row++, 0);
  // Branches, placed beside the step they leave from, continuing downwards along their own primary line.
  for (const s of doc.steps) {
    const from = pos.get(s.id);
    if (!from) continue;
    for (const [o, to] of Object.entries(s.next)) {
      if (PRIMARY_OUTCOMES.has(o) || pos.has(to)) continue;
      let r = from.row, c = from.col + 1;
      for (let id: string | undefined = to; id && !pos.has(id); id = primaryNext(id)) c = place(id, r++, c).col;
    }
  }
  // Anything still unplaced (only in invalid workflows): beside its anchor if known, else at the bottom.
  for (const s of doc.steps) {
    if (pos.has(s.id)) continue;
    const a = pos.get(anchors.get(s.id) ?? "");
    if (a) place(s.id, a.row, a.col + 1);
    else place(s.id, row++, 0);
  }

  const merged = new Map<string, LayoutEdge>();
  for (const s of doc.steps) {
    for (const [o, to] of Object.entries(s.next)) {
      const key = `${s.id}>${to}`;
      const e = merged.get(key) ?? { from: s.id, to, labels: [], primary: false };
      e.labels.push(o);
      e.primary ||= PRIMARY_OUTCOMES.has(o);
      merged.set(key, e);
    }
  }
  const nodes = [...pos.values()];
  return { nodes, edges: [...merged.values()], rows: Math.max(...nodes.map(n => n.row)) + 1, cols: Math.max(...nodes.map(n => n.col)) + 1 };
}

/** Human-readable outcome names. */
export const OUTCOME_LABELS: Record<string, string> = {
  next: "then", yes: "yes", no: "no", allow: "ALLOW", warn: "WARN", block: "BLOCK", approved: "approved", rejected: "declined",
};
