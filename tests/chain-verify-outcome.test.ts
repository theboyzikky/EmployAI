// M5 Phase 3 · Payout verification (plan §12, F2). The contract-rejection case uses the REAL B2 C1
// outcome; success/failure-with-callback outcomes are synthetic (no real payout has happened yet) and
// follow the receipt structure the treasury produces (request → transfer → on_payout callback).
import { describe, expect, it } from "vitest";
import { verifyPayout, type PayoutExpectation } from "@/lib/chain/verify-outcome";
import type { ExecutionOutcome, PaymentRequestRecord, TxStatusResult } from "@/lib/chain/types";
import { AGENT, S1, T, fixture } from "./helpers/fake-chain";

const AMOUNT = "50000000000000000000000";
const EXP: PayoutExpectation = { requestId: "run-0001:payment", recipient: S1, amountYocto: AMOUNT, agent: AGENT, treasury: T };
const b64 = (s: string) => Buffer.from(s).toString("base64");
const ev = (event: string, data: Record<string, unknown>) => `EVENT_JSON:${JSON.stringify({ standard: "employai-treasury", version: "1.0.0", event, data: [data] })}`;
const rcpt = (executor: string, status: ExecutionOutcome["outcome"]["status"], logs: string[] = []): ExecutionOutcome =>
  ({ id: Math.random().toString(36), block_hash: "b", outcome: { executor_id: executor, status, logs, gas_burnt: 1_000_000_000_000, tokens_burnt: "100000000000000000000", receipt_ids: [] } });
const payload = { request_id: EXP.requestId, recipient: S1, amount: AMOUNT, agent: AGENT, day: 20766 };

function payoutTx(opts: { transferOk: boolean; callback?: "true" | "false"; event?: "completed" | "failed" | "none"; eventData?: Record<string, unknown>; final?: string }): TxStatusResult {
  const cb = opts.callback ?? (opts.transferOk ? "true" : "false");
  const evName = opts.event ?? (opts.transferOk ? "completed" : "failed");
  const data = opts.eventData ?? (evName === "failed" ? { ...payload, rolled_back: true } : payload);
  return {
    final_execution_status: opts.final ?? "FINAL",
    status: { SuccessValue: b64(cb) },                  // F2: the transaction succeeds either way
    transaction: { hash: "TxHash111", signer_id: AGENT, receiver_id: T, nonce: 1, public_key: "ed25519:k", actions: [] },
    transaction_outcome: rcpt(AGENT, { SuccessReceiptId: "r1" }),
    receipts_outcome: [
      rcpt(T, { SuccessReceiptId: "r3" }, [ev("payout_requested", { ...payload, attempt: 1 })]),
      rcpt(S1, opts.transferOk ? { SuccessValue: "" } : { Failure: { ActionError: { kind: { AccountDoesNotExist: { account_id: S1 } } } } }),
      rcpt(T, { SuccessValue: b64(cb) }, evName === "none" ? [] : [ev(evName === "completed" ? "payout_completed" : "payout_failed", data)]),
      rcpt(AGENT, { SuccessValue: "" }),
    ],
  };
}
const rec = (status: PaymentRequestRecord["status"], over: Partial<PaymentRequestRecord> = {}): PaymentRequestRecord =>
  ({ recipient: S1, amount: AMOUNT, day: 20766, status, agent: AGENT, requested_at_block: 1, settled_at_block: status === "Pending" ? null : 2, attempts: 1, ...over });

describe("verifyPayout", () => {
  it("classifies the REAL B2 C1 outcome as a contract rejection with no transfer", () => {
    const c1 = fixture<{ result: TxStatusResult }>("b2-c1-contract-rejected.tx.json").result;
    const v = verifyPayout(c1, { requestId: "b2-c1-unapproved", recipient: "employai-demo.testnet", amountYocto: "10000000000000000000000", agent: AGENT, treasury: T }, null);
    expect(v).toEqual({ outcome: "failed_onchain", kind: "contract_rejected", panic: "Recipient not approved", txHash: "46cdG6k5U7pnxmGDU1PRgeRXwueR1WyfETWbtV6EwgEu" });
  });

  it("confirms only when all four checks hold (final success, callback true, matching event, record Paid)", () => {
    const v = verifyPayout(payoutTx({ transferOk: true }), EXP, rec("Paid"));
    expect(v.outcome).toBe("confirmed");
    if (v.outcome === "confirmed") expect(v.txHash).toBe("TxHash111");
  });

  it("F2: a successful TRANSACTION whose transfer failed is failed_onchain, never confirmed", () => {
    const v = verifyPayout(payoutTx({ transferOk: false }), EXP, rec("Failed"));
    expect(v).toEqual({ outcome: "failed_onchain", kind: "transfer_failed", rolledBack: true, txHash: "TxHash111" });
  });

  it.each<[string, TxStatusResult, PaymentRequestRecord | null]>([
    ["no request record yet", payoutTx({ transferOk: true }), null],
    ["record still Pending", payoutTx({ transferOk: true }), rec("Pending")],
    ["record Paid with a different amount", payoutTx({ transferOk: true }), rec("Paid", { amount: "1" })],
    ["event amount differs", payoutTx({ transferOk: true, eventData: { ...payload, amount: "1" } }), rec("Paid")],
    ["event recipient differs", payoutTx({ transferOk: true, eventData: { ...payload, recipient: "evil.testnet" } }), rec("Paid")],
    ["callback returned false with a completed event", payoutTx({ transferOk: true, callback: "false" }), rec("Paid")],
    ["no settlement event", payoutTx({ transferOk: true, event: "none" }), rec("Paid")],
    ["not final", payoutTx({ transferOk: true, final: "EXECUTED_OPTIMISTIC" }), rec("Paid")],
    ["payout_failed but record says Paid", payoutTx({ transferOk: false }), rec("Paid")],
  ])("never confirms when %s", (_label, tx, record) => {
    expect(verifyPayout(tx, EXP, record).outcome).toBe("unknown");
  });

  it("rejects a transaction from another signer or to another contract", () => {
    const tx = payoutTx({ transferOk: true });
    expect(verifyPayout({ ...tx, transaction: { ...tx.transaction, signer_id: "evil.testnet" } }, EXP, rec("Paid")).outcome).toBe("unknown");
    expect(verifyPayout({ ...tx, transaction: { ...tx.transaction, receiver_id: "other.testnet" } }, EXP, rec("Paid")).outcome).toBe("unknown");
  });
});
