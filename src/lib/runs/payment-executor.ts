import "server-only";
// M5 · Payment executor: Phase B of a testnet payment (plan §4.1, §4.3, §4.4, §11). Runs OUTSIDE the
// business lock, one driver per attempt (compare-and-set lease), and never holds a secret: signing and
// RPC happen behind the injected PaymentChain.
//
// Invariants:
//  - a signature is made ONLY from `prepared`, and only after a fresh kill-switch / run / batch read and
//    a fresh binding re-check (on-chain policy read now);
//  - the signed transaction is persisted (write-ahead) BEFORE it is ever broadcast;
//  - once an attempt has a persisted signature (signed / submitting / unknown) it is NEVER signed
//    again: recovery re-broadcasts the IDENTICAL bytes while the validity window is open, or proves it
//    expired by block height with no contract record (§11.1);
//  - an unknown outcome is reconciled from the contract's request record, never retried blindly;
//  - "confirmed" and the ledger row are written only from a verified RPC outcome (§12), in one write.
import { randomUUID } from "node:crypto";
import { bindingDiff, testnetActionHash } from "@/lib/security/authorisation";
import { currentBinding } from "./binding";
import type { ChainVerdict, PaymentChain, SignedPaymentData } from "./payment-port";
import { runRead, runTransact, type RunTx } from "./repo";
import { nonceFloor, signerNonceKey, takeSigner, type SignerSlot } from "./signer-lease";
import type { Lease } from "@/lib/store/lease";
import { TERMINAL_ATTEMPT_STATUSES, type AttemptStatus, type PaymentAttempt } from "./types";

/** This server process. Leases name it, so a restarted server can tell stale leases from live ones. */
const INSTANCE = randomUUID();
export const ATTEMPT_LEASE_MS = 60_000;
export const MAX_PRE_SIGN_ERRORS = 3;
/**
 * Explorer links (B0-7, verified 2026-11-09 with the B3 transaction): NEAR Rocks (by FastNear) shows the
 * full transaction; NearBlocks is the format the official NEAR explorer selector links to, but it puts a
 * bot check in front of automated browsers. The ledger's proof is still the hash and the stored outcome.
 */
export const EXPLORER_TX_URL = "https://testnet.near.rocks/tx/";
export const NEARBLOCKS_TX_URL = "https://testnet.nearblocks.io/txns/";
export const explorerLinks = (txHash: string) => ({ primary: `${EXPLORER_TX_URL}${txHash}`, secondary: `${NEARBLOCKS_TX_URL}${txHash}` });

const addMs = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString();
const isTerminal = (s: AttemptStatus) => TERMINAL_ATTEMPT_STATUSES.includes(s);

type Ctx = { businessId: string; attemptId: string; owner: string; chain: PaymentChain };

/** Drive every unfinished attempt of a run once (restart recovery and normal progress alike). */
export async function driveRunAttempts(businessId: string, runId: string, chain: PaymentChain): Promise<void> {
  const ids = await runRead(businessId, tx => tx.attempts(businessId).filter(a => a.run_id === runId && !isTerminal(a.status)).map(a => a.id));
  for (const id of ids) await driveAttempt(businessId, id, chain);
}

