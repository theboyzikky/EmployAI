// M3 route tests: real route handlers + services + an isolated dev store. Approval only — nothing runs.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { DiscoveryView } from "@/lib/discovery/view-types";
import type { WorkspaceView } from "@/lib/workflows/view-types";

const h = vi.hoisted(() => ({ jar: new Map<string, string>(), headers: new Map<string, string>([["host", "localhost:3101"]]) }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (n: string) => (h.jar.has(n) ? { name: n, value: h.jar.get(n)! } : undefined),
    set: (n: string, v: string) => { h.jar.set(n, v); },
  }),
  headers: async () => ({ get: (n: string) => h.headers.get(n.toLowerCase()) ?? null }),
}));

import { POST as start } from "@/app/api/start/route";
import { GET as getDiscovery } from "@/app/api/w/[id]/discovery/route";
import { POST as postMessage } from "@/app/api/w/[id]/discovery/messages/route";
import { POST as analyse } from "@/app/api/w/[id]/discovery/analyse/route";
import { POST as confirm } from "@/app/api/w/[id]/discovery/confirm/route";
import { POST as propose } from "@/app/api/w/[id]/team/propose/route";
import { POST as approveTeam } from "@/app/api/w/[id]/team/approve/route";
import { GET as getWorkflows } from "@/app/api/w/[id]/workflows/route";
import { POST as generate } from "@/app/api/w/[id]/workflows/generate/route";
import { PATCH as patchWorkflow } from "@/app/api/w/[id]/workflows/[wid]/route";
import { POST as approveWorkflow } from "@/app/api/w/[id]/workflows/[wid]/approve/route";
import { POST as discard } from "@/app/api/w/[id]/workflows/[wid]/discard/route";
import { FileDevStore, discoveryRepository, setDiscoveryRepository } from "@/lib/discovery/store";
import { resetAiForTests } from "@/lib/ai";
import { blockedFetch } from "./setup";

