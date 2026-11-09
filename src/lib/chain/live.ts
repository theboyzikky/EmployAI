import "server-only";
// M5 · The live PaymentChain (plan §4.2): the runner's injected port, built from the reviewed chain
// modules. Importing this module registers it; the API routes that drive testnet runs import it.
// Fail closed at construction: wrong network or accounts, a missing or non-approved key, or another
// server process holding the signer → testnet stays unavailable and nothing can be signed.
import { createHash } from "node:crypto";
import { registerPaymentChainFactory, type ChainAvailability, type ChainPrecheck, type ChainVerdict, type PaymentChain, type ReconcileOutcome } from "@/lib/runs/payment-port";
import { APPROVED_ACCOUNTS, EXPECTED_TREASURY_CODE_HASH, NEAR_DAILY_CAP_YOCTO, NEAR_MAX_PER_TX_YOCTO, readChainConfig, type ChainConfig } from "./config";
import { acquireSignerLock } from "./instance-lock";
import { AgentKeyError, loadAgentKey, type AgentKeyHandle } from "./keys";
import { chainReaderFromRpc, type ChainReader } from "./port";
import { checkReadiness, checkRecipient } from "./readiness";
import { decideRecovery, type RecordState } from "./recovery";
import { createRpcClient, type RpcClient } from "./rpc";
import { SignerRefusal, broadcastSigned, signPaymentRequest, type PaymentToSign } from "./signer";
import type { TreasuryPolicy, TxStatusResult } from "./types";
import { verifyPayout, type PayoutVerdict } from "./verify-outcome";