/** Drive one attempt as far as it can safely go now. Returns its status, or "busy" if another driver holds it. */
export async function driveAttempt(businessId: string, attemptId: string, chain: PaymentChain): Promise<AttemptStatus | "busy" | "missing"> {
  const owner = `${INSTANCE}:${randomUUID()}`;
  const claimed = await runTransact(businessId, tx => tx.claimAttempt(businessId, attemptId, owner, addMs(tx.now, ATTEMPT_LEASE_MS)));
  if (!claimed) return (await runRead(businessId, tx => tx.attempt(businessId, attemptId))) ? "busy" : "missing";
  const ctx: Ctx = { businessId, attemptId, owner, chain };
  try {
    // A lease we just took over from a crashed driver: settle the in-between states first.
    if (claimed.status === "signing") {
      // Nothing was persisted, so nothing can have been broadcast: safe to start again from prepared.
      await runTransact(businessId, tx => { if (tx.patchAttempt(businessId, attemptId, ["signing"], { status: "prepared" }, owner)) note(tx, ctx, "recovered", "signing was interrupted before the write-ahead; nothing was sent"); });
    } else if (claimed.status === "submitting") {
      // The bytes may have reached the network: the outcome is UNKNOWN until reconciled.
      await runTransact(businessId, tx => { if (tx.patchAttempt(businessId, attemptId, ["submitting"], { status: "unknown" }, owner)) event(tx, ctx, "payment.unknown", "unknown", { reason: "interrupted during broadcast" }); });
    }
    for (let i = 0; i < 6; i++) {
      const a = await runRead(businessId, tx => tx.attempt(businessId, attemptId));
      if (!a) return "missing";
      if (isTerminal(a.status)) return a.status;
      const next = a.status === "prepared" ? await fromPrepared(ctx, a)
        : a.status === "signed" ? await fromSigned(ctx, a)
        : a.status === "unknown" ? await fromUnknown(ctx, a)
        : "stop";
      if (next === "stop") break;
    }
    return (await runRead(businessId, tx => tx.attempt(businessId, attemptId)))?.status ?? "missing";
  } finally {
    await runTransact(businessId, tx => tx.releaseAttempt(businessId, attemptId, owner));
  }
}

// ---------------------------------------------------------------------------------------------------

function event(tx: RunTx, ctx: Ctx, type: string, status: string, payload: Record<string, unknown> = {}) {
  const a = tx.attempt(ctx.businessId, ctx.attemptId);
  tx.appendEvent(ctx.businessId, "agent:finance", type, `attempt:${ctx.attemptId}`, status, a?.run_id ?? ctx.attemptId, payload);
}

function note(tx: RunTx, ctx: Ctx, result: string, detail: string) {
  const a = tx.attempt(ctx.businessId, ctx.attemptId);
  if (!a) return;
  tx.patchAttempt(ctx.businessId, ctx.attemptId, [a.status], { checks: [...a.checks, { at: tx.now, result, detail }].slice(-20) });
}

/** Abort before broadcast: nothing was (or ever will be) sent; any signed bytes are discarded. */
function abort(tx: RunTx, ctx: Ctx, from: readonly AttemptStatus[], code: string, message: string): boolean {
  const ok = tx.patchAttempt(ctx.businessId, ctx.attemptId, from, { status: "aborted", signed_tx_b64: null, error: { code, message } });
  if (ok) event(tx, ctx, "payment.aborted", "aborted", { code });
  return ok;
}

type Next = "continue" | "stop";

/** Why the run can't send now (kill switch, stop, ended run, batch gone), or null. */
function blockedReason(tx: RunTx, a: PaymentAttempt): { code: string; message: string } | null {
  if (tx.business(a.business_id)?.kill_switch) return { code: "KILL_SWITCH_ACTIVE", message: "The kill switch is on, so the payment was not sent." };
  const run = tx.run(a.business_id, a.run_id);
  if (!run || run.control === "stop" || run.status === "cancelled") return { code: "STOPPED_BY_OWNER", message: "The run was stopped, so the payment was not sent." };
  if (run.status !== "running") return { code: "RUN_NOT_RUNNING", message: "The run is no longer running, so the payment was not sent." };
  return null;
}

