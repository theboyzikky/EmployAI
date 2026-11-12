import "server-only";
// M5 hosted · ONE signer at a time for the Finance Agent's key, across every server instance.
//
// The lease is held from the nonce read, through signing and the write-ahead, to the broadcast. The
// write-ahead commit and the switch to "submitting" are fenced by it (at least SIGNER_FENCE_MIN_TTL_MS
// left), and the write-ahead raises the shared nonce floor in the same atomic step. So:
//  - two instances never sign with the same key at the same time (no nonce collisions);
//  - an instance that stalled past its lease can't persist a signature, and bytes that were never
//    persisted are never broadcast;
//  - the next signer uses a nonce above every persisted one, even if the chain hasn't seen it yet.
// Duplicate payouts stay impossible regardless: one active attempt per request id, compare-and-set on
// every attempt transition, and the contract refuses a second payout for the same request id.
import { getKv } from "@/lib/kv";
import { opsFlag } from "@/lib/hosted/ops-flags";
import { acquireLease, type Lease } from "@/lib/store/lease";

export const SIGNER_LEASE_TTL_MS = 45_000;
export const SIGNER_FENCE_MIN_TTL_MS = 10_000;
export const SIGNER_WAIT_MS = 15_000;

export const signerLockKey = (agent: string) => `lock:signer:${agent}`;
export const signerNonceKey = (agent: string) => `signer:nonce:${agent}`;

export type SignerSlot = { ok: true; lease: Lease } | { ok: false; reason: "paused" | "busy" };

/** Take the signer (waits up to SIGNER_WAIT_MS). Throws KvUnavailableError if the store is down. */
export async function takeSigner(agent: string, o: { waitMs?: number } = {}): Promise<SignerSlot> {
  if (await opsFlag("testnet_paused")) return { ok: false, reason: "paused" };
  const lease = await acquireLease(getKv(), signerLockKey(agent), {
    ttlMs: SIGNER_LEASE_TTL_MS, fenceMinTtlMs: SIGNER_FENCE_MIN_TTL_MS, waitMs: o.waitMs ?? SIGNER_WAIT_MS,
  });
  return lease ? { ok: true, lease } : { ok: false, reason: "busy" };
}

/** The highest nonce any instance has persisted for this key (null if none yet). */
export async function nonceFloor(agent: string): Promise<string | null> {
  return getKv().get(signerNonceKey(agent));
}
