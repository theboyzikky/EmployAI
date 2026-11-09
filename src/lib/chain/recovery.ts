import "server-only";
// M5 · Recovery decisions (plan §11.1, AC5-22). Pure: given what is known about an attempt, decide
// what is safe. The contract's request record (get_request) is the PRIMARY source of payment status;
// transaction lookups are secondary and time-limited, and UNKNOWN_TRANSACTION is never proof that a
// transaction did not execute (B0-4).
import type { PaymentRequestRecord } from "./types";

export type AttemptFacts = {
  requestId: string;
  recipient: string;
  amountYocto: string;
  /** Height of the block referenced by the signed transaction's block_hash (null if never signed). */
  signedBlockHeight: number | null;
  /** transaction_validity_period read at signing (B0: 86,400 blocks). */
  validityPeriodBlocks: number | null;
  /** Whether the exact signed bytes are still stored (for an identical re-broadcast). */
  signedBytesAvailable: boolean;
};

/** "unavailable" = the record could not be read (RPC error): never decide on that basis. */
export type RecordState = PaymentRequestRecord | null | "unavailable";

export type RecoveryAction =
  | { action: "settle_confirmed" }                       // record Paid (then run the full verification)
  | { action: "settle_failed" }                          // record Failed: only the manual retry path
  | { action: "wait"; reason: string }                   // nothing safe to do yet
  | { action: "rebroadcast_same_bytes" }                 // validity window open: identical bytes only
  | { action: "eligible_for_resubmission"; requires: readonly string[] }
  | { action: "investigate"; reason: string };           // contradiction: never act automatically

const RESUBMISSION_REQUIREMENTS = [
  "same request ID, recipient, NEAR amount, NGN amount, agent, contract, code hash, network and method",
  "unchanged workflow fingerprint and policy versions",
  "a fresh security gate evaluation (not BLOCK; readiness, allowlist, limits, kill switch off, armed batch with capacity)",
  "a fresh owner approval bound to these identical details",
] as const;

export function decideRecovery(attempt: AttemptFacts, record: RecordState, currentFinalHeight: number | null): RecoveryAction {
  if (record === "unavailable") return { action: "wait", reason: "request record unavailable (RPC error)" };

  if (record) {
    if (record.recipient !== attempt.recipient || record.amount !== attempt.amountYocto) {
      return { action: "investigate", reason: "request record exists with different recipient or amount" };
    }
    if (record.status === "Paid") return { action: "settle_confirmed" };
    if (record.status === "Failed") return { action: "settle_failed" };
    // Pending: requested, not yet settled. NEVER submitted again as a new payment.
    return { action: "wait", reason: "request is Pending on-chain; never resubmit" };
  }

  // No record in the latest final state. Not proof of anything while the original could still land.
  if (attempt.signedBlockHeight === null || attempt.validityPeriodBlocks === null) {
    return { action: "investigate", reason: "validity window of the original transaction is unknown" };
  }
  if (currentFinalHeight === null) return { action: "wait", reason: "current final block height unavailable" };
  const expiresAfter = attempt.signedBlockHeight + attempt.validityPeriodBlocks;
  if (currentFinalHeight <= expiresAfter) {
    return attempt.signedBytesAvailable
      ? { action: "rebroadcast_same_bytes" }
      : { action: "wait", reason: `validity window open until block ${expiresAfter}` };
  }
  return { action: "eligible_for_resubmission", requires: RESUBMISSION_REQUIREMENTS };
}

/** Identical-details check for a resubmission or manual retry (all fields must match exactly). */
export function sameDetails(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if (a[k] !== b[k]) return false;
  return true;
}