/** Hash of the on-chain policy snapshot and the configured NEAR limits (plan §8.3 near_policy_version). */
export function nearPolicyVersionOf(p: TreasuryPolicy): string {
  const snapshot = {
    owner: p.owner, agent: p.agent, max_per_tx: p.max_per_tx, daily_cap: p.daily_cap, paused: p.paused, sales_enabled: p.sales_enabled,
    config_max_per_tx: NEAR_MAX_PER_TX_YOCTO.toString(), config_daily_cap: NEAR_DAILY_CAP_YOCTO.toString(),
  };
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

/** Keep the parts of a final outcome that prove the payout (status, receipts, logs, gas). */
const evidenceOf = (tx: TxStatusResult) => ({
  final_execution_status: tx.final_execution_status, status: tx.status, transaction: { hash: tx.transaction.hash, signer_id: tx.transaction.signer_id, receiver_id: tx.transaction.receiver_id, nonce: tx.transaction.nonce },
  transaction_outcome: tx.transaction_outcome, receipts_outcome: tx.receipts_outcome,
});

function toVerdict(v: PayoutVerdict, tx: TxStatusResult | null): ChainVerdict {
  if (v.outcome === "confirmed") return { outcome: "confirmed", txHash: v.txHash, gasBurnt: v.gasBurnt, evidence: tx ? evidenceOf(tx) : null };
  if (v.outcome === "failed_onchain") {
    return v.kind === "contract_rejected"
      ? { outcome: "failed_onchain", kind: "contract_rejected", detail: v.panic, txHash: v.txHash, evidence: tx ? evidenceOf(tx) : null }
      : { outcome: "failed_onchain", kind: "transfer_failed", detail: `the transfer failed and was refunded${v.rolledBack === false ? " (daily total not rolled back)" : ""}`, txHash: v.txHash, evidence: tx ? evidenceOf(tx) : null };
  }
  return { outcome: "unknown", reason: v.reason };
}

export function createPaymentChain(deps: { chain: ChainReader; rpc: Pick<RpcClient, "sendTx">; config: ChainConfig; agentKey: AgentKeyHandle }): PaymentChain {
  const { chain, rpc, config, agentKey } = deps;
  const expect = (requestId: string, recipient: string, amountYocto: string) => ({ requestId, recipient, amountYocto, agent: config.agent, treasury: config.treasury });
  return {
    target: { network: "testnet", contractId: config.treasury, expectedCodeHash: EXPECTED_TREASURY_CODE_HASH, agent: config.agent },

    async precheck({ recipient, amountYocto }): Promise<ChainPrecheck> {
      const failures: ChainPrecheck["failures"] = [];
      let spent: string | null = null, npv: string | null = null, limits: ChainPrecheck["onchainLimits"] = null;
      if (agentKey.publicKey !== APPROVED_ACCOUNTS.agentPublicKey) failures.push({ code: "SIGNER_KEY_UNSAFE", detail: "the loaded key is not the approved restricted key" });
      try {
        const ready = await checkReadiness(chain, config, agentKey.publicKey, BigInt(amountYocto));
        failures.push(...ready.failures);
        const r = await checkRecipient(chain, config, recipient);
        if (!r.ok) failures.push({ code: r.code, detail: r.detail });
        const p = await chain.getPolicy(config.treasury);
        npv = nearPolicyVersionOf(p);
        limits = { maxPerTxYocto: p.max_per_tx, dailyCapYocto: p.daily_cap };
        spent = (await chain.getSpentToday(config.treasury)).spent;
      } catch {
        failures.push({ code: "CHAIN_UNAVAILABLE", detail: "the chain checks could not be completed" });
      }
      return { failures, onchainSpentTodayYocto: spent, nearPolicyVersion: npv, onchainLimits: limits, checkedAt: new Date().toISOString() };
    },

    async nearPolicyVersion() {
      return nearPolicyVersionOf(await chain.getPolicy(config.treasury));
    },

    async sign({ requestId, recipient, amountYocto, mode = "new", previousExpiresAfterHeight }) {
      try {
        const base = { requestId, recipient, amountYocto };
        if (mode === "resubmit_after_expiry" && typeof previousExpiresAfterHeight !== "number") {
          return { ok: false, code: "RESUBMIT_NOT_ALLOWED", detail: "the earlier transaction's validity window is unknown", transient: false };
        }
        const pay: PaymentToSign = mode === "retry_after_failed" ? { ...base, mode }
          : mode === "resubmit_after_expiry" ? { ...base, mode, previous: { args: { request_id: requestId, recipient, amount: amountYocto }, expiresAfterHeight: previousExpiresAfterHeight as number } }
          : { ...base, mode: "new" };
        const s = await signPaymentRequest({ chain, config, agentKey }, pay);
        return { ok: true, signed: { txHash: s.txHash, signedTxBase64: s.signedTxBase64, nonce: s.nonce, publicKey: s.publicKey, blockHash: s.blockHash, signedBlockHeight: s.signedBlockHeight, validityPeriodBlocks: s.validityPeriodBlocks, expiresAfterHeight: s.expiresAfterHeight } };
      } catch (e) {
        if (e instanceof SignerRefusal) return { ok: false, code: e.code, detail: e.detail, transient: e.code === "CHAIN_UNAVAILABLE" };
        return { ok: false, code: "SIGNING_FAILED", detail: "unexpected signer error", transient: false };
      }
    },

    async broadcast({ signedTxBase64, requestId, recipient, amountYocto }): Promise<ChainVerdict> {
      const sent = await broadcastSigned(rpc, { signedTxBase64 });
      if (sent.status === "unknown") return { outcome: "unknown", reason: sent.reason };
      let record;
      try { record = await chain.getRequest(config.treasury, requestId); }
      catch { return { outcome: "unknown", reason: "final outcome received, but the request record couldn't be read to verify it" }; }
      return toVerdict(verifyPayout(sent.result, expect(requestId, recipient, amountYocto), record), sent.result);
    },

    async reconcile(f): Promise<ReconcileOutcome> {
      let record: RecordState;
      try { record = await chain.getRequest(config.treasury, f.requestId); } catch { record = "unavailable"; }
      let height: number | null;
      try { height = await chain.finalBlockHeight(); } catch { height = null; }
      const d = decideRecovery({ requestId: f.requestId, recipient: f.recipient, amountYocto: f.amountYocto, signedBlockHeight: f.signedBlockHeight, validityPeriodBlocks: f.validityPeriodBlocks, signedBytesAvailable: f.signedBytesAvailable }, record, height);
      switch (d.action) {
        case "settle_confirmed": {
          // Paid on-chain. "Confirmed" still needs the full transaction evidence (§12).
          if (!f.txHash) return { action: "investigate", reason: "request Paid on-chain but no transaction hash is stored" };
          let tx: TxStatusResult | "unknown_transaction";
          try { tx = await chain.txStatus(f.txHash, config.agent); } catch { return { action: "wait", reason: "request Paid on-chain; transaction evidence not readable yet" }; }
          if (tx === "unknown_transaction") return { action: "wait", reason: "request Paid on-chain; waiting for the transaction's evidence" };
          const v = toVerdict(verifyPayout(tx, expect(f.requestId, f.recipient, f.amountYocto), record as Exclude<RecordState, "unavailable">), tx);
          if (v.outcome === "confirmed") return { action: "settled", verdict: v };
          return { action: "investigate", reason: v.outcome === "unknown" ? `request Paid but verification incomplete: ${v.reason}` : "request Paid but the transaction shows a failure" };
        }
        case "settle_failed": {
          let tx: TxStatusResult | null = null;
          if (f.txHash) { try { const t = await chain.txStatus(f.txHash, config.agent); tx = t === "unknown_transaction" ? null : t; } catch { tx = null; } }
          return { action: "settled", verdict: { outcome: "failed_onchain", kind: "transfer_failed", detail: "the request record is Failed: the transfer failed and was refunded", txHash: tx?.transaction.hash ?? f.txHash, evidence: { record, tx: tx ? evidenceOf(tx) : null } } };
        }
        case "rebroadcast_same_bytes": return { action: "rebroadcast" };
        case "eligible_for_resubmission":
          return { action: "expired_unexecuted", detail: `Block ${height} is past the transaction's validity window (it ended at block ${(f.signedBlockHeight ?? 0) + (f.validityPeriodBlocks ?? 0)}) and the contract has no record of the request, so it can never execute. Nothing was paid.` };
        case "wait": return { action: "wait", reason: d.reason };
        default: return { action: "investigate", reason: d.reason };
      }
    },
  };
}

// ---- registration (lazy: nothing is read until a testnet operation needs the chain) ---------------
// One live chain per process (on globalThis): every route bundle that imports this module shares it.
const LIVE = Symbol.for("employai.liveChain");
const gl = globalThis as unknown as { [LIVE]?: { ready: Promise<ChainAvailability> | null } };
const live = (gl[LIVE] ??= { ready: null });

async function build(): Promise<ChainAvailability> {
  const cfg = readChainConfig();
  if (!cfg.ok) return { ok: false, code: "TESTNET_NOT_CONFIGURED", message: `NEAR testnet isn't configured on this server${cfg.missing.length ? ` (missing: ${cfg.missing.join(", ")})` : ""}${cfg.invalid.length ? ` (invalid: ${cfg.invalid.join(", ")})` : ""}.` };
  const c = cfg.config;
  if (c.owner !== APPROVED_ACCOUNTS.owner || c.treasury !== APPROVED_ACCOUNTS.treasury || c.agent !== APPROVED_ACCOUNTS.agent) {
    return { ok: false, code: "ACCOUNT_CONFIG_MISMATCH", message: "The configured NEAR accounts aren't the approved testnet accounts." };
  }
  let key: AgentKeyHandle;
  try { key = await loadAgentKey(); }
  catch (e) { return { ok: false, code: e instanceof AgentKeyError ? e.code : "AGENT_KEY_INVALID", message: "The Finance Agent's restricted signing key isn't set up on this server." }; }
  if (key.publicKey !== APPROVED_ACCOUNTS.agentPublicKey) return { ok: false, code: "KEY_MISMATCH", message: "The configured signing key isn't the approved restricted Finance Agent key." };
  const lock = acquireSignerLock();
  if (!lock.ok) return { ok: false, code: lock.code, message: lock.message };
  const rpc = createRpcClient({ url: c.rpcUrl });
  return { ok: true, chain: createPaymentChain({ chain: chainReaderFromRpc(rpc), rpc, config: c, agentKey: key }) };
}

registerPaymentChainFactory(async () => {
  const p = (live.ready ??= build());
  const r = await p;
  if (!r.ok && live.ready === p) live.ready = null;      // never cache a failure: the owner may fix the configuration
  return r;
});

/** Imported by the API routes for its registration side effect. */
export const LIVE_CHAIN_REGISTERED = true;
