import "server-only";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentKey, CapabilityKey } from "@/lib/catalogue/catalogue";
import type { AgentDefinition } from "@/lib/catalogue/propose";
import { emptyProfile, type ProfileDoc } from "./profile";

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
export type AgentStatus = "proposed" | "approved" | "removed";
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
}

export const OWNER_COOKIE = "eai_owner";
export const newOwnerToken = () => randomBytes(32).toString("base64url");
export const hashOwnerToken = (token: string) => createHash("sha256").update(token).digest("hex");
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const isSessionId = (id: string) => UUID_RE.test(id);

type DevState = { version: 2; businesses: Record<string, BusinessRecord>; messages: Record<string, MessageRecord[]>; agents: Record<string, AgentRecord[]> };

/**
 * LOCAL DEVELOPMENT STORE — NOT PRODUCTION PERSISTENCE.
 * One JSON file in .data/ (git-ignored), atomic replace on every write, writes serialised within this
 * process. No multi-instance safety, no backups, no row-level security. It exists only until the
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
        profile: emptyProfile(), summary: null, profile_confirmed_at: null, demo: false, created_at: now, updated_at: now,
      };
      s.businesses[b.id] = b;
      s.messages[b.id] = [{ id: randomUUID(), business_id: b.id, role: "user", content: input.initialMessage, meta: { kind: "description" }, created_at: now }];
      s.agents[b.id] = [];
      return b;
    });
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

let repo: DiscoveryRepository | null = null;
export function discoveryRepository(): DiscoveryRepository {
  repo ??= new FileDevStore();
  return repo;
}
/** Test hook: use an isolated store. */
export function setDiscoveryRepository(r: DiscoveryRepository | null) { repo = r; }
