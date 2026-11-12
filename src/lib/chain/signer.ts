import "server-only";
// M5 · Signer wrapper (plan §4.3 Phase B, §5.3, §10, §11.1). Produces ONE signed
// `treasury.request_payment` transaction for the Finance Agent, after every check passes, and returns
// the write-ahead data (hash, nonce, signed bytes, validity window). It does NOT broadcast: the caller
// stores the write-ahead record first, then calls `broadcastSigned` (identical bytes on any retry).
//
// Fail closed, in this order (any failure → SignerRefusal, nothing signed):
//   1. configuration = the approved B1 accounts on testnet, and the loaded key = the approved FC key;
//   2. request ID and amount valid; amount ≤ 0.1 NEAR (R16);
//   3. treasury readiness: code hash, policy (owner, agent, 0.1 / 0.25 NEAR), not paused, sales off,
//      key, agent gas, treasury funds;
//   4. recipient exists, is a plain account, and is on the on-chain allowlist;
//   5. today's total + amount ≤ 0.25 NEAR (the contract enforces this too);
//   6. duplicate protection: (a) from the contract's own request record — a new payment needs NO record;
//      a manual retry needs a Failed record with identical recipient and amount; Pending/Paid → refuse;
//      a resubmission (plan §11.1) needs NO record, the same details and an EXPIRED validity window;
//      (b) in-process — each (request, attempt) is signed at most once, so two concurrent callers can
//      never produce two different signed transactions for the same payment attempt;
//   7. IMMEDIATELY BEFORE SIGNING: a fresh on-chain read of the key, which must be exactly
//      FunctionCall(treasury, ["request_payment"], allowance null). FullAccess (e.g. the owner's key)
//      is refused. Its block hash and nonce are used for the transaction.
// Single process: one in-process mutex per key orders nonces (plan K9; no multi-instance claim).
import { PublicKey, actions, baseDecode, baseEncode, createTransaction } from "near-api-js";
import { APPROVED_ACCOUNTS, NEAR_DAILY_CAP_YOCTO, NEAR_MAX_PER_TX_YOCTO, REQUEST_PAYMENT_GAS, type ChainConfig } from "./config";
import { verifyRestrictedKey } from "./key-check";
import type { AgentKeyHandle } from "./keys";
import type { ChainReader } from "./port";
import { checkReadiness, checkRecipient } from "./readiness";
import type { RpcClient } from "./rpc";
import type { TxStatusResult } from "./types";

export type SignerRefusalCode =
  | "ACCOUNT_CONFIG_MISMATCH" | "INVALID_REQUEST_ID" | "INVALID_AMOUNT" | "OVER_TX_LIMIT" | "OVER_DAILY_LIMIT"
  | "DUPLICATE_REQUEST" | "RETRY_NOT_ALLOWED" | "RESUBMIT_NOT_ALLOWED" | "CHAIN_UNAVAILABLE" | "SIGNING_FAILED" | "KEY_MISMATCH"
  | "TREASURY_NOT_FOUND" | "TREASURY_CODE_MISMATCH" | "TREASURY_POLICY_MISMATCH" | "TREASURY_PAUSED"
  | "SALES_UNEXPECTEDLY_ENABLED" | "SIGNER_KEY_UNSAFE" | "INSUFFICIENT_GAS" | "TREASURY_UNDERFUNDED"
  | "RECIPIENT_NOT_FOUND" | "RECIPIENT_NOT_APPROVED_ONCHAIN" | "RECIPIENT_IS_CONTRACT";

export class SignerRefusal extends Error {
  constructor(readonly code: SignerRefusalCode, readonly detail: string) {
    super(`${code}: ${detail}`);
    this.name = "SignerRefusal";
  }
}

export type PaymentToSign = {
  requestId: string;
  recipient: string;
  amountYocto: string;
  /**
   * Hosted demo: the highest nonce any server instance has persisted for this key (shared store). The
   * new nonce is above it AND above the on-chain nonce, so instances never reuse a nonce even before
   * the chain has seen the previous transaction. Absent/null locally.
   */
  minNonceExclusive?: string | null;
} & (
  /** No on-chain record may exist, and this process must not have signed this request before. */
  | { mode: "new" }
  /** Manual retry (R12): the on-chain record must be Failed with identical recipient and amount. */
  | { mode: "retry_after_failed" }
  /**
   * Plan §11.1 safe resubmission of a payment whose earlier signed transaction never landed: requires
   * no on-chain record, identical details, and the earlier transaction's validity window to have
   * EXPIRED by block height (so the old bytes can never execute). The caller must also hold fresh gate
   * and owner approval (Phase 4); the signer enforces only the chain-side conditions.
   */
  | { mode: "resubmit_after_expiry"; previous: Pick<SignedPayment, "args" | "expiresAfterHeight"> }
);

