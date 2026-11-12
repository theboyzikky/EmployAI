import "server-only";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { dataDir } from "@/lib/data-dir";
import type { AgentKey, CapabilityKey } from "@/lib/catalogue/catalogue";
import type { AgentDefinition } from "@/lib/catalogue/propose";
import { emptyProfile, type ProfileDoc } from "./profile";
import { emptyCaseFile } from "./casefile";
import type { DemoScenario } from "@/lib/workflows/demo-data";
import type { ValidationResult, WorkflowDoc, WorkflowStatus } from "@/lib/workflows/schema";
import type { BlocklistReport } from "@/lib/security/blocklist";
import type { ActionAttemptRecord, ConnectionRecord, InboundEventRecord } from "@/lib/integrations/records";
import type { TaskRecord } from "@/lib/automation/records";
import type { WorkforceState } from "@/lib/workforce/plan";
import type { ContentItem, Product } from "@/lib/content/model";
import type { Conversation, MessagingSettings } from "@/lib/messaging/model";
import type { ActivityEvent, ApprovalRecord, LedgerRecord, PaymentAttempt, RunRecord, RunStepRecord, SecurityDecisionRecord, TestnetBatch } from "@/lib/runs/types";
import { getKv, isSharedStore, MemoryKv } from "@/lib/kv";
import type { Fence, SideOp } from "@/lib/kv/types";
import { activeFences, FenceLostError } from "@/lib/store/fence-context";
import { storeOps, type AgentPatch, type BusinessPatch, type WorkflowPatch } from "@/lib/store/ops";
import { assembleView, extractBusiness, extractShared, mergeIntoFull, splitView } from "@/lib/store/partition";
import { RedisStore } from "@/lib/store/redis-store";

/*
 * Records mirror the APPROVED database design (docs/architecture/03-database-design.md), so the
 * Supabase implementation can replace the development store without redesigning discovery:
 *   businesses  → BusinessRecord  (the business row doubles as the discovery session)
 *   messages    → MessageRecord   (the first `user` row is the hero message, stored verbatim)
 *   agents      → AgentRecord     (proposed / approved / removed; nothing executes in M2)
 * Until Supabase Auth exists, ownership is an httpOnly cookie token whose SHA-256 is stored as
 * `owner_hash` (stand-in for `owner_id = auth.uid()`).
 */
export type BusinessStatus = "discovering" | "team_proposed" | "active";
export type BusinessRecord = {
  id: string;
  owner_hash: string;
  name: string | null;
  business_type: string | null;
  status: BusinessStatus;
  profile: ProfileDoc;
  summary: string | null;
  profile_confirmed_at: string | null;
  demo: boolean;
  /** Approved column. Restaurant DEMO data (fictional, labelled), kept apart from the owner's profile. */
  scenario_data?: DemoScenario | null;
  /** M4 (doc 03 column): the in-app kill switch. Absent means off; existing records are never rewritten. */
  kill_switch?: boolean;
  kill_switch_changed_at?: string | null;
  /** M7: the public ledger's unguessable slug; absent or null = private (the default). */
  public_ledger_slug?: string | null;
  /** Platform: the planned/approved AI workforce (skills, permissions, autonomy). */
  workforce?: WorkforceState | null;
  /** Platform: products and facts the owner supplied (the only facts content may use). */
  products?: Product[];
  /** Platform: what the support employee may say (owner-approved knowledge) and whether replies need approval. */
  messaging?: MessagingSettings | null;
  created_at: string;
  updated_at: string;
};
export type MessageKind = "description" | "answer" | "question" | "insight" | "analysis" | "note";
export type MessageRecord = {
  id: string;
  business_id: string;
  role: "user" | "assistant";
  content: string;
  meta: {
    kind: MessageKind;
    client_message_id?: string;  // idempotency for retried sends
    provider?: string; model?: string; mode?: "offline-demo" | "live";
    tokens?: { input: number; output: number }; cost_usd?: number;
  };
  created_at: string;
};
/** M4: `paused` (doc 03 value) stops the agent's steps; the agent stays part of the approved team. */
export type AgentStatus = "proposed" | "approved" | "removed" | "paused";
export type AgentRecord = {
  id: string;
  business_id: string;
  key: AgentKey;
  name: string;
  capability: CapabilityKey;
  definition: AgentDefinition;
  executable: boolean;
  status: AgentStatus;
  approved_at: string | null;
  near_account_id: null;
  created_at: string;
};

