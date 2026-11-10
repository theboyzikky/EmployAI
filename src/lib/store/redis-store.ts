import "server-only";
// The hosted demo's store: one versioned document per business in the shared Kv (Upstash Redis), plus
// one shared document (the blocklist) and two indexes (owner → businesses, public-ledger slug → business).
//
// Every write is ONE atomic compare-and-set commit: read the documents and their versions, apply the
// change to a private copy, commit only if no other instance changed them meanwhile (and every active
// lock fence still holds); otherwise re-read and re-apply (bounded). So concurrent requests on separate
// server instances can never overwrite each other's changes, and an instance whose lock expired can
// never write. Workspaces expire WORKSPACE_TTL after their last change. Any store failure throws: no
// fallback, so AI and payment operations fail closed.
import type { AgentKey } from "@/lib/catalogue/catalogue";
import type { AgentRecord, DevState, DiscoveryRepository, MessageRecord, TxOptions, WorkflowRecord } from "@/lib/discovery/store";
import type { Kv, SideOp } from "@/lib/kv/types";
import { KvUnavailableError } from "@/lib/kv/types";
import { activeFences, FenceLostError } from "./fence-context";
import { isSessionId, storeOps, type AgentPatch, type BusinessPatch, type WorkflowPatch } from "./ops";
import { storeKeys } from "./keys";
import { assembleView, splitView, type BusinessPartition, type SharedPartition } from "./partition";

export const DEFAULT_WORKSPACE_TTL_DAYS = 60;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 12;

export { storeKeys };

/** Too many concurrent changes to one business: nothing was written (the caller may retry). */
export class StoreContentionError extends Error {
  readonly code = "STORE_BUSY";
  constructor() { super("STORE_BUSY: too many concurrent changes; nothing was written."); this.name = "StoreContentionError"; }
}
export class LedgerSlugTakenError extends Error {
  constructor() { super("LEDGER_SLUG_TAKEN"); this.name = "LedgerSlugTakenError"; }
}

type Loaded = { p: BusinessPartition | null; v: number; shared: SharedPartition; sv: number; raw: string | null; sraw: string | null };

const parse = <T>(raw: string | null, what: string): T | null => {
  if (raw === null) return null;
  try { return JSON.parse(raw) as T; } catch { throw new KvUnavailableError(`The shared store holds an unreadable ${what} document.`); }
};

export class RedisStore implements DiscoveryRepository {
  private readonly ttlMs: number;
  /** Tests: called between a read and its commit (to force interleavings). */
  beforeCommit: (() => Promise<void>) | null = null;

  constructor(private readonly kv: Kv, o: { workspaceTtlDays?: number } = {}) {
    const days = o.workspaceTtlDays ?? (Number(process.env.EMPLOYAI_WORKSPACE_TTL_DAYS) || DEFAULT_WORKSPACE_TTL_DAYS);
    this.ttlMs = Math.max(1, days) * DAY_MS;
  }

  private async load(id: string): Promise<Loaded> {
    const [raw, v, sraw, sv] = await this.kv.mget([storeKeys.business(id), `${storeKeys.business(id)}:v`, storeKeys.shared, `${storeKeys.shared}:v`]);
    const p = parse<BusinessPartition>(raw, "business");
    if (p && p.business.id !== id) throw new KvUnavailableError("A business document is stored under the wrong key.");
    return { p, v: Number(v ?? "0"), shared: parse<SharedPartition>(sraw, "shared") ?? { blocklist_reports: [] }, sv: Number(sv ?? "0"), raw, sraw };
  }