/** Write-ahead data: stored BEFORE broadcast. Contains no secret (the signed bytes are public once sent). */
export type SignedPayment = {
  txHash: string;
  signedTxBase64: string;
  signerId: string;
  publicKey: string;
  receiverId: string;
  method: "request_payment";
  args: { request_id: string; recipient: string; amount: string };
  nonce: string;
  blockHash: string;
  signedBlockHeight: number;
  validityPeriodBlocks: number;
  expiresAfterHeight: number;
};

const REQUEST_ID = /^[A-Za-z0-9:_-]{8,64}$/;
const AMOUNT = /^[1-9]\d{0,39}$/;

// ---- per-key ordering (single process). The state lives on globalThis, like the store and the business
// lock: Next gives each route bundle its own module copies, and these guards must be ONE per process.
type SignerState = { lastNonce: Map<string, bigint>; queues: Map<string, Promise<unknown>>; signedAttempts: Set<string> };
const SIGNER_STATE = Symbol.for("employai.signerState");
const gs = globalThis as unknown as { [SIGNER_STATE]?: SignerState };
const signerState: SignerState = (gs[SIGNER_STATE] ??= { lastNonce: new Map(), queues: new Map(), signedAttempts: new Set() });
const { lastNonce, queues } = signerState;
/** (requestId#attempt) pairs signed by this process. */
const signedAttempts = signerState.signedAttempts;
function withKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  queues.set(key, run.then(() => undefined, () => undefined));
  return run;
}
/** Test hook: forget the in-process nonce memory. */
export function resetSignerStateForTests() { lastNonce.clear(); queues.clear(); signedAttempts.clear(); }

