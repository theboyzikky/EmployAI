import "server-only";
// M5 · NEAR chain layer: response shapes used by the app. They mirror the public JSON-RPC responses
// observed in batch B0 and on the deployed treasury (docs/architecture/poc-results/m5-batches.md).

export type FunctionCallPermission = { allowance: string | null; receiver_id: string; method_names: string[] };
export type AccessKeyPermission = "FullAccess" | { FunctionCall: FunctionCallPermission };

/** Raw `query/view_access_key` response. B0-1: a missing key arrives as `result.error`, not as an RPC error. */
export type ViewAccessKeyResponse = {
  result?: { nonce?: number; permission?: AccessKeyPermission; block_hash?: string; block_height?: number; error?: string; logs?: unknown[] };
  error?: unknown;
};

export type AccountView = { amount: string; locked: string; code_hash: string; storage_usage: number; block_height: number; block_hash: string };

export type ExecutionStatus =
  | { SuccessValue: string }
  | { SuccessReceiptId: string }
  | { Failure: unknown }
  | "Unknown"
  | "Pending";

export type ExecutionOutcome = {
  id: string;
  block_hash: string;
  outcome: { executor_id: string; status: ExecutionStatus; logs: string[]; gas_burnt: number; tokens_burnt: string; receipt_ids: string[] };
};

/** `tx` method result (wait_until FINAL). */
export type TxStatusResult = {
  final_execution_status: string;
  status: ExecutionStatus;
  transaction: { hash: string; signer_id: string; receiver_id: string; nonce: number; public_key: string; actions: unknown[] };
  transaction_outcome: ExecutionOutcome;
  receipts_outcome: ExecutionOutcome[];
};

/** Treasury contract v1 views (contracts/treasury). Amounts are yoctoNEAR strings. */
export type RequestStatus = "Pending" | "Paid" | "Failed";
export type PaymentRequestRecord = {
  recipient: string; amount: string; day: number; status: RequestStatus; agent: string;
  requested_at_block: number; settled_at_block: number | null; attempts: number;
};
export type SpentToday = { day: number; spent: string; daily_cap: string };
export type TreasuryPolicy = { owner: string; agent: string | null; max_per_tx: string; daily_cap: string; paused: boolean; sales_enabled: boolean };