/** Mirrors approved table 4 `workflows`. M3: draft → approved (owner) → superseded by a newer approval. */
export type WorkflowRecord = {
  id: string;
  business_id: string;
  name: string;
  version: number;
  steps: WorkflowDoc;            // jsonb: the whole validated workflow document, including settings
  validation: ValidationResult;  // jsonb
  status: WorkflowStatus;
  approved_at: string | null;
  /**
   * M4 · D18: sha256 of the canonical approved document, recorded at approval. Absent on approvals made
   * before M4 (legacy): those are never back-filled and need the documented re-approval to run.
   */
  approval_fingerprint?: string | null;
  fingerprint_alg?: string | null;
  created_at: string;
};

export interface DiscoveryRepository {
  createBusiness(input: { ownerHash: string; initialMessage: string }): Promise<BusinessRecord>;
  getBusiness(id: string): Promise<BusinessRecord | null>;
  listBusinessesByOwner(ownerHash: string): Promise<BusinessRecord[]>;
  updateBusiness(id: string, patch: Partial<Omit<BusinessRecord, "id" | "owner_hash" | "created_at">>): Promise<BusinessRecord>;
  listMessages(businessId: string): Promise<MessageRecord[]>;
  appendMessage(msg: Omit<MessageRecord, "id" | "created_at">): Promise<MessageRecord>;
  listAgents(businessId: string): Promise<AgentRecord[]>;
  replaceAgents(businessId: string, agents: Array<Omit<AgentRecord, "id" | "business_id" | "created_at">>): Promise<AgentRecord[]>;
  updateAgent(businessId: string, key: AgentKey, patch: Partial<Pick<AgentRecord, "definition" | "status" | "approved_at">>): Promise<AgentRecord>;
  listWorkflows(businessId: string): Promise<WorkflowRecord[]>;
  createWorkflow(rec: Omit<WorkflowRecord, "id" | "created_at">): Promise<WorkflowRecord>;
  updateWorkflow(businessId: string, workflowId: string, patch: Partial<Pick<WorkflowRecord, "steps" | "validation" | "status" | "approved_at" | "approval_fingerprint" | "fingerprint_alg">>): Promise<WorkflowRecord>;
  deleteWorkflow(businessId: string, workflowId: string): Promise<void>;
  /**
   * M4: one read-modify-write on the LATEST stored state of ONE business (plus the shared partition:
   * the blocklist), atomic and serialised against every other write to that business. `fn` must be
   * synchronous and may run more than once (the shared store retries on a version conflict), so it
   * must not have side effects outside the state it is given. Touching another business is a
   * ScopeViolation. `opts.fences` (and any fence of the surrounding lock) must still hold at commit,
   * and `opts.side` writes are applied in the same atomic step.
   */
  transact<T>(businessId: string, fn: (s: DevState) => T, opts?: TxOptions): Promise<T>;
  /** M4: read-only access to a fresh copy of one business's state (changes to it are never written). */
  readState<T>(businessId: string, fn: (s: DevState) => T): Promise<T>;
  /** M7: the business whose public ledger has this slug, if any (the slug index). */
  businessIdForLedgerSlug(slug: string): Promise<string | null>;
  /** P0: the business that owns this integration connection, if any (the connection index; re-checked). */
  businessIdForConnection(connectionId: string): Promise<string | null>;
  /** The live connection that answers for an external identity (route key), if any (re-checked). */
  connectionForRouteKey(routeKey: string): Promise<{ businessId: string; connectionId: string } | null>;
  /** P0: businesses that may have due automation tasks (a hint for the recovery sweep; never trusted alone). */
  businessesWithDueWork(): Promise<string[]>;
}

export type TxOptions = { fences?: Fence[]; side?: SideOp[] };

export const OWNER_COOKIE = "eai_owner";
export const newOwnerToken = () => randomBytes(32).toString("base64url");
export const hashOwnerToken = (token: string) => createHash("sha256").update(token).digest("hex");
export { isSessionId } from "@/lib/store/ops";
import { isSessionId } from "@/lib/store/ops";

