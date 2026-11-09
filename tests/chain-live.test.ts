// M5 Phase 4 · The live PaymentChain adapter (src/lib/chain/live.ts) over a FAKE chain reader, the
// lazy registration's fail-closed refusals, and the single-server signer lock. No network, no key.
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireSignerLock } from "@/lib/chain/instance-lock";
import type { AgentKeyHandle } from "@/lib/chain/keys";
import { createPaymentChain, nearPolicyVersionOf } from "@/lib/chain/live";
import type { ExecutionOutcome, PaymentRequestRecord, TxStatusResult } from "@/lib/chain/types";
import { getPaymentChain, setPaymentChainForTests } from "@/lib/runs/payment-port";
import { AGENT, AGENT_FC_KEY, CONFIG, OWNER, S1, T, fakeChain } from "./helpers/fake-chain";

const AMOUNT = "31000000000000000000000";
const REQ = "run-0001:payment";
const b64 = (s: string) => Buffer.from(s).toString("base64");
const ev = (event: string, data: Record<string, unknown>) => `EVENT_JSON:${JSON.stringify({ standard: "employai-treasury", version: "1.0.0", event, data: [data] })}`;
const rcpt = (executor: string, status: ExecutionOutcome["outcome"]["status"], logs: string[] = []): ExecutionOutcome =>
  ({ id: Math.random().toString(36), block_hash: "b", outcome: { executor_id: executor, status, logs, gas_burnt: 2_000_000_000_000, tokens_burnt: "1", receipt_ids: [] } });
const payload = { request_id: REQ, recipient: S1, amount: AMOUNT, agent: AGENT, day: 20766 };
const paidTx = (hash = "TxHash111"): TxStatusResult => ({
  final_execution_status: "FINAL", status: { SuccessValue: b64("true") },
  transaction: { hash, signer_id: AGENT, receiver_id: T, nonce: 1, public_key: AGENT_FC_KEY, actions: [] },
  transaction_outcome: rcpt(AGENT, { SuccessReceiptId: "r1" }),
  receipts_outcome: [
    rcpt(T, { SuccessReceiptId: "r3" }, [ev("payout_requested", { ...payload, attempt: 1 })]),
    rcpt(S1, { SuccessValue: "" }),
    rcpt(T, { SuccessValue: b64("true") }, [ev("payout_completed", payload)]),
  ],
});
const rec = (status: PaymentRequestRecord["status"]): PaymentRequestRecord => ({ recipient: S1, amount: AMOUNT, day: 20766, status, agent: AGENT, requested_at_block: 1, settled_at_block: 2, attempts: 1 });
const handle = { publicKey: AGENT_FC_KEY, signTransaction: async () => { throw new Error("not used"); }, toJSON: () => ({ publicKey: AGENT_FC_KEY }), toString: () => "AgentKey" } as AgentKeyHandle;
const facts = (over: Partial<Parameters<ReturnType<typeof createPaymentChain>["reconcile"]>[0]> = {}) =>
  ({ requestId: REQ, recipient: S1, amountYocto: AMOUNT, txHash: "TxHash111", signedBlockHeight: 1000, validityPeriodBlocks: 86_400, signedBytesAvailable: true, ...over });

afterEach(() => { vi.unstubAllEnvs(); setPaymentChainForTests(null); });

