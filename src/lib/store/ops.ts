import { randomUUID } from "node:crypto";
import type { AgentKey } from "@/lib/catalogue/catalogue";
import type { AgentRecord, BusinessRecord, DevState, MessageRecord, WorkflowRecord } from "@/lib/discovery/store";
import { emptyCaseFile } from "@/lib/discovery/casefile";
import { emptyProfile } from "@/lib/discovery/profile";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const isSessionId = (id: string) => UUID_RE.test(id);

// ---- write operations, shared by both stores --------------------------------------------------------
// Each one changes a DevState (the whole file locally, or one business's view in the shared store) and
// returns its result. They are synchronous so the shared store can safely re-run them on a conflict.
export type BusinessPatch = Partial<Omit<BusinessRecord, "id" | "owner_hash" | "created_at">>;
export type WorkflowPatch = Partial<Pick<WorkflowRecord, "steps" | "validation" | "status" | "approved_at" | "approval_fingerprint" | "fingerprint_alg">>;
export type AgentPatch = Partial<Pick<AgentRecord, "definition" | "status" | "approved_at">>;

export const storeOps = {
  newBusiness(input: { ownerHash: string; initialMessage: string }): { business: BusinessRecord; message: MessageRecord } {
    const now = new Date().toISOString();
    const business: BusinessRecord = {
      id: randomUUID(), owner_hash: input.ownerHash, name: null, business_type: null, status: "discovering",
      profile: { ...emptyProfile(), case_file: emptyCaseFile("native") }, summary: null, profile_confirmed_at: null, demo: false, scenario_data: null, created_at: now, updated_at: now,
    };
    return { business, message: { id: randomUUID(), business_id: business.id, role: "user", content: input.initialMessage, meta: { kind: "description" }, created_at: now } };
  },
  updateBusiness(s: DevState, id: string, patch: BusinessPatch): BusinessRecord {
    const b = s.businesses[id];
    if (!b) throw new Error("NOT_FOUND");
    Object.assign(b, patch, { updated_at: new Date().toISOString() });
    return b;
  },
  appendMessage(s: DevState, msg: Omit<MessageRecord, "id" | "created_at">): MessageRecord {
    if (!s.businesses[msg.business_id]) throw new Error("NOT_FOUND");
    const list = (s.messages[msg.business_id] ??= []);
    const cid = msg.meta.client_message_id;
    const dup = cid ? list.find(m => m.meta.client_message_id === cid) : undefined;
    if (dup) return dup; // retried send: never store the same message twice
    const rec: MessageRecord = { ...msg, id: randomUUID(), created_at: new Date().toISOString() };
    list.push(rec);
    s.businesses[msg.business_id].updated_at = rec.created_at;
    return rec;
  },
  replaceAgents(s: DevState, businessId: string, agents: Array<Omit<AgentRecord, "id" | "business_id" | "created_at">>): AgentRecord[] {
    if (!s.businesses[businessId]) throw new Error("NOT_FOUND");
    const now = new Date().toISOString();
    s.agents[businessId] = agents.map(a => ({ ...a, id: randomUUID(), business_id: businessId, created_at: now }));
    return s.agents[businessId];
  },
  createWorkflow(s: DevState, rec: Omit<WorkflowRecord, "id" | "created_at">): WorkflowRecord {
    if (!s.businesses[rec.business_id]) throw new Error("NOT_FOUND");
    const w: WorkflowRecord = { ...rec, id: randomUUID(), created_at: new Date().toISOString() };
    ((s.workflows ??= {})[rec.business_id] ??= []).push(w);
    return w;
  },
  updateWorkflow(s: DevState, businessId: string, workflowId: string, patch: WorkflowPatch): WorkflowRecord {
    const w = ((s.workflows ?? {})[businessId] ?? []).find(x => x.id === workflowId);
    if (!w) throw new Error("NOT_FOUND");
    Object.assign(w, patch);
    return w;
  },
  deleteWorkflow(s: DevState, businessId: string, workflowId: string): void {
    const list = (s.workflows ?? {})[businessId] ?? [];
    const i = list.findIndex(x => x.id === workflowId);
    if (i < 0) throw new Error("NOT_FOUND");
    list.splice(i, 1);
  },
  updateAgent(s: DevState, businessId: string, key: AgentKey, patch: AgentPatch): AgentRecord {
    const a = (s.agents[businessId] ?? []).find(x => x.key === key);
    if (!a) throw new Error("NOT_FOUND");
    Object.assign(a, patch);
    return a;
  },
};