export type DevState = {
  version: 2;
  businesses: Record<string, BusinessRecord>;
  messages: Record<string, MessageRecord[]>;
  agents: Record<string, AgentRecord[]>;
  workflows?: Record<string, WorkflowRecord[]>;
  // M4 (all optional and additive: absent means empty; nothing existing is rewritten). Keyed by business
  // id, except run_steps (keyed by run id). security_decisions, ledger_entries and activity_events are
  // APPEND-ONLY: the run repository exposes no update or delete for them.
  runs?: Record<string, RunRecord[]>;
  run_steps?: Record<string, RunStepRecord[]>;
  security_decisions?: Record<string, SecurityDecisionRecord[]>;
  approval_requests?: Record<string, ApprovalRecord[]>;
  ledger_entries?: Record<string, LedgerRecord[]>;
  activity_events?: Record<string, ActivityEvent[]>;
  // M5 (additive, keyed by business id). Payment attempts hold the write-ahead record of every signed
  // testnet transaction; they are never deleted.
  testnet_batches?: Record<string, TestnetBatch[]>;
  payment_attempts?: Record<string, PaymentAttempt[]>;
  // M6: the SHARED blocklist (one list for every workspace, by design: requirement X2d).
  blocklist_reports?: BlocklistReport[];
  // P0 platform (additive, keyed by business id): integration connections (secrets encrypted), inbound
  // events (deduplicated, untrusted), outbound action attempts (write-ahead) and automation tasks.
  connections?: Record<string, ConnectionRecord[]>;
  inbound_events?: Record<string, InboundEventRecord[]>;
  action_attempts?: Record<string, ActionAttemptRecord[]>;
  tasks?: Record<string, TaskRecord[]>;
  content_items?: Record<string, ContentItem[]>;
  /** Platform: customer conversations across connected channels (src/lib/messaging). */
  conversations?: Record<string, Conversation[]>;
};

/**
 * LOCAL DEVELOPMENT STORE — NOT PRODUCTION PERSISTENCE.
 * One JSON file in .data/ (git-ignored), atomic replace on every write, writes serialised within this
 * process. SINGLE-PROCESS ONLY: no multi-instance or multi-process safety, no backups, no row-level
 * security. The hosted demo uses the shared store instead (src/lib/store/redis-store.ts); both keep
 * the same business scoping, fences and side writes, so the whole test suite exercises those rules.
 */
export class FileDevStore implements DiscoveryRepository {
  private readonly file: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(dir = dataDir()) {
    this.file = path.join(dir, "dev-store.json");
  }

  private async read(): Promise<DevState> {
    try {
      return JSON.parse(await readFile(this.file, "utf8")) as DevState;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      return migrateM1Sessions(path.dirname(this.file));
    }
  }

