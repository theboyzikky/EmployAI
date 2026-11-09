import "server-only";
// M5 · Read-only NEAR JSON-RPC client. The ONLY place in the app that talks to NEAR RPC.
// No retries inside (callers decide); bounded by a timeout; fetch is injectable so tests never touch
// the network. The one write method, sendTx, only broadcasts bytes the signer already produced; it is
// never retried here and, until Phase 4, nothing in the app calls it.
import type { AccountView, TxStatusResult, ViewAccessKeyResponse } from "./types";

export type RpcErrorKind = "UNKNOWN_ACCOUNT" | "UNKNOWN_TRANSACTION" | "UNKNOWN_BLOCK" | "TIMEOUT" | "TRANSPORT" | "HTTP" | "RPC" | "BAD_RESPONSE";

export class RpcError extends Error {
  constructor(readonly kind: RpcErrorKind, message: string, readonly detail?: unknown) {
    super(message);
    this.name = "RpcError";
  }
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export type RpcClient = ReturnType<typeof createRpcClient>;

export function createRpcClient(opts: { url: string; fetchImpl?: FetchLike; timeoutMs?: number }) {
  const fetchImpl: FetchLike = opts.fetchImpl ?? ((u, i) => fetch(u, i));
  const timeoutMs = opts.timeoutMs ?? 10_000;

  async function call<T>(method: string, params: unknown): Promise<{ result?: T; error?: { name?: string; cause?: { name?: string; info?: unknown }; message?: string; data?: unknown } }> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(opts.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "employai", method, params }),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new RpcError("HTTP", `RPC HTTP ${res.status}`);
      const body = (await res.json()) as { result?: T; error?: never };
      if (!body || typeof body !== "object") throw new RpcError("BAD_RESPONSE", "RPC returned a non-object body");
      return body;
    } catch (e) {
      if (e instanceof RpcError) throw e;
      if ((e as Error)?.name === "AbortError") throw new RpcError("TIMEOUT", `RPC timed out after ${timeoutMs} ms`);
      throw new RpcError("TRANSPORT", "RPC transport error");
    } finally {
      clearTimeout(timer);
    }
  }

  const errorKind = (err: { cause?: { name?: string } } | undefined): RpcErrorKind => {
    const n = err?.cause?.name;
    return n === "UNKNOWN_ACCOUNT" || n === "UNKNOWN_TRANSACTION" || n === "UNKNOWN_BLOCK" ? n : "RPC";
  };

  return {
    /** `null` when the account does not exist (UNKNOWN_ACCOUNT). */
    async viewAccount(accountId: string): Promise<AccountView | null> {
      const r = await call<AccountView>("query", { request_type: "view_account", finality: "final", account_id: accountId });
      if (r.result) return r.result;
      if (errorKind(r.error) === "UNKNOWN_ACCOUNT") return null;
      throw new RpcError(errorKind(r.error), "view_account failed", r.error);
    },

    /** The RAW response: the strict key verifier must see `result.error` (B0-1) and RPC errors itself. */
    async viewAccessKey(accountId: string, publicKey: string): Promise<ViewAccessKeyResponse> {
      return (await call("query", { request_type: "view_access_key", finality: "final", account_id: accountId, public_key: publicKey })) as ViewAccessKeyResponse;
    },

    /** Call a view method; returns the decoded JSON result. */
    async viewFunction<T>(contractId: string, method: string, args: Record<string, unknown> = {}): Promise<T> {
      const r = await call<{ result: number[]; error?: string }>("query", {
        request_type: "call_function", finality: "final", account_id: contractId, method_name: method,
        args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
      });
      if (!r.result) throw new RpcError(errorKind(r.error), `view ${method} failed`, r.error);
      if (r.result.error) throw new RpcError("RPC", `view ${method} failed: ${r.result.error}`);
      try {
        return JSON.parse(Buffer.from(r.result.result).toString("utf8")) as T;
      } catch {
        throw new RpcError("BAD_RESPONSE", `view ${method} returned non-JSON`);
      }
    },

    /**
     * Final status of a transaction. "unknown_transaction" is NOT evidence that it never executed:
     * nodes prune old transactions (B0-4). Callers must decide from the contract's request record.
     */
    async txStatus(txHash: string, senderId: string): Promise<TxStatusResult | "unknown_transaction"> {
      const r = await call<TxStatusResult>("tx", { tx_hash: txHash, sender_account_id: senderId, wait_until: "FINAL" });
      if (r.result) return r.result;
      if (errorKind(r.error) === "UNKNOWN_TRANSACTION") return "unknown_transaction";
      throw new RpcError(errorKind(r.error), "tx status failed", r.error);
    },

    /**
     * Broadcast already-signed bytes (base64) and wait until FINAL. NOT retried here: a timeout or
     * transport error means the outcome is UNKNOWN (the transaction may still land), never "not sent".
     * Re-broadcasting the IDENTICAL bytes is the only safe repeat (plan §11.1).
     */
    async sendTx(signedTxBase64: string): Promise<TxStatusResult> {
      const r = await call<TxStatusResult>("send_tx", { signed_tx_base64: signedTxBase64, wait_until: "FINAL" });
      if (r.result) return r.result;
      throw new RpcError(errorKind(r.error), "send_tx failed", r.error);
    },

    async finalBlockHeight(): Promise<number> {
      const r = await call<{ header: { height: number } }>("block", { finality: "final" });
      if (!r.result?.header?.height) throw new RpcError(errorKind(r.error), "block failed", r.error);
      return r.result.header.height;
    },

    /** Transaction validity window in blocks (B0: 86,400). */
    async transactionValidityPeriod(): Promise<number> {
      const r = await call<{ transaction_validity_period: number }>("EXPERIMENTAL_protocol_config", { finality: "final" });
      const v = r.result?.transaction_validity_period;
      if (typeof v !== "number" || v <= 0) throw new RpcError(errorKind(r.error), "protocol config failed", r.error);
      return v;
    },
  };
}
