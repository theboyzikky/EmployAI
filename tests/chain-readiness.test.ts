// M5 Phase 3 · Readiness (plan §6.4) and recipient checks (plan §9) against an in-memory chain whose
// defaults are the verified post-B1/B2 testnet state.
import { describe, expect, it } from "vitest";
import { availableYocto, checkReadiness, checkRecipient } from "@/lib/chain/readiness";
import { AGENT, AGENT_FC_KEY, CONFIG, OWNER, S1, S2, T, fakeChain } from "./helpers/fake-chain";

const PAY = BigInt("50000000000000000000000"); // 0.05 NEAR

describe("checkReadiness", () => {
  it("is ready on the verified testnet state", async () => {
    const r = await checkReadiness(fakeChain().reader, CONFIG, AGENT_FC_KEY, PAY);
    expect(r).toMatchObject({ ready: true, failures: [] });
    // 2.4985 NEAR − (174,820 + 1,000 bytes) × 1e19 ≈ 0.74 NEAR available
    expect(BigInt(r.treasuryAvailableYocto!)).toBeGreaterThan(BigInt("700000000000000000000000"));
  });

  it.each([
    ["TREASURY_CODE_MISMATCH", { accounts: { [T]: { amount: "2498538709076408000000002", locked: "0", code_hash: "SomethingElse", storage_usage: 174820, block_height: 1, block_hash: "h" } } }],
    ["TREASURY_NOT_FOUND", { accounts: { [T]: null } }],
    ["TREASURY_PAUSED", { policy: { owner: OWNER, agent: AGENT, max_per_tx: "100000000000000000000000", daily_cap: "250000000000000000000000", paused: true, sales_enabled: false } }],
    ["TREASURY_POLICY_MISMATCH", { policy: { owner: OWNER, agent: AGENT, max_per_tx: "200000000000000000000000", daily_cap: "250000000000000000000000", paused: false, sales_enabled: false } }],
    ["TREASURY_POLICY_MISMATCH", { policy: { owner: OWNER, agent: "someone-else.testnet", max_per_tx: "100000000000000000000000", daily_cap: "250000000000000000000000", paused: false, sales_enabled: false } }],
    ["SALES_UNEXPECTEDLY_ENABLED", { salesEnabled: true }],
    ["SIGNER_KEY_UNSAFE", { keyResponse: { result: { nonce: 1, permission: "FullAccess" as const } } }],
    ["SIGNER_KEY_UNSAFE", { keyResponse: { result: { error: "access key does not exist while viewing" } } }],
    ["INSUFFICIENT_GAS", { accounts: { [AGENT]: { amount: "1000", locked: "0", code_hash: "11111111111111111111111111111111", storage_usage: 182, block_height: 1, block_hash: "h" } } }],
    ["TREASURY_UNDERFUNDED", { accounts: { [T]: { amount: "1760000000000000000000000", locked: "0", code_hash: "HvewFdJa6y2jaJxWn5oU4VckoUDhXo61fKyvd9VFBDJt", storage_usage: 174820, block_height: 1, block_hash: "h" } } }],
    ["CHAIN_UNAVAILABLE", { failOn: ["getPolicy"] }],
  ])("reports %s", async (code, over) => {
    const r = await checkReadiness(fakeChain(over as Parameters<typeof fakeChain>[0]).reader, CONFIG, AGENT_FC_KEY, PAY);
    expect(r.ready).toBe(false);
    expect(r.failures.map(f => f.code)).toContain(code);
  });

  it("only reads: every call is a view", async () => {
    const { reader, calls } = fakeChain();
    await checkReadiness(reader, CONFIG, AGENT_FC_KEY, PAY);
    expect(calls.every(c => /^(viewAccount|viewAccessKey|getPolicy|getSalesEnabled):/.test(c))).toBe(true);
  });
});

describe("availableYocto", () => {
  it("keeps storage plus the 1,000-byte reserve, never negative", () => {
    expect(availableYocto({ amount: "10000000000000000000000", locked: "0", storage_usage: 182 })).toBe(BigInt("0"));
    expect(availableYocto({ amount: "20000000000000000000000", locked: "0", storage_usage: 0 })).toBe(BigInt("10000000000000000000000"));
  });
});

describe("checkRecipient", () => {
  it("accepts allowlisted plain accounts", async () => {
    for (const s of [S1, S2]) expect(await checkRecipient(fakeChain().reader, CONFIG, s)).toEqual({ ok: true });
  });
  it("refuses an existing account that is not on the on-chain allowlist (owner correction: no app bypass)", async () => {
    expect(await checkRecipient(fakeChain().reader, CONFIG, OWNER)).toMatchObject({ ok: false, code: "RECIPIENT_NOT_APPROVED_ONCHAIN" });
  });
  it("refuses an account that does not exist", async () => {
    expect(await checkRecipient(fakeChain().reader, CONFIG, "never-created.employai-demo.testnet")).toMatchObject({ ok: false, code: "RECIPIENT_NOT_FOUND" });
  });
  it("refuses a contract account", async () => {
    expect(await checkRecipient(fakeChain().reader, CONFIG, T)).toMatchObject({ ok: false, code: "RECIPIENT_IS_CONTRACT" });
  });
  it("fails closed when the chain cannot be read", async () => {
    expect(await checkRecipient(fakeChain({ failOn: ["isApproved"] }).reader, CONFIG, S1)).toMatchObject({ ok: false, code: "CHAIN_UNAVAILABLE" });
  });
});
