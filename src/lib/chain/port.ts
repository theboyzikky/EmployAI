import "server-only";
// M5 · ChainReader: the read-only port the rest of the app uses (readiness, verification, recovery).
// The runner never imports rpc.ts directly; tests use an in-memory fake (tests/helpers/fake-chain.ts).
// Signing lives in signer.ts (key from keys.ts); this port stays read-only.
import type { RpcClient } from "./rpc";
import type { AccountView, PaymentRequestRecord, SpentToday, TreasuryPolicy, TxStatusResult, ViewAccessKeyResponse } from "./types";

export interface ChainReader {
  viewAccount(accountId: string): Promise<AccountView | null>;
  viewAccessKey(accountId: string, publicKey: string): Promise<ViewAccessKeyResponse>;
  getPolicy(treasury: string): Promise<TreasuryPolicy>;
  /** `null` = no record in the latest final state (not proof that nothing executed; see recovery.ts). */
  getRequest(treasury: string, requestId: string): Promise<PaymentRequestRecord | null>;
  isApproved(treasury: string, accountId: string): Promise<boolean>;
  getSalesEnabled(treasury: string): Promise<boolean>;
  /** The current UTC day's total (Pending + Paid), as the contract counts it for the daily cap. */
  getSpentToday(treasury: string): Promise<SpentToday>;
  txStatus(txHash: string, senderId: string): Promise<TxStatusResult | "unknown_transaction">;
  finalBlockHeight(): Promise<number>;
  transactionValidityPeriod(): Promise<number>;
}

export function chainReaderFromRpc(rpc: RpcClient): ChainReader {
  return {
    viewAccount: id => rpc.viewAccount(id),
    viewAccessKey: (id, pk) => rpc.viewAccessKey(id, pk),
    getPolicy: t => rpc.viewFunction<TreasuryPolicy>(t, "get_policy"),
    getRequest: (t, requestId) => rpc.viewFunction<PaymentRequestRecord | null>(t, "get_request", { request_id: requestId }),
    isApproved: (t, account) => rpc.viewFunction<boolean>(t, "is_approved", { account }),
    getSalesEnabled: async t => (await rpc.viewFunction<{ enabled: boolean }>(t, "get_sales_config")).enabled,
    getSpentToday: t => rpc.viewFunction<SpentToday>(t, "get_spent_today"),
    txStatus: (h, s) => rpc.txStatus(h, s),
    finalBlockHeight: () => rpc.finalBlockHeight(),
    transactionValidityPeriod: () => rpc.transactionValidityPeriod(),
  };
}
