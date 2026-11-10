// One business = one partition. Every collection in DevState is keyed by business id, except run_steps
// (keyed by run id, and a run belongs to one business) and the SHARED blocklist. A business-scoped
// transaction sees exactly one business partition plus the shared partition, and may write only those:
// anything else it creates is a ScopeViolation (caught by every existing test on the file store too).
//
// Runtime imports are relative and types are `import type` only, so the migration script can run this
// file with Node's built-in TypeScript support.
import type { BusinessRecord, DevState } from "@/lib/discovery/store";

export type BusinessPartition = {
  business: BusinessRecord;
  messages: NonNullable<DevState["messages"][string]>;
  agents: NonNullable<DevState["agents"][string]>;
  workflows: NonNullable<NonNullable<DevState["workflows"]>[string]>;
  runs: NonNullable<NonNullable<DevState["runs"]>[string]>;
  /** run id → steps, for this business's runs only. */
  run_steps: NonNullable<DevState["run_steps"]>;
  security_decisions: NonNullable<NonNullable<DevState["security_decisions"]>[string]>;
  approval_requests: NonNullable<NonNullable<DevState["approval_requests"]>[string]>;
  ledger_entries: NonNullable<NonNullable<DevState["ledger_entries"]>[string]>;
  activity_events: NonNullable<NonNullable<DevState["activity_events"]>[string]>;
  testnet_batches: NonNullable<NonNullable<DevState["testnet_batches"]>[string]>;
  payment_attempts: NonNullable<NonNullable<DevState["payment_attempts"]>[string]>;
};
export type SharedPartition = { blocklist_reports: NonNullable<DevState["blocklist_reports"]> };

export class ScopeViolation extends Error {
  constructor(detail: string) { super(`SCOPE_VIOLATION: ${detail}`); this.name = "ScopeViolation"; }
}

const BY_BUSINESS = ["messages", "agents", "workflows", "runs", "security_decisions", "approval_requests", "ledger_entries", "activity_events", "testnet_batches", "payment_attempts"] as const;

/** A deep copy of one business's partition from a full state (null if the business doesn't exist). */
export function extractBusiness(s: DevState, id: string): BusinessPartition | null {
  const business = s.businesses[id];
  if (!business) return null;
  const runs = (s.runs ?? {})[id] ?? [];
  const run_steps: BusinessPartition["run_steps"] = {};
  for (const r of runs) { const st = (s.run_steps ?? {})[r.id]; if (st) run_steps[r.id] = st; }
  return structuredClone({
    business,
    messages: s.messages[id] ?? [], agents: s.agents[id] ?? [], workflows: (s.workflows ?? {})[id] ?? [], runs, run_steps,
    security_decisions: (s.security_decisions ?? {})[id] ?? [], approval_requests: (s.approval_requests ?? {})[id] ?? [],
    ledger_entries: (s.ledger_entries ?? {})[id] ?? [], activity_events: (s.activity_events ?? {})[id] ?? [],
    testnet_batches: (s.testnet_batches ?? {})[id] ?? [], payment_attempts: (s.payment_attempts ?? {})[id] ?? [],
  });
}

export function extractShared(s: DevState): SharedPartition {
  return structuredClone({ blocklist_reports: s.blocklist_reports ?? [] });
}

/** A DevState view holding only this business (if any) and the shared partition. */
export function assembleView(id: string, p: BusinessPartition | null, shared: SharedPartition): DevState {
  const v: DevState = {
    version: 2, businesses: {}, messages: {}, agents: {}, workflows: {}, runs: {}, run_steps: {}, security_decisions: {}, approval_requests: {},
    ledger_entries: {}, activity_events: {}, testnet_batches: {}, payment_attempts: {}, blocklist_reports: structuredClone(shared.blocklist_reports),
  };
  if (!p) return v;
  const c = structuredClone(p);
  v.businesses[id] = c.business;
  v.messages[id] = c.messages; v.agents[id] = c.agents; v.workflows![id] = c.workflows; v.runs![id] = c.runs;
  v.security_decisions![id] = c.security_decisions; v.approval_requests![id] = c.approval_requests; v.ledger_entries![id] = c.ledger_entries;
  v.activity_events![id] = c.activity_events; v.testnet_batches![id] = c.testnet_batches; v.payment_attempts![id] = c.payment_attempts;
  Object.assign(v.run_steps!, c.run_steps);
  return v;
}

/**
 * Read a view back after a transaction: this business's partition and the shared partition. Throws a
 * ScopeViolation if the transaction touched any other business (or steps of a run it doesn't own).
 */
export function splitView(v: DevState, id: string): { business: BusinessPartition | null; shared: SharedPartition } {
  const foreign = (rec: Record<string, unknown> | undefined, what: string) => {
    for (const k of Object.keys(rec ?? {})) if (k !== id) throw new ScopeViolation(`${what} of another business (${k})`);
  };
  foreign(v.businesses, "business");
  for (const c of BY_BUSINESS) foreign(v[c] as Record<string, unknown> | undefined, c);
  const business = v.businesses[id];
  const runIds = new Set(((v.runs ?? {})[id] ?? []).map(r => r.id));
  for (const runId of Object.keys(v.run_steps ?? {})) if (!runIds.has(runId)) throw new ScopeViolation(`steps of a run outside this business (${runId})`);
  const shared: SharedPartition = { blocklist_reports: v.blocklist_reports ?? [] };
  if (!business) {
    for (const c of BY_BUSINESS) if (((v[c] as Record<string, unknown[]> | undefined) ?? {})[id]?.length) throw new ScopeViolation(`${c} without a business`);
    return { business: null, shared };
  }
  return {
    business: {
      business, messages: v.messages[id] ?? [], agents: v.agents[id] ?? [], workflows: (v.workflows ?? {})[id] ?? [], runs: (v.runs ?? {})[id] ?? [],
      run_steps: { ...(v.run_steps ?? {}) }, security_decisions: (v.security_decisions ?? {})[id] ?? [], approval_requests: (v.approval_requests ?? {})[id] ?? [],
      ledger_entries: (v.ledger_entries ?? {})[id] ?? [], activity_events: (v.activity_events ?? {})[id] ?? [],
      testnet_batches: (v.testnet_batches ?? {})[id] ?? [], payment_attempts: (v.payment_attempts ?? {})[id] ?? [],
    },
    shared,
  };
}

/** Write a business partition and the shared partition back into a full state (file store). */
export function mergeIntoFull(s: DevState, id: string, p: BusinessPartition | null, shared: SharedPartition): void {
  s.blocklist_reports = shared.blocklist_reports;
  if (!p) return;
  s.businesses[id] = p.business;
  s.messages[id] = p.messages; s.agents[id] = p.agents;
  (s.workflows ??= {})[id] = p.workflows; (s.runs ??= {})[id] = p.runs;
  (s.security_decisions ??= {})[id] = p.security_decisions; (s.approval_requests ??= {})[id] = p.approval_requests;
  (s.ledger_entries ??= {})[id] = p.ledger_entries; (s.activity_events ??= {})[id] = p.activity_events;
  (s.testnet_batches ??= {})[id] = p.testnet_batches; (s.payment_attempts ??= {})[id] = p.payment_attempts;
  const steps = (s.run_steps ??= {});
  for (const [runId, list] of Object.entries(p.run_steps)) steps[runId] = list;
}

/** Every business id in a full state (migration). */
export const businessIds = (s: DevState) => Object.keys(s.businesses);