async function fromPrepared(ctx: Ctx, a: PaymentAttempt): Promise<Next> {
  const { businessId, attemptId, owner, chain } = ctx;
  // 1 · fresh local read: kill switch, run state and batch, then take `signing` (compare-and-set)
  const go = await runTransact(ctx.businessId, tx => {
    const blocked = blockedReason(tx, a);
    if (blocked) { abort(tx, ctx, ["prepared"], blocked.code, blocked.message); return false; }
    const batch = tx.batches(businessId).find(b => b.id === a.batch_id);
    if (!batch || batch.disarmed_at || batch.expires_at <= tx.now) { abort(tx, ctx, ["prepared"], "BATCH_NOT_ARMED", "The testnet batch is no longer armed, so the payment was not sent."); return false; }
    return tx.patchAttempt(businessId, attemptId, ["prepared"], { status: "signing" }, owner);
  });
  if (!go) return "stop";

  // 2 · binding re-check immediately before signing, with the on-chain policy read NOW (§8.3)
  let npv: string;
  try { npv = await chain.nearPolicyVersion(); }
  catch { return preSignFailure(ctx, "CHAIN_UNAVAILABLE", "The NEAR testnet couldn't be reached before signing; nothing was signed."); }
  const stale = await runRead(ctx.businessId, tx => {
    const run = tx.run(businessId, a.run_id);
    const approval = tx.approvals(businessId).find(x => x.id === a.approval_id);
    if (!run || !approval?.binding) return ["approval"];
    const now = currentBinding(tx, run, { gateDecisionId: approval.binding.gate_decision_id, target: chain.target, nearPolicyVersion: npv });
    if (!now) return ["request"];
    if (testnetActionHash(now) === a.action_hash) return null;
    return bindingDiff(approval.binding, now);
  });
  if (stale) {
    await runTransact(ctx.businessId, tx => abort(tx, ctx, ["signing"], "APPROVAL_STALE", `Changed since your approval: ${stale.join(", ")}. Nothing was signed.`));
    return "stop";
  }

  // 3 · take the signer: ONE signer at a time across every server instance (src/lib/runs/signer-lease.ts).
  //     Busy → back to `prepared`, untouched (the next advance tries again). Paused by the operator →
  //     abort: nothing is signed or sent. The coordination store unreachable → nothing is signed.
  let slot: SignerSlot;
  try { slot = await takeSigner(chain.target.agent); }
  catch { return preSignFailure(ctx, "COORDINATION_UNAVAILABLE", "The shared coordination store couldn't be reached before signing; nothing was signed."); }
  if (!slot.ok) {
    if (slot.reason === "paused") {
      await runTransact(ctx.businessId, tx => abort(tx, ctx, ["signing"], "TESTNET_PAUSED", "Real testnet payments are paused on this demo right now. Nothing was signed or sent."));
      return "stop";
    }
    await runTransact(ctx.businessId, tx => {
      if (tx.patchAttempt(businessId, attemptId, ["signing"], { status: "prepared" }, owner)) note(tx, ctx, "wait", "another payment is being signed right now; this one waits its turn (nothing was signed)");
    });
    return "stop";
  }
  const lease = slot.lease;
  try {
    // 4 · sign (the signer re-checks readiness, recipient, limits, duplicates and, LAST, the key), with a
    //     nonce above every nonce any instance has persisted
    let floor: string | null;
    try { floor = await nonceFloor(chain.target.agent); }
    catch { return preSignFailure(ctx, "COORDINATION_UNAVAILABLE", "The shared coordination store couldn't be reached before signing; nothing was signed."); }
    const res = await chain.sign({ requestId: a.request_id, recipient: a.recipient, amountYocto: a.amount_yocto, mode: a.sign_mode ?? "new", previousExpiresAfterHeight: a.previous_expires_after_height ?? null, minNonceExclusive: floor });
    if (!res.ok) {
      if (res.transient) return preSignFailure(ctx, res.code, "The NEAR testnet couldn't be reached while preparing the signature; nothing was signed.");
      await runTransact(ctx.businessId, tx => abort(tx, ctx, ["signing"], res.code, `The signer refused: ${res.detail}. Nothing was signed.`));
      return "stop";
    }

    // 5 · write-ahead BEFORE any broadcast, fenced by the signer lease and raising the shared nonce floor
    //     in the same atomic step. If it fails (the attempt was aborted meanwhile, the lease was lost, or
    //     the store write failed), the bytes are discarded here and are never sent.
    const s: SignedPaymentData = res.signed;
    const stored = await runTransact(ctx.businessId, tx => {
      const ok = tx.patchAttempt(businessId, attemptId, ["signing"], {
        status: "signed", nonce: s.nonce, signer_public_key: s.publicKey, tx_hash: s.txHash, signed_tx_b64: s.signedTxBase64,
        signed_block_hash: s.blockHash, signed_block_height: s.signedBlockHeight, validity_period_blocks: s.validityPeriodBlocks, expires_after_height: s.expiresAfterHeight,
      }, owner);
      if (ok) event(tx, ctx, "payment.signed", "signed", { tx_hash: s.txHash, nonce: s.nonce, expires_after_height: s.expiresAfterHeight });
      return ok;
    }, { fences: [lease.fence], side: [{ op: "max", key: signerNonceKey(chain.target.agent), value: s.nonce }] }).catch(() => false);
    if (!stored) return "stop";

    // 6 · broadcast under the same lease
    const signedNow = await runRead(ctx.businessId, tx => tx.attempt(businessId, attemptId));
    if (!signedNow || signedNow.status !== "signed") return "stop";
    return await fromSigned(ctx, signedNow, lease);
  } finally {
    await lease.release();
  }
}

