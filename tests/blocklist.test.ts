// M6 · Shared blocklist: gate rules (confirmed → BLOCK, reported → WARN), expiry, fixture, report service.
import { afterEach, describe, expect, test } from "vitest";
import { setDiscoveryRepository } from "@/lib/discovery/store";
import { listBlocklist, reportAccount } from "@/lib/runs/blocklist-service";
import { BLOCKLIST_FIXTURES, SCAM_SUPPLIER, blocklistSets, effectiveStatus, evidenceSha256, statusOf, type BlocklistReport } from "@/lib/security/blocklist";
import { evaluate, type GateAction, type GateContext } from "@/lib/security/gate";
import { readyRestaurant, tempStore } from "./helpers/run-fixture";

afterEach(() => setDiscoveryRepository(null));

const action = (beneficiary: string, provenance: "system" | "untrusted" = "system"): GateAction => ({
  kind: "payment_request", agentKey: "finance", tool: "request_payment", stepId: "payment", requestId: "r-1", beneficiary, amountNgn: 10_000,
  channel: { kind: "treasury_contract", method: "request_payment" }, provenance,
});
const ctx = (over: Partial<GateContext> = {}): GateContext => ({
  killSwitch: false, agent: { status: "approved", allowedTools: ["request_payment"] }, stepTools: ["request_payment"],
  policy: { version: "p", maxPaymentNgn: 250_000, approvalThresholdNgn: 50_000, dailyLimitNgn: 500_000 },
  registry: [{ name: "Good Co", approved: true, priorPayments: 3, account: "good.testnet" }, { name: "Scam Co", approved: false, priorPayments: 0, account: SCAM_SUPPLIER }],
  blocklist: [], spentTodayNgn: 0, seenRequestIds: [], ...over,
});
const report = (over: Partial<BlocklistReport>): BlocklistReport => ({
  id: "r", account_id: "x.testnet", network: "testnet", status: "reported", reason: "r", evidence_type: "text", evidence_ref: "evidence text", evidence_sha256: "h",
  reported_by_business_id: "b", demo: false, created_at: "2026-11-09T00:00:00.000Z", reviewed_at: null, expires_at: "2026-12-09T00:00:00.000Z", ...over,
});

describe("gate · blocklist rules", () => {
  test("a CONFIRMED account blocks, by the supplier's account even when named differently, with the other findings listed", () => {
    const r = evaluate(action("Scam Co", "untrusted"), ctx({ blocklist: [SCAM_SUPPLIER] }));
    expect(r).toMatchObject({ decision: "BLOCK", reasons: ["RECIPIENT_BLOCKLISTED", "RECIPIENT_NOT_APPROVED", "UNTRUSTED_INSTRUCTION_SOURCE"] });
  });
  test("a REPORTED (unconfirmed) account only warns: one report can't block a supplier", () => {
    const r = evaluate(action("Good Co"), ctx({ reported: ["good.testnet"] }));
    expect(r).toMatchObject({ decision: "WARN", reasons: ["RECIPIENT_REPORTED"] });
  });
  test("the kill switch still beats everything", () => {
    expect(evaluate(action("Scam Co"), ctx({ killSwitch: true, blocklist: [SCAM_SUPPLIER] })).reasons).toEqual(["KILL_SWITCH_ACTIVE"]);
  });
  test("an untrusted instruction to an approved, clean supplier is a WARN, never an ALLOW", () => {
    expect(evaluate(action("Good Co", "untrusted"), ctx())).toMatchObject({ decision: "WARN", reasons: ["UNTRUSTED_INSTRUCTION_SOURCE"] });
  });
});

describe("blocklist data", () => {
  test("the demo fixture is confirmed, labelled and carries evidence with its hash", () => {
    expect(BLOCKLIST_FIXTURES).toMatchObject([{ account_id: SCAM_SUPPLIER, status: "confirmed", demo: true, evidence_type: "text" }]);
    expect(BLOCKLIST_FIXTURES[0].evidence_sha256).toBe(evidenceSha256("text", BLOCKLIST_FIXTURES[0].evidence_ref));
    expect(statusOf([], SCAM_SUPPLIER, "2026-11-10T00:00:00.000Z")).toBe("confirmed");
  });
  test("unconfirmed reports expire; confirmed entries don't", () => {
    const old = report({ expires_at: "2026-11-01T00:00:00.000Z" });
    expect(effectiveStatus(old, "2026-11-10T00:00:00.000Z")).toBe("expired");
    expect(blocklistSets([old], "2026-11-10T00:00:00.000Z").reported).toEqual([]);
    expect(blocklistSets([report({})], "2026-11-10T00:00:00.000Z").reported).toEqual(["x.testnet"]);
  });
});

describe("report service", () => {
  test("a report needs valid evidence; the server hashes it; it's shared, reported (WARN) and idempotent per workspace", async () => {
    const t = tempStore();
    const a = await readyRestaurant(t.store);
    const b = await readyRestaurant(t.store);
    await expect(reportAccount(a.businessId, { accountId: "Not An Account!", reason: "bad", evidence: { type: "text", ref: "long enough evidence" } })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(reportAccount(a.businessId, { accountId: "bad.testnet", reason: "fraud", evidence: { type: "tx", ref: "not-a-hash" } })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(reportAccount(a.businessId, { accountId: "bad.testnet", reason: "fraud", evidence: { type: "url", ref: "http://insecure.example" } })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const first = await reportAccount(a.businessId, { accountId: "Bad.Testnet", reason: "Asked for payment outside the app", evidence: { type: "text", ref: "Quote said to pay this account directly." } });
    expect(first).toMatchObject({ created: true, entry: { accountId: "bad.testnet", status: "reported", reportedByYou: true, evidenceSha256: evidenceSha256("text", "Quote said to pay this account directly.") } });
    expect((await reportAccount(a.businessId, { accountId: "bad.testnet", reason: "again", evidence: { type: "text", ref: "Same thing again here." } })).created).toBe(false);
    const seenByB = await listBlocklist(b.businessId);                     // shared across workspaces
    expect(seenByB.find(e => e.accountId === "bad.testnet")).toMatchObject({ status: "reported", reportedByYou: false });
    expect(seenByB.find(e => e.accountId === SCAM_SUPPLIER)).toMatchObject({ status: "confirmed", demo: true });
  });
});
