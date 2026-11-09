// M4 · Authorisation for a payment request (doc 03 table 8; threat model T2).
// - ALLOW at or below the threshold → an authorisation already approved (auto_approved);
//   WARN (which includes "above the threshold") → a PENDING authorisation for the owner; BLOCK → none.
// - The action hash binds the business, run, request ID, payee, amount and channel method, so a payee or
//   amount changed after approval is refused when the authorisation is used.
// - Using it is once only and atomic (RunTx.consumeApproval). In M4 the only thing an authorisation can
//   ever produce is a SIMULATED outcome (C3): there is no signer, key, contract or network here (C4).
import { canonicalJson, sha256Hex } from "@/lib/runs/fingerprint";
import type { PaymentBinding } from "@/lib/runs/types";
import type { GateDecisionValue } from "./gate";

export const APPROVAL_EXPIRY_MS = 15 * 60 * 1000;   // D13

export type PaymentAction = {
  businessId: string;
  runId: string;
  requestId: string;
  beneficiary: string;
  amountNgn: number;
  method: "request_payment";
};

export const actionHash = (a: PaymentAction) => sha256Hex(canonicalJson({
  business_id: a.businessId, run_id: a.runId, request_id: a.requestId, beneficiary: a.beneficiary, amount_ngn: a.amountNgn, method: a.method,
}));

/** M5 · Testnet action hash: sha256 over the canonical JSON of the full binding (plan §8.3, V1). */
export const testnetActionHash = (b: PaymentBinding) => sha256Hex(canonicalJson(b));

/** The binding fields that differ between two bindings (for APPROVAL_STALE reporting). */
export const bindingDiff = (a: PaymentBinding, b: PaymentBinding): string[] =>
  (Object.keys(a) as Array<keyof PaymentBinding>).filter(k => a[k] !== b[k]);

/** What the gate decision means for the approval step. */
export function authorisationFor(decision: GateDecisionValue): "auto_approved" | "needs_owner" | "none" {
  if (decision === "BLOCK") return "none";
  return decision === "ALLOW" ? "auto_approved" : "needs_owner";
}

export const expiresAt = (nowIso: string) => new Date(Date.parse(nowIso) + APPROVAL_EXPIRY_MS).toISOString();
export const isExpired = (expiresAtIso: string, nowIso: string) => expiresAtIso <= nowIso;
