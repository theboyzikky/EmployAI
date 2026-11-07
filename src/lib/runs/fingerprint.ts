// M4 · D18: the approval fingerprint binds an approval to the EXACT workflow version. It is sha256 over a
// canonical JSON encoding (keys sorted, no whitespace) of { workflow_id, version, steps document }, so
// any change to a step, an edge, an agent, a tool, a setting or a note produces a different fingerprint.
// node:crypto only (D14: no new dependencies).
import { createHash } from "node:crypto";

export const FINGERPRINT_ALG = "sha256-canonical-json-v1";

/** Deterministic JSON: object keys sorted at every level; `undefined` members dropped, as JSON.stringify does. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("NON_FINITE_NUMBER");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(v => (v === undefined ? "null" : canonicalJson(v))).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export const sha256Hex = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

export function workflowFingerprint(w: { id: string; version: number; steps: unknown }): string {
  return sha256Hex(canonicalJson({ workflow_id: w.id, version: w.version, steps: w.steps }));
}
