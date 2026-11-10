// Live consultant (NEAR AI) turn: when the model has nothing more to ask, discovery must be able to
// complete. Regression for a conversation stuck repeating "anything else before we wrap up?": the live
// path never investigates causes, so a recorded problem stayed "open" and readiness was never reached.
// The AI is a scripted stand-in (no network).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

const queue: unknown[] = [];
vi.mock("@/lib/ai", () => ({
  getAi: async () => ({
    name: "nearai",
    async structured() {
      const data = queue.shift();
      if (!data) throw new Error("no scripted reply");
      return { data, provider: "nearai", model: "scripted", mode: "live", usage: { input: 1, output: 1 }, costUsd: 0 };
    },
  }),
}));

import { discoveryReadiness } from "@/lib/discovery/casefile";
import { consultantTurn } from "@/lib/discovery/service";
import { FileDevStore, setDiscoveryRepository } from "@/lib/discovery/store";

afterEach(() => { setDiscoveryRepository(null); queue.length = 0; });

describe("live consultant: wrap-up", () => {
  test("a no-question turn closes uninvestigated problems honestly, completes discovery and points to Analyse", async () => {
    const store = new FileDevStore(mkdtempSync(path.join(tmpdir(), "employai-live-")));
    setDiscoveryRepository(store);
    const b = await store.createBusiness({ ownerHash: "h", initialMessage: "I run a restaurant and I want to automate replying to online customers." });
    const first = (await store.listMessages(b.id))[0].id;

    // Turn 1: the model records what it understood and asks a question.
    queue.push({
      reply: "Thanks! How do customers reach you today?", question_field: "customers_channels", skipped_fields: [],
      facts: [
        { field: "industry", value: "Restaurant", status: "confirmed", source_message_ids: [first] },
        { field: "goals", value: "Automate replies to online customers", status: "confirmed", source_message_ids: [first] },
        { field: "challenges", value: "Replying to customer messages takes too long", status: "confirmed", source_message_ids: [first] },
      ],
    });
    await consultantTurn((await store.getBusiness(b.id))!, {});

    // The case file holds a problem the live consultant never investigates (as in the stuck conversation).
    const cur = (await store.getBusiness(b.id))!;
    const cf = structuredClone(cur.profile.case_file!);
    cf.problems.push({ id: "p-live", playbook: null, symptom_claim: cf.claims[0]?.id ?? "c1", cause_claim: null, hypotheses: [], resolution: "open", probes: 0, uncertainty: null });
    await store.updateBusiness(b.id, { profile: { ...cur.profile, case_file: cf } });
    expect(discoveryReadiness((await store.getBusiness(b.id))!.profile).ready).toBe(false);

    // Turn 2: the owner answers; the model wraps up without a question.
    queue.push({ reply: "Is there anything else you'd like to add before we wrap up?", question_field: null, skipped_fields: [], facts: [] });
    await consultantTurn((await store.getBusiness(b.id))!, { content: "no", clientMessageId: "m-no" });

    const after = (await store.getBusiness(b.id))!;
    expect(discoveryReadiness(after.profile).ready).toBe(true);
    const p = after.profile.case_file!.problems.find(x => x.id === "p-live")!;
    expect(p).toMatchObject({ resolution: "unknown", uncertainty: "The cause wasn't investigated in this conversation." });
    const last = (await store.listMessages(b.id)).at(-1)!;
    expect(last.role).toBe("assistant");
    expect(last.content).toMatch(/click "Analyse my business" to continue\.$/);
    expect(last.content.match(/Analyse my business/g)).toHaveLength(1);
  });

  test("a turn that still asks a question leaves open problems alone", async () => {
    const store = new FileDevStore(mkdtempSync(path.join(tmpdir(), "employai-live-")));
    setDiscoveryRepository(store);
    const b = await store.createBusiness({ ownerHash: "h", initialMessage: "I run a restaurant." });
    const first = (await store.listMessages(b.id))[0].id;
    queue.push({ reply: "What's the business called?", question_field: "business_name", skipped_fields: [], facts: [{ field: "industry", value: "Restaurant", status: "confirmed", source_message_ids: [first] }] });
    await consultantTurn((await store.getBusiness(b.id))!, {});
    const cur = (await store.getBusiness(b.id))!;
    const cf = structuredClone(cur.profile.case_file!);
    cf.problems.push({ id: "p-live", playbook: null, symptom_claim: "c1", cause_claim: null, hypotheses: [], resolution: "open", probes: 0, uncertainty: null });
    await store.updateBusiness(b.id, { profile: { ...cur.profile, case_file: cf } });
    queue.push({ reply: "And how do customers order?", question_field: "customers_channels", skipped_fields: [], facts: [] });
    await consultantTurn((await store.getBusiness(b.id))!, { content: "Mama's Kitchen", clientMessageId: "m-2" });
    const after = (await store.getBusiness(b.id))!;
    expect(after.profile.case_file!.problems.find(x => x.id === "p-live")!.resolution).toBe("open");
    expect((await store.listMessages(b.id)).at(-1)!.content).not.toMatch(/Analyse my business/);
  });
});
