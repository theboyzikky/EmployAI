import "server-only";
// M5 · Treasury readiness (plan §6.4) and per-payment recipient verification (plan §9). Read-only:
// every check uses the ChainReader port. A testnet run or payment may proceed only when `ready`.
import { AGENT_GAS_RESERVE_YOCTO, EXPECTED_TREASURY_CODE_HASH, NEAR_DAILY_CAP_YOCTO, NEAR_MAX_PER_TX_YOCTO, STORAGE_BYTE_COST_YOCTO, STORAGE_RESERVE_BYTES, type ChainConfig } from "./config";
import { verifyRestrictedKey } from "./key-check";
import type { ChainReader } from "./port";

export type ReadinessCode =
  | "TREASURY_NOT_FOUND" | "TREASURY_CODE_MISMATCH" | "TREASURY_POLICY_MISMATCH" | "TREASURY_PAUSED"
  | "SALES_UNEXPECTEDLY_ENABLED" | "SIGNER_KEY_UNSAFE" | "INSUFFICIENT_GAS" | "TREASURY_UNDERFUNDED" | "CHAIN_UNAVAILABLE";

export type Readiness = { ready: boolean; failures: Array<{ code: ReadinessCode; detail: string }>; treasuryAvailableYocto: string | null };

/** Balance that can leave the treasury: amount − locked − (storage + reserve) × byte cost (as the contract computes it). */
export function availableYocto(acct: { amount: string; locked: string; storage_usage: number }): bigint {
  const storage = STORAGE_BYTE_COST_YOCTO * (BigInt(acct.storage_usage) + STORAGE_RESERVE_BYTES);
  const v = BigInt(acct.amount) - BigInt(acct.locked) - storage;
  return v > BigInt("0") ? v : BigInt("0");
}

export async function checkReadiness(chain: ChainReader, cfg: ChainConfig, agentPublicKey: string, paymentYocto: bigint = BigInt("0")): Promise<Readiness> {
  const failures: Readiness["failures"] = [];
  let available: bigint | null = null;
  try {
    const treasury = await chain.viewAccount(cfg.treasury);
    if (!treasury) {
      failures.push({ code: "TREASURY_NOT_FOUND", detail: cfg.treasury });
    } else {
      if (treasury.code_hash !== EXPECTED_TREASURY_CODE_HASH) failures.push({ code: "TREASURY_CODE_MISMATCH", detail: treasury.code_hash });
      available = availableYocto(treasury);
      if (available < paymentYocto) failures.push({ code: "TREASURY_UNDERFUNDED", detail: `available ${available} < payment ${paymentYocto}` });
      const p = await chain.getPolicy(cfg.treasury);
      if (p.owner !== cfg.owner || p.agent !== cfg.agent || p.max_per_tx !== NEAR_MAX_PER_TX_YOCTO.toString() || p.daily_cap !== NEAR_DAILY_CAP_YOCTO.toString()) {
        failures.push({ code: "TREASURY_POLICY_MISMATCH", detail: JSON.stringify(p) });
      }
      if (p.paused) failures.push({ code: "TREASURY_PAUSED", detail: "treasury is paused on-chain" });
      if (p.sales_enabled || (await chain.getSalesEnabled(cfg.treasury))) failures.push({ code: "SALES_UNEXPECTEDLY_ENABLED", detail: "customer sales must stay disabled in M5 (R9)" });
    }
    const key = verifyRestrictedKey(await chain.viewAccessKey(cfg.agent, agentPublicKey), { treasury: cfg.treasury });
    if (!key.ok) failures.push({ code: key.code, detail: key.reason });
    const agent = await chain.viewAccount(cfg.agent);
    if (!agent || BigInt(agent.amount) < AGENT_GAS_RESERVE_YOCTO) failures.push({ code: "INSUFFICIENT_GAS", detail: agent ? agent.amount : "agent account not found" });
  } catch {
    failures.push({ code: "CHAIN_UNAVAILABLE", detail: "an RPC read failed; readiness unverified" });
  }
  return { ready: failures.length === 0, failures, treasuryAvailableYocto: available === null ? null : available.toString() };
}

export type RecipientCheck = { ok: true } | { ok: false; code: "RECIPIENT_NOT_FOUND" | "RECIPIENT_NOT_APPROVED_ONCHAIN" | "RECIPIENT_IS_CONTRACT" | "CHAIN_UNAVAILABLE"; detail: string };

/** Plan §9: the recipient must exist, be a plain account (no contract code), and be on the on-chain allowlist. */
export async function checkRecipient(chain: ChainReader, cfg: ChainConfig, recipient: string): Promise<RecipientCheck> {
  try {
    const acct = await chain.viewAccount(recipient);
    if (!acct) return { ok: false, code: "RECIPIENT_NOT_FOUND", detail: recipient };
    if (acct.code_hash !== "11111111111111111111111111111111") return { ok: false, code: "RECIPIENT_IS_CONTRACT", detail: acct.code_hash };
    if (!(await chain.isApproved(cfg.treasury, recipient))) return { ok: false, code: "RECIPIENT_NOT_APPROVED_ONCHAIN", detail: recipient };
    return { ok: true };
  } catch {
    return { ok: false, code: "CHAIN_UNAVAILABLE", detail: "recipient checks could not be completed" };
  }
}
