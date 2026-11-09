import "server-only";
// M5 · Private owner ledger (plan §13, §16 GET /api/w/:id/ledger). Read-only (runRead on a private copy):
// nothing here writes, signs or calls the chain. Real on-chain rows come only from verified RPC
// outcomes (payment-executor.ts); simulated test-run rows are labelled as such; payments still in
// flight are listed separately and are NEVER shown as paid.
import { nearText } from "./agents";
import { explorerLinks } from "./payment-executor";
import { runRead } from "./repo";
import { TERMINAL_ATTEMPT_STATUSES, type LedgerRecord, type PaymentAttempt } from "./types";

export type LedgerRowView = {
  id: string;
  kind: "onchain_paid" | "onchain_failed" | "simulated";
  label: string;
  amountText: string;               // "0.031 NEAR" or "₦42,780"
  businessAmountNgn: number;        // illustrative NGN business amount (never converted)
  recipient: string;                // account ID (testnet) or demo supplier name (simulated)
  supplier: string | null;
  txHash: string | null;
  explorer: { primary: string; secondary: string } | null;
  runId: string;
  requestId: string;
  batch: string | null;
  occurredAt: string;
};

export type PendingPaymentView = { attemptId: string; runId: string; status: string; recipient: string; amountText: string; txHash: string | null; since: string };

export type LedgerView = {
  businessId: string;
  totals: { paidNear: string; paidCount: number; failedCount: number; simulatedCount: number; pendingCount: number };
  rows: LedgerRowView[];            // newest first
  pending: PendingPaymentView[];
};

function rowOf(l: LedgerRecord): LedgerRowView {
  if (l.mode === "testnet") {
    return {
      id: l.id, kind: l.tx_status === "confirmed" ? "onchain_paid" : "onchain_failed", label: l.label,
      amountText: `${nearText(l.amount)} NEAR`, businessAmountNgn: l.amount_ngn_business, recipient: l.counterparty, supplier: l.supplier_name,
      txHash: l.tx_hash, explorer: l.tx_hash ? explorerLinks(l.tx_hash) : null, runId: l.run_id, requestId: l.request_id, batch: l.batch_id, occurredAt: l.occurred_at,
    };
  }
  return {
    id: l.id, kind: "simulated", label: l.label, amountText: `₦${l.amount.toLocaleString("en-NG")}`, businessAmountNgn: l.amount,
    recipient: l.counterparty, supplier: null, txHash: null, explorer: null, runId: l.run_id, requestId: l.request_id, batch: null, occurredAt: l.occurred_at,
  };
}

const pendingOf = (a: PaymentAttempt): PendingPaymentView => ({
  attemptId: a.id, runId: a.run_id, status: a.status, recipient: a.recipient, amountText: `${nearText(a.amount_yocto)} NEAR`, txHash: a.tx_hash, since: a.created_at,
});

export function buildLedgerView(businessId: string): Promise<LedgerView> {
  return runRead(tx => {
    const ledger = tx.ledger(businessId).slice().sort((a, b) => b.occurred_at.localeCompare(a.occurred_at));
    const rows = ledger.map(rowOf);
    const pending = tx.attempts(businessId).filter(a => !TERMINAL_ATTEMPT_STATUSES.includes(a.status)).map(pendingOf);
    const paid = ledger.filter(l => l.mode === "testnet" && l.tx_status === "confirmed");
    const paidYocto = paid.reduce((t, l) => t + BigInt(l.amount as string), BigInt(0));
    return {
      businessId,
      totals: {
        paidNear: nearText(paidYocto.toString()), paidCount: paid.length,
        failedCount: rows.filter(r => r.kind === "onchain_failed").length, simulatedCount: rows.filter(r => r.kind === "simulated").length, pendingCount: pending.length,
      },
      rows, pending,
    };
  });
}