  /**
   * The one write path: apply `fn` to a private view of the business and commit atomically, retrying on
   * a version conflict. Returns `fn`'s result from the attempt that committed.
   */
  private async commit<T>(id: string, fn: (view: DevState) => T, opts: TxOptions = {}): Promise<T> {
    const fences = [...activeFences(), ...(opts.fences ?? [])];
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const cur = await this.load(id);
      const view = assembleView(id, cur.p, cur.shared);
      const out = fn(view);
      const back = splitView(view, id);
      const nextRaw = back.business ? JSON.stringify(back.business) : null;
      const nextShared = JSON.stringify(back.shared);
      const sharedChanged = nextShared !== JSON.stringify(cur.shared);
      const businessChanged = nextRaw !== null && nextRaw !== cur.raw;
      const side: SideOp[] = [...(opts.side ?? [])];
      if (businessChanged) {
        const before = cur.p?.business.public_ledger_slug ?? null, after = back.business!.business.public_ledger_slug ?? null;
        if (after && after !== before) side.push({ op: "setnx", key: storeKeys.slug(after), value: id });
        if (before && before !== after) side.push({ op: "del_if", key: storeKeys.slug(before), value: id });
        if (after && after === before) side.push({ op: "setnx", key: storeKeys.slug(after), value: id }); // refresh its expiry
        side.push({ op: "sadd", key: storeKeys.owner(back.business!.business.owner_hash), member: id });     // keep the owner index alive with the workspace
        // Connection index (webhook routing): claimed for new connections, refreshed with the workspace.
        for (const c of back.business!.connections ?? []) side.push({ op: "setnx", key: storeKeys.connection(c.id), value: id });
        // Due-work index (recovery sweep): present while the business has live tasks.
        const live = (back.business!.tasks ?? []).some(t => t.status === "queued" || t.status === "running");
        side.push(live ? { op: "sadd", key: storeKeys.dueWork, member: id } : { op: "srem", key: storeKeys.dueWork, member: id });
      }
      if (!businessChanged && !sharedChanged && side.length === 0 && fences.length === 0) return out; // read-only
      if (this.beforeCommit) await this.beforeCommit();
      const r = await this.kv.cas({
        docs: [
          { key: storeKeys.business(id), expect: cur.v, value: businessChanged ? nextRaw : null },
          { key: storeKeys.shared, expect: cur.sv, value: sharedChanged ? nextShared : null, ttlMs: null },
        ],
        ttlMs: this.ttlMs, fences, side,
      });
      if (r === "ok") return out;
      if (r === "fence_lost") throw new FenceLostError();
      if (r === "side_conflict") throw new LedgerSlugTakenError();
      await new Promise(res => setTimeout(res, Math.min(200, 5 * 2 ** attempt) * Math.random()));
    }
    throw new StoreContentionError();
  }

  async createBusiness(input: { ownerHash: string; initialMessage: string }) {
    const { business, message } = storeOps.newBusiness(input);
    const p: BusinessPartition = {
      business, messages: [message], agents: [], workflows: [], runs: [], run_steps: {}, security_decisions: [], approval_requests: [],
      ledger_entries: [], activity_events: [], testnet_batches: [], payment_attempts: [],
      connections: [], inbound_events: [], action_attempts: [], tasks: [],
    };
    const r = await this.kv.cas({
      docs: [{ key: storeKeys.business(business.id), expect: 0, value: JSON.stringify(p) }], ttlMs: this.ttlMs,
      fences: activeFences(), side: [{ op: "sadd", key: storeKeys.owner(input.ownerHash), member: business.id }],
    });
    if (r === "fence_lost") throw new FenceLostError();
    if (r !== "ok") throw new StoreContentionError();   // a fresh random id can't conflict
    return business;
  }

  transact<T>(businessId: string, fn: (s: DevState) => T, opts: TxOptions = {}) { return this.commit(businessId, fn, opts); }

  async readState<T>(businessId: string, fn: (s: DevState) => T): Promise<T> {
    const cur = await this.load(businessId);
    return fn(assembleView(businessId, cur.p, cur.shared));
  }

  async businessIdForLedgerSlug(slug: string) {
    if (!slug) return null;
    return this.kv.get(storeKeys.slug(slug));
  }

  async businessIdForConnection(connectionId: string) {
    if (!connectionId) return null;
    const bid = await this.kv.get(storeKeys.connection(connectionId));
    if (!bid || !isSessionId(bid)) return null;
    const p = (await this.load(bid)).p;   // the index is only a pointer: the business must really hold it
    return p?.connections?.some(c => c.id === connectionId) ? bid : null;
  }

  async businessesWithDueWork() {
    return (await this.kv.smembers(storeKeys.dueWork)).filter(isSessionId);
  }

  async getBusiness(id: string) {
    if (!isSessionId(id)) return null;
    return (await this.load(id)).p?.business ?? null;
  }

  async listBusinessesByOwner(ownerHash: string) {
    const ids = (await this.kv.smembers(storeKeys.owner(ownerHash))).filter(isSessionId);
    if (ids.length === 0) return [];
    const raws = await this.kv.mget(ids.map(storeKeys.business));
    return raws
      .map(r => parse<BusinessPartition>(r, "business")?.business ?? null)
      .filter((b): b is NonNullable<typeof b> => !!b && b.owner_hash === ownerHash)   // the index is only a hint: ownership is re-checked
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  updateBusiness(id: string, patch: BusinessPatch) { return this.commit(id, s => storeOps.updateBusiness(s, id, patch)); }
  async listMessages(businessId: string) { return (await this.load(businessId)).p?.messages ?? []; }
  appendMessage(msg: Omit<MessageRecord, "id" | "created_at">) { return this.commit(msg.business_id, s => storeOps.appendMessage(s, msg)); }
  async listAgents(businessId: string) { return (await this.load(businessId)).p?.agents ?? []; }
  replaceAgents(businessId: string, agents: Array<Omit<AgentRecord, "id" | "business_id" | "created_at">>) { return this.commit(businessId, s => storeOps.replaceAgents(s, businessId, agents)); }
  async listWorkflows(businessId: string) { return (await this.load(businessId)).p?.workflows ?? []; }
  createWorkflow(rec: Omit<WorkflowRecord, "id" | "created_at">) { return this.commit(rec.business_id, s => storeOps.createWorkflow(s, rec)); }
  updateWorkflow(businessId: string, workflowId: string, patch: WorkflowPatch) { return this.commit(businessId, s => storeOps.updateWorkflow(s, businessId, workflowId, patch)); }
  deleteWorkflow(businessId: string, workflowId: string) { return this.commit(businessId, s => storeOps.deleteWorkflow(s, businessId, workflowId)); }
  updateAgent(businessId: string, key: AgentKey, patch: AgentPatch) { return this.commit(businessId, s => storeOps.updateAgent(s, businessId, key, patch)); }
}