/** A failure before anything was signed: back to `prepared` (bounded), then "Payment not sent". */
async function preSignFailure(ctx: Ctx, code: string, message: string): Promise<Next> {
  await runTransact(ctx.businessId, tx => {
    const a = tx.attempt(ctx.businessId, ctx.attemptId);
    if (!a || a.status !== "signing") return;
    const n = a.pre_sign_errors + 1;
    if (n >= MAX_PRE_SIGN_ERRORS) { abort(tx, ctx, ["signing"], code, `${message} Payment not sent after ${n} tries.`); return; }
    tx.patchAttempt(ctx.businessId, ctx.attemptId, ["signing"], { status: "prepared", pre_sign_errors: n, error: { code, message } }, ctx.owner);
    event(tx, ctx, "payment.not_sent_yet", "prepared", { code, tries: n });
  });
  return "stop";
}

/**
 * Broadcast persisted bytes, under the signer lease (the one held since signing, or a fresh one). The
 * switch to `submitting` is fenced by it, so a stalled instance can't start a broadcast.
 */
async function fromSigned(ctx: Ctx, a: PaymentAttempt, held?: Lease): Promise<Next> {
  let lease = held ?? null;
  if (!lease) {
    let slot: SignerSlot;
    try { slot = await takeSigner(ctx.chain.target.agent); }
    catch { await runTransact(ctx.businessId, tx => note(tx, ctx, "wait", "the coordination store couldn't be reached; not broadcasting now")).catch(() => undefined); return "stop"; }
    if (!slot.ok) {
      if (slot.reason === "paused") {
        await runTransact(ctx.businessId, tx => abort(tx, ctx, ["signed"], "TESTNET_PAUSED", "Real testnet payments are paused on this demo right now. The signed transaction was discarded and never sent."));
      }
      return "stop";   // busy: still `signed`; the next advance broadcasts it
    }
    lease = slot.lease;
  }
  const fence = lease.fence;
  try {
    const go = await runTransact(ctx.businessId, tx => {
      // Kill switch or stop between signing and broadcast: the bytes are discarded, never sent (§14).
      const blocked = blockedReason(tx, a);
      if (blocked) { abort(tx, ctx, ["signed"], blocked.code, blocked.message); return false; }
      return tx.patchAttempt(ctx.businessId, ctx.attemptId, ["signed"], { status: "submitting", broadcasts: a.broadcasts + 1 }, ctx.owner);
    }, { fences: [fence] }).catch(() => false);
    if (!go || !a.signed_tx_b64) return "stop";
    const verdict = await ctx.chain.broadcast({ signedTxBase64: a.signed_tx_b64, requestId: a.request_id, recipient: a.recipient, amountYocto: a.amount_yocto }).catch(() => ({ outcome: "unknown", reason: "broadcast error" }) as ChainVerdict);
    await settle(ctx, a, ["submitting"], verdict);
    return "stop";
  } finally {
    if (!held) await lease.release();
  }
}

