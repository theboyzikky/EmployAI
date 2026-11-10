import "server-only";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentKey, CapabilityKey } from "@/lib/catalogue/catalogue";
import type { AgentDefinition } from "@/lib/catalogue/propose";
import { emptyProfile, type ProfileDoc } from "./profile";
import { emptyCaseFile } from "./casefile";
import type { DemoScenario } from "@/lib/workflows/demo-data";
import type { ValidationResult, WorkflowDoc, WorkflowStatus } from "@/lib/workflows/schema";
import type { BlocklistReport } from "@/lib/security/blocklist";
import type { ActivityEvent, ApprovalRecord, LedgerRecord, PaymentAttempt, RunRecord, RunStepRecord, SecurityDecisionRecord, TestnetBatch } from "@/lib/runs/types";

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
   * M4: one read-modify-write on the LATEST stored state, through the same serialised write queue as
   * every other write. `fn` must be synchronous; whatever it changes is written atomically.
   */
  transact<T>(fn: (s: DevState) => T): Promise<T>;
  /** M4: read-only access to a fresh copy of the stored state (changes to it are never written). */
  readState<T>(fn: (s: DevState) => T): Promise<T>;
}

export const OWNER_COOKIE = "eai_owner";
export const newOwnerToken = () => randomBytes(32).toString("base64url");
export const hashOwnerToken = (token: string) => createHash("sha256").update(token).digest("hex");
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const isSessionId = (id: string) => UUID_RE.test(id);

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
};

/**
 * LOCAL DEVELOPMENT STORE — NOT PRODUCTION PERSISTENCE.
 * One JSON file in .data/ (git-ignored), atomic replace on every write, writes serialised within this
 * process. SINGLE-PROCESS ONLY: no multi-instance or multi-process safety, no backups, no row-level
 * security. M4 relies on this queue for control requests and compare-and-set writes (plan §5.6); those
 * guarantees hold only inside one server process. It exists only until the
 * Supabase project is created, when a Supabase implementation of DiscoveryRepository replaces it.
 */
export class FileDevStore implements DiscoveryRepository {
  private readonly file: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(dir = path.join(process.cwd(), ".data")) {
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

  /** Read-modify-write, serialised within this process. */
  private mutate<T>(fn: (s: DevState) => T): Promise<T> {
    const run = this.queue.then(async () => {
      const s = await this.read();
      const out = fn(s);
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
      const now = new Date().toISOString();
      const b: BusinessRecord = {
        id: randomUUID(), owner_hash: input.ownerHash, name: null, business_type: null, status: "discovering",
        profile: { ...emptyProfile(), case_file: emptyCaseFile("native") }, summary: null, profile_confirmed_at: null, demo: false, scenario_data: null, created_at: now, updated_at: now,
      };
      s.businesses[b.id] = b;
      s.messages[b.id] = [{ id: randomUUID(), business_id: b.id, role: "user", content: input.initialMessage, meta: { kind: "description" }, created_at: now }];
      s.agents[b.id] = [];
      return b;
    });
  }

  /** M4: one serialised read-modify-write on the latest stored state (see the interface). */
  transact<T>(fn: (s: DevState) => T): Promise<T> {
    return this.mutate(fn);
  }

  /** M4: a fresh, private copy of the stored state; nothing done to it is written. */
  async readState<T>(fn: (s: DevState) => T): Promise<T> {
    return fn(await this.snapshot());
  }

  async getBusiness(id: string) {
    if (!isSessionId(id)) return null;
    return (await this.snapshot()).businesses[id] ?? null;
  }

  async listBusinessesByOwner(ownerHash: string) {
    const s = await this.snapshot();
    return Object.values(s.businesses).filter(b => b.owner_hash === ownerHash).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  updateBusiness(id: string, patch: Partial<Omit<BusinessRecord, "id" | "owner_hash" | "created_at">>) {
    return this.mutate(s => {
      const b = s.businesses[id];
      if (!b) throw new Error("NOT_FOUND");
      Object.assign(b, patch, { updated_at: new Date().toISOString() });
      return b;
    });
  }

  async listMessages(businessId: string) {
    return (await this.snapshot()).messages[businessId] ?? [];
  }

  appendMessage(msg: Omit<MessageRecord, "id" | "created_at">) {
    return this.mutate(s => {
      if (!s.businesses[msg.business_id]) throw new Error("NOT_FOUND");
      const list = (s.messages[msg.business_id] ??= []);
      const cid = msg.meta.client_message_id;
      const dup = cid ? list.find(m => m.meta.client_message_id === cid) : undefined;
      if (dup) return dup; // retried send: never store the same message twice
      const rec: MessageRecord = { ...msg, id: randomUUID(), created_at: new Date().toISOString() };
      list.push(rec);
      s.businesses[msg.business_id].updated_at = rec.created_at;
      return rec;
    });
  }

  async listAgents(businessId: string) {
    return (await this.snapshot()).agents[businessId] ?? [];
  }

  replaceAgents(businessId: string, agents: Array<Omit<AgentRecord, "id" | "business_id" | "created_at">>) {
    return this.mutate(s => {
      const now = new Date().toISOString();
      s.agents[businessId] = agents.map(a => ({ ...a, id: randomUUID(), business_id: businessId, created_at: now }));
      return s.agents[businessId];
    });
  }

  async listWorkflows(businessId: string) {
    return ((await this.snapshot()).workflows ?? {})[businessId] ?? [];
  }

  createWorkflow(rec: Omit<WorkflowRecord, "id" | "created_at">) {
    return this.mutate(s => {
      if (!s.businesses[rec.business_id]) throw new Error("NOT_FOUND");
      const all = (s.workflows ??= {});
      const w: WorkflowRecord = { ...rec, id: randomUUID(), created_at: new Date().toISOString() };
      (all[rec.business_id] ??= []).push(w);
      return w;
    });
  }

  updateWorkflow(businessId: string, workflowId: string, patch: Partial<Pick<WorkflowRecord, "steps" | "validation" | "status" | "approved_at" | "approval_fingerprint" | "fingerprint_alg">>) {
    return this.mutate(s => {
      const w = ((s.workflows ?? {})[businessId] ?? []).find(x => x.id === workflowId);
      if (!w) throw new Error("NOT_FOUND");
      Object.assign(w, patch);
      return w;
    });
  }

  deleteWorkflow(businessId: string, workflowId: string) {
    return this.mutate(s => {
      const list = (s.workflows ?? {})[businessId] ?? [];
      const i = list.findIndex(x => x.id === workflowId);
      if (i < 0) throw new Error("NOT_FOUND");
      list.splice(i, 1);
    });
  }

  updateAgent(businessId: string, key: AgentKey, patch: Partial<Pick<AgentRecord, "definition" | "status" | "approved_at">>) {
    return this.mutate(s => {
      const a = (s.agents[businessId] ?? []).find(x => x.key === key);
      if (!a) throw new Error("NOT_FOUND");
      Object.assign(a, patch);
      return a;
    });
  }
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
const REPO = Symbol.for("employai.discoveryRepository");
const holder = globalThis as unknown as { [REPO]?: DiscoveryRepository | null };
export function discoveryRepository(): DiscoveryRepository {
  holder[REPO] ??= new FileDevStore();
  return holder[REPO]!;
}
/** Test hook: use an isolated store. */
export function setDiscoveryRepository(r: DiscoveryRepository | null) { holder[REPO] = r; }