const dir = mkdtempSync(path.join(tmpdir(), "eai-m3-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const ORIGIN = "http://localhost:3101";
const req = (method: string, body?: unknown, extra: Record<string, string> = {}) =>
  new Request(`${ORIGIN}/x`, { method, headers: { "content-type": "application/json", origin: ORIGIN, ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
const ctx = (id: string, more: Record<string, string> = {}) => ({ params: Promise.resolve({ id, ...more }) }) as never;
type WBody = { view: WorkspaceView; error?: { code: string; message: string } };
const wbody = async (r: Response) => (await r.json()) as WBody;
const dbody = async (r: Response) => (await r.json()) as { view: DiscoveryView };

beforeEach(() => {
  setDiscoveryRepository(new FileDevStore(dir));
  process.env.AI_PROVIDER = "mock";
  resetAiForTests();
  h.jar.clear();
  for (const m of ["log", "info", "warn", "error"] as const) vi.spyOn(console, m).mockImplementation(() => {});
});
afterEach(() => { delete process.env.AI_PROVIDER; resetAiForTests(); });

const say = (id: string, content?: string) => postMessage(req("POST", content === undefined ? {} : { content, client_message_id: crypto.randomUUID() }), ctx(id));

/** Runs discovery with the offline consultant up to a proposed team (not approved). */
async function proposedTeam(message: string, answers: string[]) {
  const r = await start(req("POST", { message }));
  const id = ((await r.json()) as { sessionId: string }).sessionId;
  let v = (await dbody(await say(id))).view;
  for (let i = 0; i < 12 && !v.ready; i++) v = (await dbody(await say(id, answers[i % answers.length]))).view;
  expect(v.ready).toBe(true);
  expect((await analyse(req("POST", {}), ctx(id))).status).toBe(200);
  expect((await confirm(req("POST", {}), ctx(id))).status).toBe(200);
  expect((await propose(req("POST", {}), ctx(id))).status).toBe(200);
  return id;
}
const RESTAURANT_ANSWERS = [
  "Jollof rice, fried rice and grilled chicken.", "I want to stop running out of ingredients and stop phoning suppliers every morning.",
  "Me, my sister and two cooks.", "A notebook and WhatsApp.", "We open at 11 and close at 9.", "Two market suppliers, by phone.", "Mama Nkechi's Kitchen",
];
const restaurant = () => proposedTeam("I run a small restaurant called Mama Nkechi's Kitchen. We take orders at the counter and on WhatsApp, and we often run out of rice and cooking oil because I reorder from suppliers by phone.", RESTAURANT_ANSWERS);

const gen = async (id: string) => generate(req("POST", {}), ctx(id));
const patch = (id: string, wid: string, settings: unknown) => patchWorkflow(req("PATCH", { settings }), ctx(id, { wid }));
const approve = (id: string, wid: string) => approveWorkflow(req("POST", {}), ctx(id, { wid }));
const draftOf = (v: WorkspaceView) => v.workflows.find(w => w.status === "draft")!;

describe("workflows: access and preconditions", () => {
  test("owner only: anyone else gets 404 with nothing leaked", async () => {
    const id = await restaurant();
    expect((await getWorkflows(req("GET"), ctx(id))).status).toBe(200);
    const owner = h.jar.get("eai_owner")!;
    h.jar.set("eai_owner", "y".repeat(43));
    for (const r of [await getWorkflows(req("GET"), ctx(id)), await gen(id)]) {
      expect(r.status).toBe(404);
      expect(JSON.stringify(await r.json())).not.toContain("Nkechi");
    }
    h.jar.set("eai_owner", owner);
    expect((await getWorkflows(req("GET"), ctx("not-a-uuid"))).status).toBe(404);
    expect((await generate(req("POST", {}, { origin: "https://evil.example" }), ctx(id))).status).toBe(403);
  });

  test("nothing is built before the team is approved", async () => {
    const id = await restaurant();
    const r = await gen(id);
    expect(r.status).toBe(409);
    const b = await wbody(r);
    expect(b.error!.code).toBe("TEAM_NOT_APPROVED");
    expect(b.view.workflows).toEqual([]);
  });

  test("non-restaurant businesses stay in Preview: no workflow, no demo data", async () => {
    const id = await proposedTeam("I run a hair salon called Glow Studio. Customers book appointments by phone and WhatsApp, and we often get double bookings and no-shows.",
      ["Haircuts, braiding and nails.", "I want fewer no-shows and no double bookings.", "Me and three stylists.", "A paper diary and WhatsApp.", "We open 9 to 7.", "Glow Studio"]);
    expect((await approveTeam(req("POST", {}), ctx(id))).status).toBe(200);
    const r = await gen(id);
    expect(r.status).toBe(409);
    const b = await wbody(r);
    expect(b.error!.code).toBe("PREVIEW_ONLY");
    expect(b.view).toMatchObject({ runnable: false, demoData: null, workflows: [] });
    expect(b.view.agents.every(a => !a.runnable)).toBe(true);
    // Discovery shows the same Preview state.
    const dv = (await dbody(await getDiscovery(req("GET"), ctx(id)))).view;
    expect(dv.runnable).toBe(false);
    expect(dv.team!.agents.every(a => !a.executable)).toBe(true);
  });
});

describe("workflows: generate → adjust → approve (nothing runs)", () => {
  test("the full lifecycle, with versioning and supersession", async () => {
    const id = await restaurant();
    expect((await approveTeam(req("POST", {}), ctx(id))).status).toBe(200);

    // Generate: one valid draft, plus clearly separated demo data.
    let v = (await wbody(await gen(id))).view;
    expect(v.workflows).toHaveLength(1);
    let d = draftOf(v);
    expect(d).toMatchObject({ version: 1, status: "draft", approvedAt: null });
    expect(d.validation.valid).toBe(true);
    expect(v.demoData).toMatchObject({ demo: true, kind: "restaurant_demo" });
    const discovery = JSON.stringify((await dbody(await getDiscovery(req("GET"), ctx(id)))).view);
    expect(discovery).not.toContain("Mainland Grains"); // demo data never enters the business profile

    // Regenerating replaces the draft (still one draft).
    v = (await wbody(await gen(id))).view;
    expect(v.workflows.filter(w => w.status === "draft")).toHaveLength(1);
    d = draftOf(v);

    // Settings validation.
    expect((await patch(id, d.id, { approval_threshold_ngn: 300_000, max_payment_ngn: 200_000 })).status).toBe(400);
    expect((await patch(id, d.id, { approval_threshold_ngn: 10 })).status).toBe(400);
    expect((await patch(id, d.id, { max_payment_ngn: 50.5 })).status).toBe(400);
    expect((await patch(id, d.id, {})).status).toBe(400);
    expect((await patch(id, d.id, { steps: [] })).status).toBe(400);           // steps can't be edited
    expect((await patchWorkflow(req("PATCH", { settings: { notify_owner: false }, status: "approved" }), ctx(id, { wid: d.id }))).status).toBe(400);
    expect((await patch(id, "nope", { notify_owner: false })).status).toBe(404);
    expect((await patch(id, crypto.randomUUID(), { notify_owner: false })).status).toBe(404);

    // A valid change rebuilds the draft in place.
    v = (await wbody(await patch(id, d.id, { approval_threshold_ngn: 75_000 }))).view;
    expect(v.workflows).toHaveLength(1);
    expect(draftOf(v).doc.params.approval_threshold_ngn).toBe(75_000);

    // Approve: recorded with a timestamp; can't approve twice or discard an approved version.
    v = (await wbody(await approve(id, d.id))).view;
    const v1 = v.workflows[0];
    expect(v1).toMatchObject({ version: 1, status: "approved" });
    expect(v1.approvedAt).not.toBeNull();
    const again = await approve(id, d.id);
    expect(again.status).toBe(409);
    expect((await wbody(again)).error!.code).toBe("STATE_CONFLICT");
    expect((await discard(req("POST", {}), ctx(id, { wid: d.id }))).status).toBe(409);

    // Editing an approved version creates a NEW draft version; the approved one is untouched.
    v = (await wbody(await patch(id, v1.id, { max_payment_ngn: 200_000 }))).view;
    expect(v.workflows.map(w => [w.version, w.status])).toEqual([[2, "draft"], [1, "approved"]]);
    expect(v.workflows[1].doc.params.max_payment_ngn).toBe(250_000);

    // Approving v2 supersedes v1. A superseded version can't be edited.
    v = (await wbody(await approve(id, v.workflows[0].id))).view;
    expect(v.workflows.map(w => [w.version, w.status])).toEqual([[2, "approved"], [1, "superseded"]]);
    expect((await patch(id, v1.id, { notify_owner: false })).status).toBe(409);

    // Rebuild → v3 draft; discard removes only the draft.
    v = (await wbody(await gen(id))).view;
    const v3 = draftOf(v);
    expect(v3.version).toBe(3);
    expect(v3.doc.params.max_payment_ngn).toBe(200_000); // starts from the approved settings
    v = (await wbody(await discard(req("POST", {}), ctx(id, { wid: v3.id })))).view;
    expect(v.workflows.map(w => [w.version, w.status])).toEqual([[2, "approved"], [1, "superseded"]]);

    expect(blockedFetch).not.toHaveBeenCalled();
  });

  test("an invalid (tampered) draft can never be approved", async () => {
    const id = await restaurant();
    await approveTeam(req("POST", {}), ctx(id));
    const d = draftOf((await wbody(await gen(id))).view);
    // Tamper with the stored workflow: route BLOCK straight to the approval (and so to payment).
    const doc = structuredClone(d.doc);
    doc.steps.find(s => s.id === "security_check")!.next.block = "owner_approval";
    await discoveryRepository().updateWorkflow(id, d.id, { steps: doc });

    const r = await approve(id, d.id);
    expect(r.status).toBe(409);
    const b = await wbody(r);
    expect(b.error!.code).toBe("WORKFLOW_INVALID");
    const after = b.view.workflows.find(w => w.id === d.id)!;
    expect(after.status).toBe("draft");
    expect(after.validation.valid).toBe(false);
    expect(after.validation.checks.find(c => c.code === "PAYMENT_PATHS_GUARDED")!.passed).toBe(false);
  });

  test("approval is re-checked against the current team", async () => {
    const id = await restaurant();
    // The team is locked once approved, so simulate drift directly in the store: approval must
    // re-validate against the team as it is now, not trust the stored validation.
    await approveTeam(req("POST", {}), ctx(id));
    const d = draftOf((await wbody(await gen(id))).view);
    expect(d.validation.valid).toBe(true);
    await discoveryRepository().updateAgent(id, "procurement", { status: "removed" });
    const r = await approve(id, d.id);
    expect(r.status).toBe(409);
    expect((await wbody(r)).view.workflows[0].validation.checks.find(c => c.code === "AGENTS_APPROVED")!.passed).toBe(false);
  });

  test("approval wording: there is no deploy endpoint", () => {
    const api = path.join(process.cwd(), "src", "app", "api", "w", "[id]", "workflows");
    expect(existsSync(path.join(api, "[wid]", "approve", "route.ts"))).toBe(true);
    expect(existsSync(path.join(api, "[wid]", "deploy"))).toBe(false);
  });
});