async function fromUnknown(ctx: Ctx, a: PaymentAttempt): Promise<Next> {
  const rc = await ctx.chain.reconcile({
    requestId: a.request_id, recipient: a.recipient, amountYocto: a.amount_yocto, txHash: a.tx_hash,
    signedBlockHeight: a.signed_block_height, validityPeriodBlocks: a.validity_period_blocks, signedBytesAvailable: !!a.signed_tx_b64,
  }).catch(() => ({ action: "wait", reason: "reconciliation failed (RPC error)" }) as const);
  if (rc.action === "settled") { await settle(ctx, a, ["unknown"], rc.verdict); return "stop"; }
  if (rc.action === "expired_unexecuted") {
    await runTransact(ctx.businessId, tx => {
      if (tx.patchAttempt(ctx.businessId, ctx.attemptId, ["unknown"], { status: "expired_unexecuted", signed_tx_b64: null, error: { code: "PAYMENT_NOT_SENT", message: rc.detail } }, ctx.owner)) {
        event(tx, ctx, "payment.expired_unexecuted", "expired_unexecuted", { detail: rc.detail });
      }
    });
    return "stop";
  }
  if (rc.action === "rebroadcast" && a.signed_tx_b64) {
    // Identical bytes only (same hash and nonce): the chain executes a transaction at most once.
    // Not after a kill switch, a stop or an operator pause: then we only reconcile until the window
    // closes (an unknown outcome is never aborted). Under the signer lease, like every broadcast.
    let slot: SignerSlot;
    try { slot = await takeSigner(ctx.chain.target.agent); }
    catch { await runTransact(ctx.businessId, tx => note(tx, ctx, "wait", "the coordination store couldn't be reached; not re-broadcasting now")).catch(() => undefined); return "stop"; }
    if (!slot.ok) {
      const why = slot.reason === "paused" ? "validity window open; not re-broadcasting while testnet payments are paused" : "validity window open; another payment is being sent, re-broadcast later";
      await runTransact(ctx.businessId, tx => note(tx, ctx, "wait", why));
      return "stop";
    }
    const lease = slot.lease;
    try {
      const go = await runTransact(ctx.businessId, tx => {
        if (blockedReason(tx, a)) { note(tx, ctx, "wait", "validity window open; not re-broadcasting after a kill switch or stop"); return false; }
        return tx.patchAttempt(ctx.businessId, ctx.attemptId, ["unknown"], { status: "submitting", broadcasts: a.broadcasts + 1 }, ctx.owner);
      }, { fences: [lease.fence] }).catch(() => false);
      if (!go) return "stop";
      const verdict = await ctx.chain.broadcast({ signedTxBase64: a.signed_tx_b64, requestId: a.request_id, recipient: a.recipient, amountYocto: a.amount_yocto }).catch(() => ({ outcome: "unknown", reason: "re-broadcast error" }) as ChainVerdict);
      await settle(ctx, a, ["submitting"], verdict);
      return "stop";
    } finally {
      await lease.release();
    }
  }
  const reason = "reason" in rc ? rc.reason : "waiting";
  await runTransact(ctx.businessId, tx => note(tx, ctx, rc.action, reason));
  return "stop";
}

