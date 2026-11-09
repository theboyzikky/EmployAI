// M5 Phase 3 · Recovery decisions (plan §11.1, AC5-22): the contract record is the primary source;
// UNKNOWN_TRANSACTION is never proof of non-execution; a Pending request is never resubmitted; a new
// signed transaction only after the validity window closes (by block height) with no record.
import { describe, expect, it } from "vitest";
import { decideRecovery, sameDetails, type AttemptFacts } from "@/lib/chain/recovery";
import type { PaymentRequestRecord } from "@/lib/chain/types";
import { AGENT, S1 } from "./helpers/fake-chain";

const AMT = "50000000000000000000000";
const att = (o: Partial<AttemptFacts> = {}): AttemptFacts => ({ requestId: "run-1:payment", recipient: S1, amountYocto: AMT, signedBlockHeight: 1_000, validityPeriodBlocks: 86_400, signedBytesAvailable: true, ...o });
const rec = (status: PaymentRequestRecord["status"], o: Partial<PaymentRequestRecord> = {}): PaymentRequestRecord =>
  ({ recipient: S1, amount: AMT, day: 1, status, agent: AGENT, requested_at_block: 1_001, settled_at_block: null, attempts: 1, ...o });

describe("decideRecovery", () => {
  it("record Paid → settle as confirmed (full verification still required)", () => {
    expect(decideRecovery(att(), rec("Paid"), 2_000)).toEqual({ action: "settle_confirmed" });
  });
  it("record Failed → settle as failed (manual retry path only)", () => {
    expect(decideRecovery(att(), rec("Failed"), 2_000)).toEqual({ action: "settle_failed" });
  });
  it("record Pending → wait, never resubmit — even long after the validity window", () => {
    for (const h of [1_500, 1_000 + 86_400 + 1, 10_000_000]) expect(decideRecovery(att(), rec("Pending"), h).action).toBe("wait");
  });
  it("record with different details → investigate (never act automatically)", () => {
    expect(decideRecovery(att(), rec("Paid", { amount: "1" }), 2_000).action).toBe("investigate");
    expect(decideRecovery(att(), rec("Pending", { recipient: "evil.testnet" }), 2_000).action).toBe("investigate");
  });
  it("record unavailable (RPC error) → wait", () => {
    expect(decideRecovery(att(), "unavailable", 2_000).action).toBe("wait");
  });
  it("no record, window open → re-broadcast the identical bytes only", () => {
    expect(decideRecovery(att(), null, 1_000 + 86_400)).toEqual({ action: "rebroadcast_same_bytes" });
  });
  it("no record, window open, bytes no longer stored → wait", () => {
    expect(decideRecovery(att({ signedBytesAvailable: false }), null, 50_000).action).toBe("wait");
  });
  it("no record, window CLOSED by block height → eligible for resubmission, with all requirements listed", () => {
    const d = decideRecovery(att(), null, 1_000 + 86_400 + 1);
    expect(d.action).toBe("eligible_for_resubmission");
    if (d.action === "eligible_for_resubmission") {
      expect(d.requires.join(" ")).toMatch(/fresh security gate evaluation/);
      expect(d.requires.join(" ")).toMatch(/fresh owner approval/);
      expect(d.requires.join(" ")).toMatch(/same request ID/);
    }
  });
  it("no record, validity window unknown → investigate", () => {
    expect(decideRecovery(att({ signedBlockHeight: null }), null, 99_999_999).action).toBe("investigate");
    expect(decideRecovery(att({ validityPeriodBlocks: null }), null, 99_999_999).action).toBe("investigate");
  });
  it("no record, current height unknown → wait", () => {
    expect(decideRecovery(att(), null, null).action).toBe("wait");
  });
  it("UNKNOWN_TRANSACTION is not an input that can unlock resubmission: only height + record decide", () => {
    // The function has no transaction-lookup input at all; an open window stays open whatever a node says.
    expect(decideRecovery(att(), null, 2_000).action).toBe("rebroadcast_same_bytes");
  });
});

describe("sameDetails", () => {
  it("requires every field to match exactly", () => {
    expect(sameDetails({ a: "1", b: "2" }, { a: "1", b: "2" })).toBe(true);
    expect(sameDetails({ a: "1", b: "2" }, { a: "1", b: "3" })).toBe(false);
    expect(sameDetails({ a: "1" }, { a: "1", b: "2" })).toBe(false);
  });
});
