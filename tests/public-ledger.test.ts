// M7 · Public ledger privacy: private by default; only verified on-chain payouts; unpublishing kills the link.
import { afterEach, describe, expect, test } from "vitest";
import { setDiscoveryRepository } from "@/lib/discovery/store";
import { buildLedgerView } from "@/lib/runs/ledger-view";
import { publicLedgerBySlug, setLedgerPublic } from "@/lib/runs/public-ledger";
import { runTransact } from "@/lib/runs/repo";
import { readyRestaurant, tempStore } from "./helpers/run-fixture";

afterEach(() => setDiscoveryRepository(null));

async function withRows() {
  const t = tempStore();
  const { businessId } = await readyRestaurant(t.store);
  await runTransact(businessId, tx => {
    tx.appendLedger({ business_id: businessId, run_id: "run-sim", type: "supplier_payout", mode: "test_run", amount: 42_780, unit: "ngn_illustrative", counterparty: "Lagos Fresh Foods (demo)", agent_key: "finance", tx_hash: null, tx_status: "simulated", request_id: "run-sim:payment", label: "Test run — no transaction" });
    const base = { business_id: businessId, type: "supplier_payout" as const, mode: "testnet" as const, unit: "yoctoNEAR" as const, amount_ngn_business: 42_780, supplier_name: "Lagos Fresh Foods (demo)", agent_key: "finance" as const, batch_id: "B3", explorer_url: null };
    tx.appendLedger({ ...base, run_id: "run-paid", amount: "31000000000000000000000", counterparty: "supplier-1.employai-demo.testnet", tx_hash: "AMBpt4jkeHAy9iaymQcv2cRJz84dXaUaADAEMe3wNsKP", tx_status: "confirmed", request_id: "run-paid:payment", attempt_id: "a1", label: "NEAR testnet · real transaction" });
    tx.appendLedger({ ...base, run_id: "run-failed", amount: "31000000000000000000000", counterparty: "supplier-2.employai-demo.testnet", tx_hash: "FailedHash11111111111111111111111111111111", tx_status: "failed", request_id: "run-failed:payment", attempt_id: "a2", label: "Failed on-chain" });
  });
  return businessId;
}

describe("public ledger", () => {
  test("private by default: no slug, nothing public", async () => {
    const id = await withRows();
    expect((await buildLedgerView(id)).publicSlug).toBeNull();
    expect(await publicLedgerBySlug("x".repeat(24))).toBeNull();
  });

  test("published: only verified on-chain payouts, with no business amounts, internal IDs or simulated rows", async () => {
    const id = await withRows();
    const slug = (await setLedgerPublic(id, true))!;
    expect(slug).toMatch(/^[A-Za-z0-9_-]{24}$/);
    const view = await publicLedgerBySlug(slug);
    expect(view).toMatchObject({ businessName: "Mama Nkechi's Kitchen", totalNear: "0.031" });
    expect(view!.rows).toEqual([expect.objectContaining({ amountText: "0.031 NEAR", recipient: "supplier-1.employai-demo.testnet", txHash: "AMBpt4jkeHAy9iaymQcv2cRJz84dXaUaADAEMe3wNsKP" })]);
    const json = JSON.stringify(view);
    for (const secret of ["42780", "42,780", "run-paid", "run-failed", "run-sim", "Lagos Fresh Foods", "FailedHash", "B3", id]) expect(json).not.toContain(secret);
  });

  test("unpublishing kills the link; publishing again makes a new one", async () => {
    const id = await withRows();
    const first = (await setLedgerPublic(id, true))!;
    expect(await setLedgerPublic(id, true)).toBe(first);           // already public: same link
    await setLedgerPublic(id, false);
    expect(await publicLedgerBySlug(first)).toBeNull();
    const second = (await setLedgerPublic(id, true))!;
    expect(second).not.toBe(first);
    expect(await publicLedgerBySlug(first)).toBeNull();
    expect(await publicLedgerBySlug(second)).not.toBeNull();
  });

  test("malformed slugs are rejected without a lookup", async () => {
    await withRows();
    for (const s of ["", "short", "../etc/passwd", "a".repeat(65)]) expect(await publicLedgerBySlug(s)).toBeNull();
  });
});