/** Record a verified outcome (attempt + ledger row + event in ONE write), or mark the outcome unknown. */
async function settle(ctx: Ctx, a: PaymentAttempt, from: readonly AttemptStatus[], v: ChainVerdict): Promise<void> {
  await runTransact(ctx.businessId, tx => {
    if (v.outcome === "unknown" || (v.txHash && a.tx_hash && v.txHash !== a.tx_hash)) {
      const reason = v.outcome === "unknown" ? v.reason : `the RPC reported hash ${v.txHash}, not the signed ${a.tx_hash}`;
      if (tx.patchAttempt(ctx.businessId, ctx.attemptId, from, { status: "unknown", error: { code: "OUTCOME_UNKNOWN", message: reason } }, ctx.owner)) {
        event(tx, ctx, "payment.unknown", "unknown", { reason });
      }
      return;
    }
    const batchRef = tx.batches(ctx.businessId).find(b => b.id === a.batch_id)?.batch_ref ?? a.batch_id;
    if (v.outcome === "confirmed") {
      if (!tx.patchAttempt(ctx.businessId, ctx.attemptId, from, { status: "confirmed", tx_hash: v.txHash, gas_burnt: v.gasBurnt, outcome: v.evidence, verified_at: tx.now, signed_tx_b64: null, error: null }, ctx.owner)) return;
      tx.appendLedger({
        business_id: ctx.businessId, run_id: a.run_id, type: "supplier_payout", mode: "testnet", amount: a.amount_yocto, unit: "yoctoNEAR",
        amount_ngn_business: a.amount_ngn, counterparty: a.recipient, supplier_name: a.supplier_name, agent_key: "finance",
        tx_hash: v.txHash, tx_status: "confirmed", request_id: a.request_id, attempt_id: a.id, batch_id: batchRef,
        explorer_url: `${EXPLORER_TX_URL}${v.txHash}`, label: "NEAR testnet · real transaction",
      });
      event(tx, ctx, "payment.confirmed", "confirmed", { tx_hash: v.txHash, amount_yocto: a.amount_yocto, recipient: a.recipient });
      return;
    }
    const message = v.kind === "contract_rejected" ? `The treasury contract rejected the request: ${v.detail}` : `The payout failed and the funds stayed in the treasury: ${v.detail}`;
    if (!tx.patchAttempt(ctx.businessId, ctx.attemptId, from, { status: "failed_onchain", tx_hash: v.txHash ?? a.tx_hash, outcome: v.evidence, verified_at: tx.now, signed_tx_b64: null, error: { code: v.kind === "contract_rejected" ? "CONTRACT_REJECTED" : "PAYOUT_FAILED", message } }, ctx.owner)) return;
    tx.appendLedger({
      business_id: ctx.businessId, run_id: a.run_id, type: "supplier_payout", mode: "testnet", amount: a.amount_yocto, unit: "yoctoNEAR",
      amount_ngn_business: a.amount_ngn, counterparty: a.recipient, supplier_name: a.supplier_name, agent_key: "finance",
      tx_hash: v.txHash ?? a.tx_hash, tx_status: "failed", request_id: a.request_id, attempt_id: a.id, batch_id: batchRef,
      explorer_url: v.txHash ?? a.tx_hash ? `${EXPLORER_TX_URL}${v.txHash ?? a.tx_hash}` : null, label: "Failed on-chain",
    });
    event(tx, ctx, "payment.failed", "failed_onchain", { kind: v.kind, tx_hash: v.txHash });
  });
}

/** Abort the run's attempts that have not been broadcast (kill switch / stop / run ended). Inside a write. */
export function abortUnsentAttempts(tx: RunTx, businessId: string, runId: string, code: string): void {
  for (const a of tx.attempts(businessId).filter(x => x.run_id === runId && (x.status === "prepared" || x.status === "signing" || x.status === "signed"))) {
    if (tx.patchAttempt(businessId, a.id, [a.status], { status: "aborted", signed_tx_b64: null, error: { code, message: "Stopped before the payment was sent; nothing was broadcast." } })) {
      tx.appendEvent(businessId, "system", "payment.aborted", `attempt:${a.id}`, "aborted", runId, { code, from: a.status });
    }
  }
}
