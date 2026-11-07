// Test fixture for M4: a business ready for test runs, built directly in an isolated FileDevStore.
// Fictional demo data only; nothing here touches the real .data store or any network.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CapabilityKey } from "@/lib/catalogue/catalogue";
import { proposeTeam } from "@/lib/catalogue/propose";
import { emptyCaseFile } from "@/lib/discovery/casefile";
import type { Analysis } from "@/lib/discovery/profile";
import { FileDevStore, setDiscoveryRepository, type WorkflowRecord } from "@/lib/discovery/store";
import { restaurantDemoScenario, RESTAURANT_INDUSTRY } from "@/lib/workflows/demo-data";
import { DEFAULT_PARAMS, generateRestaurantWorkflow } from "@/lib/workflows/generate";
import type { Params } from "@/lib/workflows/schema";
import { validateWorkflow } from "@/lib/workflows/validate";
import { FINGERPRINT_ALG, workflowFingerprint } from "@/lib/runs/fingerprint";
import { teamOf } from "@/lib/runs/eligibility";

export const tempStore = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "employai-m4-"));
  const store = new FileDevStore(dir);
  setDiscoveryRepository(store);
  return { dir, store, file: path.join(dir, "dev-store.json") };
};

const ALL_CAPS: CapabilityKey[] = ["order_intake", "inventory_tracking", "procurement", "finance_payments"];

function analysisFor(caps: CapabilityKey[]): Analysis {
  return {
    processes: [], repetitive_tasks: [], bottlenecks: [],
    opportunities: caps.map(c => ({ title: `Fixture opportunity: ${c}`, detail: "Fixture.", evidence: [{ kind: "message" as const, message_id: "m1" }], basis: "confirmed" as const, capability: c })),
    rejected_items: 0, generated_at: "2026-11-06T00:00:00.000Z", mode: "offline-demo",
  } as Analysis;
}

export type FixtureOptions = {
  caps?: CapabilityKey[];
  industry?: string;
  /** The approval was made before M4 (no fingerprint). */
  legacy?: boolean;
  /** The discovery predates M3.5 (migrated case file). */
  preM35?: boolean;
  params?: Params;
  /** The owner's hashed cookie token (route tests); defaults to a fixed hash. */
  ownerHash?: string;
};

/** A restaurant with a confirmed M3.5 discovery, an approved team and an approved, fingerprinted workflow. */
export async function readyRestaurant(store: FileDevStore, opts: FixtureOptions = {}) {
  const b = await store.createBusiness({ ownerHash: opts.ownerHash ?? "owner-hash-fixture", initialMessage: "I run a restaurant called Mama Nkechi's Kitchen." });
  const now = new Date().toISOString();
  await store.updateBusiness(b.id, {
    name: "Mama Nkechi's Kitchen", business_type: opts.industry ?? RESTAURANT_INDUSTRY, status: "active",
    profile: { ...b.profile, stage: "proposal", case_file: emptyCaseFile(opts.preM35 ? "migrated" : "native") },
    profile_confirmed_at: now, scenario_data: restaurantDemoScenario(),
  });
  const team = proposeTeam(analysisFor(opts.caps ?? ALL_CAPS));
  const agents = await store.replaceAgents(b.id, team.map(a => ({ ...a, status: "approved" as const, approved_at: now, near_account_id: null })));
  const members = teamOf(agents, (opts.industry ?? RESTAURANT_INDUSTRY) === RESTAURANT_INDUSTRY);
  const doc = generateRestaurantWorkflow(members, opts.params ?? DEFAULT_PARAMS);
  const validation = validateWorkflow(doc, { team: members, runnable: true });
  const wf = await store.createWorkflow({ business_id: b.id, name: doc.name, version: 1, steps: doc, validation, status: "approved", approved_at: now });
  if (!opts.legacy) {
    await store.updateWorkflow(b.id, wf.id, { approval_fingerprint: workflowFingerprint(wf), fingerprint_alg: FINGERPRINT_ALG });
  }
  const workflow = (await store.listWorkflows(b.id)).find(w => w.id === wf.id) as WorkflowRecord;
  return { businessId: b.id, workflow, agents };
}