export async function signPaymentRequest(
  deps: { chain: ChainReader; config: ChainConfig; agentKey: AgentKeyHandle },
  pay: PaymentToSign,
): Promise<SignedPayment> {
  const { chain, config, agentKey } = deps;

  // 1 · configuration must be exactly the approved B1 accounts on testnet
  if (config.network !== "testnet" || config.owner !== APPROVED_ACCOUNTS.owner || config.treasury !== APPROVED_ACCOUNTS.treasury || config.agent !== APPROVED_ACCOUNTS.agent) {
    throw new SignerRefusal("ACCOUNT_CONFIG_MISMATCH", "configuration differs from the approved testnet accounts");
  }
  if (agentKey.publicKey !== APPROVED_ACCOUNTS.agentPublicKey) {
    throw new SignerRefusal("KEY_MISMATCH", "the loaded key is not the approved restricted Finance Agent key");
  }
  // 2 · request and amount
  if (!REQUEST_ID.test(pay.requestId)) throw new SignerRefusal("INVALID_REQUEST_ID", "request IDs are 8–64 characters of [A-Za-z0-9:_-]");
  if (!AMOUNT.test(pay.amountYocto)) throw new SignerRefusal("INVALID_AMOUNT", "amount must be a positive integer in yoctoNEAR");
  const amount = BigInt(pay.amountYocto);
  if (amount > NEAR_MAX_PER_TX_YOCTO) throw new SignerRefusal("OVER_TX_LIMIT", "amount is over 0.1 NEAR");

  return withKeyLock(agentKey.publicKey, async () => {
    let phase: "read" | "sign" = "read";
    try {
      // 3 · treasury readiness (includes a key check, the code hash and the policy)
      const ready = await checkReadiness(chain, config, agentKey.publicKey, amount);
      if (!ready.ready) {
        const f = ready.failures[0];
        throw new SignerRefusal(f.code as SignerRefusalCode, f.detail);
      }
      // 4 · recipient
      const r = await checkRecipient(chain, config, pay.recipient);
      if (!r.ok) throw new SignerRefusal(r.code as SignerRefusalCode, r.detail);
      // 5 · daily limit (Pending + Paid today, as the contract counts it)
      const spent = await chain.getSpentToday(config.treasury);
      if (spent.daily_cap !== NEAR_DAILY_CAP_YOCTO.toString()) throw new SignerRefusal("TREASURY_POLICY_MISMATCH", "daily cap differs");
      if (BigInt(spent.spent) + amount > NEAR_DAILY_CAP_YOCTO) throw new SignerRefusal("OVER_DAILY_LIMIT", "today's total would exceed 0.25 NEAR");
      // 6 · duplicate protection from the contract's own record
      const record = await chain.getRequest(config.treasury, pay.requestId);
      const attemptKey = `${pay.requestId}#${record ? record.attempts : 0}`;
      if (pay.mode === "new") {
        if (record) throw new SignerRefusal("DUPLICATE_REQUEST", `request already ${record.status} on-chain`);
        if (signedAttempts.has(attemptKey)) throw new SignerRefusal("DUPLICATE_REQUEST", "request already signed by this process; recover it (plan §11.1), do not re-sign");
      } else if (pay.mode === "retry_after_failed") {
        if (!record || record.status !== "Failed") throw new SignerRefusal("RETRY_NOT_ALLOWED", `retry needs a Failed record (found ${record ? record.status : "none"})`);
        if (record.recipient !== pay.recipient || record.amount !== pay.amountYocto) throw new SignerRefusal("RETRY_NOT_ALLOWED", "retry must use identical recipient and amount");
        if (signedAttempts.has(attemptKey)) throw new SignerRefusal("DUPLICATE_REQUEST", "this retry was already signed by this process");
      } else {
        const p = pay.previous.args;
        if (record) throw new SignerRefusal("RESUBMIT_NOT_ALLOWED", `request is ${record.status} on-chain`);
        if (p.request_id !== pay.requestId || p.recipient !== pay.recipient || p.amount !== pay.amountYocto) throw new SignerRefusal("RESUBMIT_NOT_ALLOWED", "resubmission must use identical details");
        const height = await chain.finalBlockHeight();
        if (!(height > pay.previous.expiresAfterHeight)) throw new SignerRefusal("RESUBMIT_NOT_ALLOWED", `earlier transaction still valid until block ${pay.previous.expiresAfterHeight} (now ${height})`);
      }
      const validity = await chain.transactionValidityPeriod();
      // 7 · fresh key check immediately before signing; its block hash and nonce build the transaction
      const keyResp = await chain.viewAccessKey(config.agent, agentKey.publicKey);
      const key = verifyRestrictedKey(keyResp, { treasury: config.treasury });
      if (!key.ok) throw new SignerRefusal("SIGNER_KEY_UNSAFE", key.reason);
      const blockHash = keyResp.result?.block_hash;
      const blockHeight = keyResp.result?.block_height;
      if (typeof blockHash !== "string" || typeof blockHeight !== "number") throw new SignerRefusal("CHAIN_UNAVAILABLE", "key view has no block reference");

      const onChain = BigInt(key.nonce);
      const prev = lastNonce.get(agentKey.publicKey) ?? onChain;
      const floor = pay.minNonceExclusive && /^\d{1,30}$/.test(pay.minNonceExclusive) ? BigInt(pay.minNonceExclusive) : onChain;
      let top = onChain > prev ? onChain : prev;
      if (floor > top) top = floor;
      const nonce = top + BigInt(1);
      const args = { request_id: pay.requestId, recipient: pay.recipient, amount: pay.amountYocto };
      const tx = createTransaction(
        config.agent, PublicKey.fromString(agentKey.publicKey), config.treasury, nonce,
        [actions.functionCall("request_payment", args, REQUEST_PAYMENT_GAS, BigInt(0))],
        baseDecode(blockHash),
      );
      // From here on a failure is a LOCAL signing failure, not a chain read (distinct codes).
      phase = "sign";
      const signed = await agentKey.signTransaction(tx);
      const out: SignedPayment = {
        txHash: baseEncode(signed.txHash),
        signedTxBase64: Buffer.from(signed.signedTransaction.encode()).toString("base64"),
        signerId: config.agent, publicKey: agentKey.publicKey, receiverId: config.treasury, method: "request_payment", args,
        nonce: nonce.toString(), blockHash, signedBlockHeight: blockHeight, validityPeriodBlocks: validity,
        expiresAfterHeight: blockHeight + validity,
      };
      lastNonce.set(agentKey.publicKey, nonce);
      signedAttempts.add(attemptKey);
      return out;
    } catch (e) {
      if (e instanceof SignerRefusal) throw e;
      if (phase === "sign") throw new SignerRefusal("SIGNING_FAILED", "the signing step failed locally; nothing was returned for broadcast");
      throw new SignerRefusal("CHAIN_UNAVAILABLE", "a chain read failed; nothing was signed");
    }
  });
}

export type BroadcastResult =
  | { status: "final"; result: TxStatusResult }
  | { status: "unknown"; reason: string };

/**
 * Broadcast write-ahead bytes ONCE. Never retried here and never re-signed: an error or timeout means
 * the outcome is UNKNOWN (the transaction may still land). Recovery then follows plan §11.1, where the
 * only safe repeat is re-broadcasting these IDENTICAL bytes while the validity window is open.
 */
export async function broadcastSigned(rpc: Pick<RpcClient, "sendTx">, signed: Pick<SignedPayment, "signedTxBase64">): Promise<BroadcastResult> {
  try {
    return { status: "final", result: await rpc.sendTx(signed.signedTxBase64) };
  } catch (e) {
    const kind = (e as { kind?: string })?.kind ?? "UNKNOWN";
    return { status: "unknown", reason: `broadcast outcome unknown (${kind}); reconcile via get_request` };
  }
}