  private async write(s: DevState) {
    await mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(s), "utf8");
    await rename(tmp, this.file); // atomic replace
  }

  /**
   * Read-modify-write, serialised within this process. Fences (the surrounding lock's, plus `opts`)
   * are checked and side writes applied against the in-process lock store right before the write,
   * with no await in between, so a lost lock writes nothing.
   */
  private mutate<T>(fn: (s: DevState) => T, opts: TxOptions = {}): Promise<T> {
    const fences = [...activeFences(), ...(opts.fences ?? [])];
    const run = this.queue.then(async () => {
      const s = await this.read();
      const out = fn(s);
      if (fences.length || opts.side?.length) {
        const kv = getKv();
        if (!(kv instanceof MemoryKv)) throw new Error("FileDevStore fences need the in-process lock store");
        if (kv.casSync({ docs: [], ttlMs: null, fences, side: opts.side }) !== "ok") throw new FenceLostError();
      }
      await this.write(s);
      return out;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async snapshot(): Promise<DevState> {
    await this.queue.catch(() => undefined);
    return this.read();
  }

  createBusiness(input: { ownerHash: string; initialMessage: string }) {
    return this.mutate(s => {
      const { business, message } = storeOps.newBusiness(input);
      s.businesses[business.id] = business;
      s.messages[business.id] = [message];
      s.agents[business.id] = [];
      return business;
    });
  }

  /** One serialised read-modify-write on ONE business's view of the latest stored state. */
  transact<T>(businessId: string, fn: (s: DevState) => T, opts: TxOptions = {}): Promise<T> {
    return this.mutate(full => {
      const view = assembleView(businessId, extractBusiness(full, businessId), extractShared(full));
      const out = fn(view);
      const back = splitView(view, businessId);
      mergeIntoFull(full, businessId, back.business, back.shared);
      return out;
    }, opts);
  }

  /** A fresh, private copy of one business's view; nothing done to it is written. */
  async readState<T>(businessId: string, fn: (s: DevState) => T): Promise<T> {
    const full = await this.snapshot();
    return fn(assembleView(businessId, extractBusiness(full, businessId), extractShared(full)));
  }

  async businessIdForLedgerSlug(slug: string) {
    if (!slug) return null;
    const b = Object.values((await this.snapshot()).businesses).find(x => !!x.public_ledger_slug && x.public_ledger_slug === slug);
    return b?.id ?? null;
  }

  async businessIdForConnection(connectionId: string) {
    if (!connectionId) return null;
    const s = await this.snapshot();
    for (const [bid, list] of Object.entries(s.connections ?? {})) if (s.businesses[bid] && list.some(c => c.id === connectionId)) return bid;
    return null;
  }

  async connectionForRouteKey(routeKey: string) {
    if (!routeKey) return null;
    const s = await this.snapshot();
    for (const [bid, list] of Object.entries(s.connections ?? {})) {
      const c = s.businesses[bid] ? list.find(x => x.status !== "disconnected" && (x.route_keys ?? []).includes(routeKey)) : null;
      if (c) return { businessId: bid, connectionId: c.id };
    }
    return null;
  }

  async businessesWithDueWork() {
    const s = await this.snapshot();
    return Object.entries(s.tasks ?? {}).filter(([bid, list]) => s.businesses[bid] && list.some(t => t.status === "queued" || t.status === "running")).map(([bid]) => bid);
  }

  async getBusiness(id: string) {
    if (!isSessionId(id)) return null;
    return (await this.snapshot()).businesses[id] ?? null;
  }

  async listBusinessesByOwner(ownerHash: string) {
    const s = await this.snapshot();
    return Object.values(s.businesses).filter(b => b.owner_hash === ownerHash).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  updateBusiness(id: string, patch: BusinessPatch) { return this.mutate(s => storeOps.updateBusiness(s, id, patch)); }
  async listMessages(businessId: string) { return (await this.snapshot()).messages[businessId] ?? []; }
  appendMessage(msg: Omit<MessageRecord, "id" | "created_at">) { return this.mutate(s => storeOps.appendMessage(s, msg)); }
  async listAgents(businessId: string) { return (await this.snapshot()).agents[businessId] ?? []; }
  replaceAgents(businessId: string, agents: Array<Omit<AgentRecord, "id" | "business_id" | "created_at">>) { return this.mutate(s => storeOps.replaceAgents(s, businessId, agents)); }
  async listWorkflows(businessId: string) { return ((await this.snapshot()).workflows ?? {})[businessId] ?? []; }
  createWorkflow(rec: Omit<WorkflowRecord, "id" | "created_at">) { return this.mutate(s => storeOps.createWorkflow(s, rec)); }
  updateWorkflow(businessId: string, workflowId: string, patch: WorkflowPatch) { return this.mutate(s => storeOps.updateWorkflow(s, businessId, workflowId, patch)); }
  deleteWorkflow(businessId: string, workflowId: string) { return this.mutate(s => storeOps.deleteWorkflow(s, businessId, workflowId)); }
  updateAgent(businessId: string, key: AgentKey, patch: AgentPatch) { return this.mutate(s => storeOps.updateAgent(s, businessId, key, patch)); }
}

/** One-time conversion of the M1 development file (.data/discovery-sessions.json), if present. */
function migrateM1Sessions(dir: string): DevState {
  const state: DevState = { version: 2, businesses: {}, messages: {}, agents: {} };
  const old = path.join(dir, "discovery-sessions.json");
  if (!existsSync(old)) return state;
  try {
    const sessions = JSON.parse(readFileSync(old, "utf8")) as Record<string, { id: string; ownerHash: string; initialMessage: string; createdAt: string; messages: Array<{ id: string; role: string; content: string; createdAt: string }> }>;
    for (const s of Object.values(sessions)) {
      state.businesses[s.id] = {
        id: s.id, owner_hash: s.ownerHash, name: null, business_type: null, status: "discovering", profile: emptyProfile(),
        summary: null, profile_confirmed_at: null, demo: false, created_at: s.createdAt, updated_at: s.createdAt,
      };
      state.messages[s.id] = s.messages.map((m, i) => ({
        id: m.id, business_id: s.id, role: m.role === "user" ? "user" : "assistant", content: m.content,
        meta: { kind: i === 0 ? "description" : m.role === "user" ? "answer" : "note" }, created_at: m.createdAt,
      }));
      state.agents[s.id] = [];
    }
  } catch { /* unreadable dev file: start empty */ }
  return state;
}

// One store instance per server process (on globalThis), so every route module shares ONE write queue.
// The hosted demo (Upstash configured, or any Vercel deployment) always uses the shared store; on Vercel
// without Upstash every operation fails closed (see src/lib/kv/index.ts).
const REPO = Symbol.for("employai.discoveryRepository");
const holder = globalThis as unknown as { [REPO]?: DiscoveryRepository | null };
export function discoveryRepository(): DiscoveryRepository {
  holder[REPO] ??= isSharedStore() ? new RedisStore(getKv()) : new FileDevStore();
  return holder[REPO]!;
}
/** Test hook: use an isolated store. */
export function setDiscoveryRepository(r: DiscoveryRepository | null) { holder[REPO] = r; }
