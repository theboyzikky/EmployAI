import "server-only";
// M5 · Payout verification (plan §12, AC5-5). A payout is CONFIRMED only when all four hold:
//   1. the transaction is FINAL and its overall status is a success,
//   2. the on_payout callback returned `true`,
//   3. a payout_completed event matches the request ID, recipient, amount and agent,
//   4. the contract's request record (get_request) says Paid with the same recipient and amount.
// F2: a failed transfer still ends in a SUCCESSFUL transaction (the callback returns false), so the
// transaction status alone never decides. Anything not provably confirmed or failed is "unknown".
import type { ExecutionOutcome, ExecutionStatus, PaymentRequestRecord, TxStatusResult } from "./types";

export type PayoutExpectation = { requestId: string; recipient: string; amountYocto: string; agent: string; treasury: string };

export type PayoutVerdict =
  | { outcome: "confirmed"; txHash: string; gasBurnt: number; tokensBurntYocto: string }
  | { outcome: "failed_onchain"; kind: "contract_rejected"; panic: string; txHash: string }
  | { outcome: "failed_onchain"; kind: "transfer_failed"; rolledBack: boolean | null; txHash: string }
  | { outcome: "unknown"; reason: string };

const EVENT_STANDARD = "employai-treasury";
const EVENT_VERSION = "1.0.0";

type TreasuryEvent = { event: string; data: Record<string, unknown> };

function parseEvents(outcomes: ExecutionOutcome[], treasury: string): TreasuryEvent[] {
  const out: TreasuryEvent[] = [];
  for (const o of outcomes) {
    if (o.outcome.executor_id !== treasury) continue;
    for (const log of o.outcome.logs) {
      if (!log.startsWith("EVENT_JSON:")) continue;
      try {
        const j = JSON.parse(log.slice("EVENT_JSON:".length)) as { standard?: string; version?: string; event?: string; data?: unknown[] };
        if (j.standard === EVENT_STANDARD && j.version === EVENT_VERSION && typeof j.event === "string" && Array.isArray(j.data) && j.data[0] && typeof j.data[0] === "object") {
          out.push({ event: j.event, data: j.data[0] as Record<string, unknown> });
        }
      } catch { /* not a treasury event */ }
    }
  }
  return out;
}

const isFailure = (s: ExecutionStatus): s is { Failure: unknown } => typeof s === "object" && s !== null && "Failure" in s;
const successValue = (s: ExecutionStatus): string | null => (typeof s === "object" && s !== null && "SuccessValue" in s ? s.SuccessValue : null);
const decode = (b64: string) => { try { return Buffer.from(b64, "base64").toString("utf8"); } catch { return ""; } };

/** "Smart contract panicked: X" → "X" (from a FunctionCallError.ExecutionError), else null. */
function panicMessage(failure: unknown): string | null {
  const text = JSON.stringify(failure);
  const m = /Smart contract panicked: ([^"\\]+)/.exec(text);
  return m ? m[1] : null;
}

const matches = (d: Record<string, unknown>, e: PayoutExpectation) =>
  d.request_id === e.requestId && d.recipient === e.recipient && d.amount === e.amountYocto && d.agent === e.agent;

export function verifyPayout(tx: TxStatusResult, expected: PayoutExpectation, record: PaymentRequestRecord | null): PayoutVerdict {
  const hash = tx.transaction.hash;
  if (tx.final_execution_status !== "FINAL") return { outcome: "unknown", reason: `not final (${tx.final_execution_status})` };
  if (tx.transaction.signer_id !== expected.agent || tx.transaction.receiver_id !== expected.treasury) {
    return { outcome: "unknown", reason: "transaction signer/receiver do not match this payment" };
  }
  const receipts = tx.receipts_outcome;

  // Contract rejected the request: the call panicked, every state change was reverted, no transfer.
  const rejected = receipts.find(o => o.outcome.executor_id === expected.treasury && isFailure(o.outcome.status));
  if (rejected) {
    const transferred = receipts.some(o => o.outcome.executor_id === expected.recipient);
    if (transferred) return { outcome: "unknown", reason: "contract failure together with a recipient receipt" };
    const panic = panicMessage((rejected.outcome.status as { Failure: unknown }).Failure);
    if (!panic) return { outcome: "unknown", reason: "treasury receipt failed without a contract panic message" };
    return { outcome: "failed_onchain", kind: "contract_rejected", panic, txHash: hash };
  }

  const events = parseEvents(receipts, expected.treasury);
  const completed = events.find(ev => ev.event === "payout_completed" && ev.data.request_id === expected.requestId);
  const failed = events.find(ev => ev.event === "payout_failed" && ev.data.request_id === expected.requestId);
  const callback = receipts.find(o => o.outcome.executor_id === expected.treasury && o.outcome.logs.some(l => /"event":"payout_(completed|failed)"/.test(l)));
  const callbackValue = callback ? successValue(callback.outcome.status) : null;
  const overall = successValue(tx.status);

  if (completed && failed) return { outcome: "unknown", reason: "both payout_completed and payout_failed present" };

  if (completed) {
    if (!matches(completed.data, expected)) return { outcome: "unknown", reason: "payout_completed does not match the expected payment" };
    if (callbackValue === null || decode(callbackValue) !== "true") return { outcome: "unknown", reason: "on_payout did not return true" };
    if (overall === null) return { outcome: "unknown", reason: "overall transaction status is not a success" };
    if (!record) return { outcome: "unknown", reason: "no request record yet" };
    if (record.status !== "Paid" || record.recipient !== expected.recipient || record.amount !== expected.amountYocto || record.agent !== expected.agent) {
      return { outcome: "unknown", reason: `request record does not confirm (status ${record.status})` };
    }
    const all = [tx.transaction_outcome, ...receipts];
    return {
      outcome: "confirmed", txHash: hash,
      gasBurnt: all.reduce((s, o) => s + o.outcome.gas_burnt, 0),
      tokensBurntYocto: all.reduce((s, o) => s + BigInt(o.outcome.tokens_burnt), BigInt("0")).toString(),
    };
  }

  if (failed) {
    if (!matches(failed.data, expected)) return { outcome: "unknown", reason: "payout_failed does not match the expected payment" };
    if (callbackValue === null || decode(callbackValue) !== "false") return { outcome: "unknown", reason: "on_payout did not return false" };
    if (record && record.status !== "Failed") return { outcome: "unknown", reason: `payout_failed but request record says ${record.status}` };
    const rb = failed.data.rolled_back;
    return { outcome: "failed_onchain", kind: "transfer_failed", rolledBack: typeof rb === "boolean" ? rb : null, txHash: hash };
  }

  return { outcome: "unknown", reason: "no settlement event for this request yet" };
}
