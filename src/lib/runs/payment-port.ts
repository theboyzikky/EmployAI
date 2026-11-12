import "server-only";
// M5 · PaymentChain: the ONLY way the runner reaches NEAR (plan §4.1 principle 3). This module defines
// the interface and a registry; it contains no network code. The live implementation is in
// src/lib/chain/live.ts and is registered by the API routes that drive testnet runs; tests register a
// fake. When nothing is registered, testnet mode is unavailable and refused (fail closed).

export type ChainTarget = { network: "testnet"; contractId: string; expectedCodeHash: string; agent: string };

/** Read-only checks before the gate decides (readiness §6.4 + recipient §9 + the day's on-chain total). */
export type ChainPrecheck = {
  /** Hard refusals in check order (codes such as TREASURY_PAUSED, RECIPIENT_NOT_APPROVED_ONCHAIN). */
  failures: Array<{ code: string; detail: string }>;
  onchainSpentTodayYocto: string | null;
  /** Hash of the on-chain policy snapshot + the configured NEAR limits; null if it couldn't be read. */
  nearPolicyVersion: string | null;
  onchainLimits: { maxPerTxYocto: string; dailyCapYocto: string } | null;
  checkedAt: string;
};

/** The write-ahead data of one signed request_payment transaction (no secret). */
export type SignedPaymentData = {
  txHash: string;
  signedTxBase64: string;
  nonce: string;
  publicKey: string;
  blockHash: string;
  signedBlockHeight: number;
  validityPeriodBlocks: number;
  expiresAfterHeight: number;
};

export type SignOutcome =
  | { ok: true; signed: SignedPaymentData }
  /** `transient`: a chain read failed before anything was signed (safe to try again later). */
  | { ok: false; code: string; detail: string; transient: boolean };

/** A verified chain outcome. "confirmed" only when every §12 check passed. */
export type ChainVerdict =
  | { outcome: "confirmed"; txHash: string; gasBurnt: number; evidence: unknown }
  | { outcome: "failed_onchain"; kind: "contract_rejected" | "transfer_failed"; detail: string; txHash: string | null; evidence: unknown }
  | { outcome: "unknown"; reason: string };

export type ReconcileOutcome =
  | { action: "settled"; verdict: Exclude<ChainVerdict, { outcome: "unknown" }> }
  /** Validity window still open and no final record: re-broadcast the IDENTICAL bytes (never re-sign). */
  | { action: "rebroadcast" }
  /** The window closed by block height and the contract has no record: the bytes can never execute. */
  | { action: "expired_unexecuted"; detail: string }
  | { action: "wait"; reason: string }
  | { action: "investigate"; reason: string };

export type AttemptFacts = {
  requestId: string; recipient: string; amountYocto: string; txHash: string | null;
  signedBlockHeight: number | null; validityPeriodBlocks: number | null; signedBytesAvailable: boolean;
};

export interface PaymentChain {
  readonly target: ChainTarget;
  precheck(input: { recipient: string; amountYocto: string }): Promise<ChainPrecheck>;
  /** Fresh on-chain policy version (for the binding re-check immediately before signing). */
  nearPolicyVersion(): Promise<string>;
  /**
   * Fail-closed signer: fresh key check last, then ONE signature. Never broadcasts. A retry passes its
   * mode; the signer re-checks the contract-side condition for it (Failed record, or expired window).
   * `minNonceExclusive`: the highest nonce any server instance has persisted; the new nonce is above it.
   */
  sign(input: { requestId: string; recipient: string; amountYocto: string; mode?: "new" | "retry_after_failed" | "resubmit_after_expiry"; previousExpiresAfterHeight?: number | null; minNonceExclusive?: string | null }): Promise<SignOutcome>;
  /** Send the given bytes ONCE (never retried here) and verify the outcome (plan §12). */
  broadcast(input: { signedTxBase64: string; requestId: string; recipient: string; amountYocto: string }): Promise<ChainVerdict>;
  /** Decide from the contract's request record (primary) and the tx outcome (secondary), §11.1. */
  reconcile(facts: AttemptFacts): Promise<ReconcileOutcome>;
}

export type ChainAvailability = { ok: true; chain: PaymentChain } | { ok: false; code: string; message: string };

type Registry = { factory: (() => Promise<ChainAvailability>) | null; override: PaymentChain | null };
const KEY = Symbol.for("employai.paymentChain");
const g = globalThis as unknown as { [KEY]?: Registry };
const registry: Registry = (g[KEY] ??= { factory: null, override: null });

/** Called by src/lib/chain/live.ts when the API routes load it. */
export function registerPaymentChainFactory(factory: () => Promise<ChainAvailability>) { registry.factory = factory; }
/** Tests only: use a fake chain (null clears it). */
export function setPaymentChainForTests(chain: PaymentChain | null) { registry.override = chain; }

export async function getPaymentChain(): Promise<ChainAvailability> {
  if (registry.override) return { ok: true, chain: registry.override };
  if (!registry.factory) return { ok: false, code: "TESTNET_UNAVAILABLE", message: "NEAR testnet payments aren't available on this server." };
  try {
    return await registry.factory();
  } catch {
    return { ok: false, code: "TESTNET_UNAVAILABLE", message: "NEAR testnet payments couldn't be set up on this server." };
  }
}