describe("live adapter · reconcile (§11.1)", () => {
  it("Paid + full transaction evidence → settled confirmed", async () => {
    const { reader } = fakeChain({ requests: { [REQ]: rec("Paid") }, txs: { TxHash111: paidTx() } });
    const pc = createPaymentChain({ chain: reader, rpc: { sendTx: vi.fn() }, config: CONFIG, agentKey: handle });
    expect(await pc.reconcile(facts())).toMatchObject({ action: "settled", verdict: { outcome: "confirmed", txHash: "TxHash111" } });
  });

  it("Paid but the transaction isn't available → wait (never confirmed without the evidence)", async () => {
    const { reader } = fakeChain({ requests: { [REQ]: rec("Paid") } });
    const pc = createPaymentChain({ chain: reader, rpc: { sendTx: vi.fn() }, config: CONFIG, agentKey: handle });
    expect(await pc.reconcile(facts())).toMatchObject({ action: "wait" });
  });

  it("Failed → settled failed_onchain (transfer failed)", async () => {
    const { reader } = fakeChain({ requests: { [REQ]: rec("Failed") } });
    const pc = createPaymentChain({ chain: reader, rpc: { sendTx: vi.fn() }, config: CONFIG, agentKey: handle });
    expect(await pc.reconcile(facts())).toMatchObject({ action: "settled", verdict: { outcome: "failed_onchain", kind: "transfer_failed" } });
  });

  it("Pending → wait; never resubmitted", async () => {
    const { reader } = fakeChain({ requests: { [REQ]: rec("Pending") } });
    const pc = createPaymentChain({ chain: reader, rpc: { sendTx: vi.fn() }, config: CONFIG, agentKey: handle });
    expect(await pc.reconcile(facts())).toMatchObject({ action: "wait" });
  });

  it("no record, window open → re-broadcast the identical bytes; window closed → expired_unexecuted", async () => {
    const open = createPaymentChain({ chain: fakeChain({ height: 50_000 }).reader, rpc: { sendTx: vi.fn() }, config: CONFIG, agentKey: handle });
    expect(await open.reconcile(facts())).toEqual({ action: "rebroadcast" });
    const closed = createPaymentChain({ chain: fakeChain({ height: 87_401 }).reader, rpc: { sendTx: vi.fn() }, config: CONFIG, agentKey: handle });
    expect(await closed.reconcile(facts())).toMatchObject({ action: "expired_unexecuted" });
    const edge = createPaymentChain({ chain: fakeChain({ height: 87_400 }).reader, rpc: { sendTx: vi.fn() }, config: CONFIG, agentKey: handle });
    expect(await edge.reconcile(facts())).toEqual({ action: "rebroadcast" });   // inclusive: still valid at the last block
  });

  it("an unreadable request record → wait (never decide on an RPC error)", async () => {
    const pc = createPaymentChain({ chain: fakeChain({ failOn: ["getRequest"] }).reader, rpc: { sendTx: vi.fn() }, config: CONFIG, agentKey: handle });
    expect(await pc.reconcile(facts())).toMatchObject({ action: "wait" });
  });
});

describe("live adapter · broadcast and verification (§12)", () => {
  it("a final, fully verified payout → confirmed with the RPC's hash and the stored evidence", async () => {
    const sendTx = vi.fn(async () => paidTx());
    const pc = createPaymentChain({ chain: fakeChain({ requests: { [REQ]: rec("Paid") } }).reader, rpc: { sendTx }, config: CONFIG, agentKey: handle });
    const v = await pc.broadcast({ signedTxBase64: "AAAA", requestId: REQ, recipient: S1, amountYocto: AMOUNT });
    expect(v).toMatchObject({ outcome: "confirmed", txHash: "TxHash111", evidence: { final_execution_status: "FINAL" } });
    expect(sendTx).toHaveBeenCalledTimes(1);
  });

  it("an RPC error at broadcast → unknown (never 'not sent')", async () => {
    const sendTx = vi.fn(async () => { throw Object.assign(new Error("t"), { kind: "TIMEOUT" }); });
    const pc = createPaymentChain({ chain: fakeChain().reader, rpc: { sendTx }, config: CONFIG, agentKey: handle });
    expect(await pc.broadcast({ signedTxBase64: "AAAA", requestId: REQ, recipient: S1, amountYocto: AMOUNT })).toMatchObject({ outcome: "unknown" });
    expect(sendTx).toHaveBeenCalledTimes(1);
  });

  it("final, but the record can't be read to verify → unknown", async () => {
    const pc = createPaymentChain({ chain: fakeChain({ failOn: ["getRequest"] }).reader, rpc: { sendTx: async () => paidTx() }, config: CONFIG, agentKey: handle });
    expect(await pc.broadcast({ signedTxBase64: "AAAA", requestId: REQ, recipient: S1, amountYocto: AMOUNT })).toMatchObject({ outcome: "unknown" });
  });
});

describe("live adapter · precheck", () => {
  it("the verified testnet state passes, with the policy version and the contract's day total", async () => {
    const pc = createPaymentChain({ chain: fakeChain().reader, rpc: { sendTx: vi.fn() }, config: CONFIG, agentKey: handle });
    const p = await pc.precheck({ recipient: S1, amountYocto: AMOUNT });
    expect(p).toMatchObject({ failures: [], onchainSpentTodayYocto: "0", onchainLimits: { maxPerTxYocto: "100000000000000000000000", dailyCapYocto: "250000000000000000000000" } });
    expect(p.nearPolicyVersion).toBe(nearPolicyVersionOf({ owner: OWNER, agent: AGENT, max_per_tx: "100000000000000000000000", daily_cap: "250000000000000000000000", paused: false, sales_enabled: false }));
  });

  it("reports each hard refusal: off-allowlist recipient, paused treasury, a non-approved key", async () => {
    const off = await createPaymentChain({ chain: fakeChain({ approved: [] }).reader, rpc: { sendTx: vi.fn() }, config: CONFIG, agentKey: handle }).precheck({ recipient: S1, amountYocto: AMOUNT });
    expect(off.failures.map(f => f.code)).toEqual(["RECIPIENT_NOT_APPROVED_ONCHAIN"]);
    const paused = await createPaymentChain({ chain: fakeChain({ policy: { owner: OWNER, agent: AGENT, max_per_tx: "100000000000000000000000", daily_cap: "250000000000000000000000", paused: true, sales_enabled: false } }).reader, rpc: { sendTx: vi.fn() }, config: CONFIG, agentKey: handle }).precheck({ recipient: S1, amountYocto: AMOUNT });
    expect(paused.failures.map(f => f.code)).toContain("TREASURY_PAUSED");
    const other = await createPaymentChain({ chain: fakeChain().reader, rpc: { sendTx: vi.fn() }, config: CONFIG, agentKey: { ...handle, publicKey: "ed25519:other" } }).precheck({ recipient: S1, amountYocto: AMOUNT });
    expect(other.failures.map(f => f.code)).toContain("SIGNER_KEY_UNSAFE");
  });

  it("a changed on-chain policy changes its version (which invalidates approvals before signing)", () => {
    const base = { owner: OWNER, agent: AGENT, max_per_tx: "100000000000000000000000", daily_cap: "250000000000000000000000", paused: false, sales_enabled: false };
    expect(nearPolicyVersionOf(base)).not.toBe(nearPolicyVersionOf({ ...base, paused: true }));
    expect(nearPolicyVersionOf(base)).not.toBe(nearPolicyVersionOf({ ...base, max_per_tx: "1" }));
  });
});

describe("registration fails closed", () => {
  it("with no NEAR configuration the port is unavailable (no key read, nothing signed)", async () => {
    for (const k of ["NEAR_NETWORK", "NEAR_PARENT_ACCOUNT_ID", "NEAR_TREASURY_CONTRACT_ID", "NEAR_FINANCE_AGENT_ACCOUNT_ID", "NEAR_FINANCE_AGENT_PRIVATE_KEY"]) vi.stubEnv(k, "");
    const r = await getPaymentChain();
    expect(r).toMatchObject({ ok: false, code: "TESTNET_NOT_CONFIGURED" });
    expect(JSON.stringify(r)).toContain("NEAR_NETWORK");
  });

  it("with other accounts configured it refuses before touching the key", async () => {
    vi.stubEnv("NEAR_NETWORK", "testnet");
    vi.stubEnv("NEAR_PARENT_ACCOUNT_ID", "someone.testnet");
    vi.stubEnv("NEAR_TREASURY_CONTRACT_ID", T);
    vi.stubEnv("NEAR_FINANCE_AGENT_ACCOUNT_ID", AGENT);
    vi.stubEnv("NEAR_FINANCE_AGENT_PRIVATE_KEY", "");
    expect(await getPaymentChain()).toMatchObject({ ok: false, code: "ACCOUNT_CONFIG_MISMATCH" });
  });

  it("with the approved accounts but no key: AGENT_KEY_MISSING", async () => {
    vi.stubEnv("NEAR_NETWORK", "testnet");
    vi.stubEnv("NEAR_PARENT_ACCOUNT_ID", OWNER);
    vi.stubEnv("NEAR_TREASURY_CONTRACT_ID", T);
    vi.stubEnv("NEAR_FINANCE_AGENT_ACCOUNT_ID", AGENT);
    vi.stubEnv("NEAR_FINANCE_AGENT_PRIVATE_KEY", "");
    expect(await getPaymentChain()).toMatchObject({ ok: false, code: "AGENT_KEY_MISSING" });
  });
});

describe("single-server signer lock", () => {
  it("one process holds it; a live other process is refused; a dead holder's lock is taken over", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "employai-lock-"));
    expect(acquireSignerLock(dir)).toMatchObject({ ok: true });
    expect(acquireSignerLock(dir)).toMatchObject({ ok: true });                       // same process: re-entrant
    const file = path.join(dir, "testnet-signer.lock");
    writeFileSync(file, JSON.stringify({ pid: process.ppid, started_at: "x" }));       // a live other process
    expect(acquireSignerLock(dir)).toMatchObject({ ok: false, code: "TESTNET_SINGLE_SERVER" });
    writeFileSync(file, JSON.stringify({ pid: 2 ** 22 + 12345, started_at: "x" }));    // a pid that doesn't exist
    expect(acquireSignerLock(dir)).toMatchObject({ ok: true });
    expect(existsSync(file)).toBe(true);
  });
});
