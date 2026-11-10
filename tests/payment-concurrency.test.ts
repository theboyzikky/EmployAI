// Payments on the hosted demo: separate server instances sharing one store (RedisStore over a MemoryKv
// whose every operation yields at random, so instances interleave). The chain is a SIMULATED NEAR:
// a transaction executes at most once, a nonce at or below the key's current nonce is rejected, and the
// contract pays a request id at most once. It also measures how many signatures/broadcasts overlap.
// Proves: no duplicate payout, no nonce collision, one signer at a time, a stalled signer never
// broadcasts, store failures and the operator pause sign nothing — with every existing gate in place.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { setDiscoveryRepository } from "@/lib/discovery/store";
import { MemoryKv, setKvForTests } from "@/lib/kv";
import { KvUnavailableError } from "@/lib/kv/types";
import { setPaymentChainForTests, type ChainVerdict, type PaymentChain } from "@/lib/runs/payment-port";
import { runRead } from "@/lib/runs/repo";
import { advanceRun, armTestnetBatch, decideApproval, startRun } from "@/lib/runs/runner";
import { signerLockKey, signerNonceKey } from "@/lib/runs/signer-lease";
import { RedisStore } from "@/lib/store/redis-store";
import { readyRestaurant } from "./helpers/run-fixture";

vi.setConfig({ testTimeout: 60_000 });

const T = "treasury.employai-demo.testnet";
const AGENT = "finance-agent.employai-demo.testnet";
const jitter = () => new Promise<void>(r => (Math.random() < 0.6 ? setImmediate(r) : setTimeout(r, Math.random() * 4)));

function simulatedNear(hooks: { onSign?: (n: number) => Promise<void> } = {}) {
  const net = { keyNonce: BigInt(277_000_000_000_000), executed: new Set<string>(), paid: new Map<string, number>(), rejectedNonces: 0 };
  const signed = new Map<string, { requestId: string; nonce: bigint; recipient: string; amount: string }>();
  const stats = { sign: 0, broadcast: 0, signingNow: 0, maxSigning: 0, sendingNow: 0, maxSending: 0, broadcastBytes: [] as string[] };
  const chain: PaymentChain = {
    target: { network: "testnet", contractId: T, expectedCodeHash: "HvewFdJa6y2jaJxWn5oU4VckoUDhXo61fKyvd9VFBDJt", agent: AGENT },
    async precheck() { return { failures: [], onchainSpentTodayYocto: "0", nearPolicyVersion: "npv-1", onchainLimits: { maxPerTxYocto: "100000000000000000000000", dailyCapYocto: "250000000000000000000000" }, checkedAt: new Date().toISOString() }; },
    async nearPolicyVersion() { return "npv-1"; },
    async sign(i) {
      const n = ++stats.sign;
      stats.signingNow++; stats.maxSigning = Math.max(stats.maxSigning, stats.signingNow);
      try {
        await jitter();
        if (hooks.onSign) await hooks.onSign(n);
        if ((i.mode ?? "new") === "new" && net.paid.has(i.requestId)) return { ok: false, code: "DUPLICATE_REQUEST", detail: "request already Paid on-chain", transient: false };
        const floor = i.minNonceExclusive ? BigInt(i.minNonceExclusive) : BigInt(0);
        const nonce = (net.keyNonce > floor ? net.keyNonce : floor) + BigInt(1);
        const bytes = `bytes:${i.requestId}:${nonce}:${n}`;
        signed.set(bytes, { requestId: i.requestId, nonce, recipient: i.recipient, amount: i.amountYocto });
        await jitter();
        return { ok: true, signed: { txHash: `tx:${bytes}`, signedTxBase64: bytes, nonce: nonce.toString(), publicKey: "ed25519:fake", blockHash: "bh", signedBlockHeight: 1_000, validityPeriodBlocks: 86_400, expiresAfterHeight: 87_400 } };
      } finally { stats.signingNow--; }
    },
    async broadcast(i): Promise<ChainVerdict> {
      stats.broadcast++; stats.broadcastBytes.push(i.signedTxBase64);
      stats.sendingNow++; stats.maxSending = Math.max(stats.maxSending, stats.sendingNow);
      try {
        await jitter();
        const tx = signed.get(i.signedTxBase64);
        if (!tx) throw new Error("broadcast of bytes that were never signed");
        const hash = `tx:${i.signedTxBase64}`;
        if (net.executed.has(i.signedTxBase64)) return { outcome: "confirmed", txHash: hash, gasBurnt: 1, evidence: {} };   // the same transaction: executes once
        if (tx.nonce <= net.keyNonce) { net.rejectedNonces++; return { outcome: "unknown", reason: "InvalidNonce" }; }
        net.keyNonce = tx.nonce; net.executed.add(i.signedTxBase64);
        if (net.paid.has(tx.requestId)) return { outcome: "failed_onchain", kind: "contract_rejected", detail: "request already exists", txHash: hash, evidence: {} };
        net.paid.set(tx.requestId, (net.paid.get(tx.requestId) ?? 0) + 1);
        return { outcome: "confirmed", txHash: hash, gasBurnt: 1, evidence: {} };
      } finally { stats.sendingNow--; }
    },
    async reconcile(f) {
      if (net.paid.has(f.requestId)) return { action: "settled", verdict: { outcome: "confirmed", txHash: f.txHash ?? "?", gasBurnt: 1, evidence: {} } };
      return { action: "wait", reason: "no record yet" };
    },
  };
  setPaymentChainForTests(chain);
  return { chain, net, stats, signed };
}

let kv: MemoryKv;
beforeEach(() => {
  kv = new MemoryKv({ latency: jitter });
  setKvForTests(kv);
  setDiscoveryRepository(new RedisStore(kv));
});
afterEach(() => { setDiscoveryRepository(null); setKvForTests(null); setPaymentChainForTests(null); });

let seq = 0;
async function approvedRun(owner: string) {
  const store = new RedisStore(kv);   // each business set up through its own "instance"
  const { businessId, workflow } = await readyRestaurant(store, { ownerHash: owner });
  await armTestnetBatch(businessId, { batchRef: "B3", maxPayments: 2, maxTotalNear: "0.25", expiresInMinutes: 60 });
  const { runId } = await startRun(businessId, { workflowId: workflow.id, scenario: "standard", idempotencyKey: `pc-${++seq}`, mode: "testnet", confirmRealTransactions: true });
  for (let i = 0; i < 25; i++) {
    const r = await runRead(businessId, tx => tx.run(businessId, runId)!);
    if (r.status !== "running") break;
    await advanceRun(businessId, runId);
  }
  const ap = await runRead(businessId, tx => tx.approvals(businessId).filter(a => a.run_id === runId).at(-1)!);
  expect(ap.status).toBe("pending");
  await decideApproval(businessId, ap.id, "approve");
  return { businessId, runId };
}
const view = (b: string, runId: string) => runRead(b, tx => ({ run: tx.run(b, runId)!, attempts: tx.attempts(b).filter(a => a.run_id === runId), ledger: tx.ledger(b).filter(l => l.run_id === runId && l.mode === "testnet"), events: tx.events(b).filter(e => e.correlation_id === runId) }));
const finished = (v: Awaited<ReturnType<typeof view>>) => v.run.status !== "running" && v.attempts.every(a => ["confirmed", "failed_onchain", "aborted", "expired_unexecuted"].includes(a.status));
async function driveToEnd(b: string, runId: string, max = 40) {
  for (let i = 0; i < max; i++) { if (finished(await view(b, runId))) break; await advanceRun(b, runId).catch(() => undefined); }
  return view(b, runId);
}

describe("payments across instances", () => {
  test("the same approved payment driven by 4 instances at once: one signature, one broadcast, paid exactly once", async () => {
    const sim = simulatedNear();
    const { businessId, runId } = await approvedRun("owner-same");
    await Promise.all(Array.from({ length: 4 }, () => advanceRun(businessId, runId).catch(() => undefined)));
    const v = await driveToEnd(businessId, runId);
    expect(v.run.status).toBe("completed");
    expect(v.attempts).toHaveLength(1);
    expect(v.attempts[0].status).toBe("confirmed");
    expect(sim.stats.sign).toBe(1);
    expect(sim.stats.broadcast).toBe(1);
    expect([...sim.net.paid.values()]).toEqual([1]);
    expect(v.ledger.filter(l => l.tx_status === "confirmed")).toHaveLength(1);
  });

  test("5 businesses paying concurrently: signing is serialised, nonces never collide, every payment lands exactly once", async () => {
    const sim = simulatedNear();
    const runs = [];
    for (let i = 0; i < 5; i++) runs.push(await approvedRun(`owner-${i}`));
    const results = await Promise.all(runs.map(r => driveToEnd(r.businessId, r.runId)));
    for (const v of results) {
      expect(v.run.status).toBe("completed");
      expect(v.attempts.map(a => a.status)).toEqual(["confirmed"]);
    }
    expect(sim.stats.maxSigning).toBe(1);
    expect(sim.stats.maxSending).toBe(1);
    expect(sim.net.rejectedNonces).toBe(0);
    expect(sim.net.paid.size).toBe(5);
    expect([...sim.net.paid.values()].every(n => n === 1)).toBe(true);
    const nonces = results.map(v => BigInt(v.attempts[0].nonce!));
    expect(new Set(nonces.map(String)).size).toBe(5);
    expect(await kv.get(signerNonceKey(AGENT))).toBe(nonces.reduce((a, b) => (a > b ? a : b)).toString());   // the shared floor = highest persisted
    expect(await kv.get(signerLockKey(AGENT))).toBeNull();   // released
  });

  test("a signer that stalls and loses its lease can't persist its signature, so those bytes are never broadcast", async () => {
    const sim = simulatedNear({
      onSign: async n => {
        if (n !== 1) return;
        // While signer #1 is busy, its lease expires and another instance takes the signer.
        await kv.del(signerLockKey(AGENT));
        await kv.lockAcquire(signerLockKey(AGENT), "another-instance", 45_000);
        setTimeout(() => { void kv.lockRelease(signerLockKey(AGENT), "another-instance"); }, 30);
      },
    });
    const { businessId, runId } = await approvedRun("owner-stall");
    const v = await driveToEnd(businessId, runId);
    expect(v.run.status).toBe("completed");
    expect(v.attempts.map(a => a.status)).toEqual(["confirmed"]);
    const first = [...sim.signed.keys()].find(k => k.endsWith(":1"))!;
    expect(first).toBeTruthy();
    expect(sim.stats.broadcastBytes).not.toContain(first);            // the stalled signer's bytes: never sent
    expect(sim.stats.sign).toBe(2);                                    // signed again from scratch, safely
    expect([...sim.net.paid.values()]).toEqual([1]);
    expect(v.events.some(e => e.type === "payment.signed")).toBe(true);
  });

  test("the coordination store failing before signing: nothing is signed (fail closed); it pays once when it recovers", async () => {
    const sim = simulatedNear();
    const { businessId, runId } = await approvedRun("owner-down");
    kv.failWith = new KvUnavailableError("down");
    await expect(advanceRun(businessId, runId)).rejects.toBeInstanceOf(KvUnavailableError);
    expect(sim.stats.sign).toBe(0);
    kv.failWith = null;
    const v = await driveToEnd(businessId, runId);
    expect(v.attempts.map(a => a.status)).toEqual(["confirmed"]);
    expect(sim.stats.sign).toBe(1);
    expect([...sim.net.paid.values()]).toEqual([1]);
  });

  test("only the signer lock unavailable: nothing is signed; after 3 tries the payment is abandoned, unsent", async () => {
    const sim = simulatedNear();
    const { businessId, runId } = await approvedRun("owner-lockdown");
    const orig = kv.lockAcquire.bind(kv);
    kv.lockAcquire = async (key, token, ttl) => { if (key.startsWith("lock:signer:")) throw new KvUnavailableError("signer lock down"); return orig(key, token, ttl); };
    const v = await driveToEnd(businessId, runId);
    kv.lockAcquire = orig;
    expect(sim.stats.sign).toBe(0);
    expect(sim.stats.broadcast).toBe(0);
    expect(v.attempts.map(a => [a.status, a.error?.code])).toEqual([["aborted", "COORDINATION_UNAVAILABLE"]]);
    expect(sim.net.paid.size).toBe(0);
  });

  test("operator pause (ops:testnet_paused): the payment is aborted, nothing signed or sent", async () => {
    const sim = simulatedNear();
    const { businessId, runId } = await approvedRun("owner-paused");
    await kv.set("ops:testnet_paused", "1");
    const v = await driveToEnd(businessId, runId);
    expect(v.attempts.map(a => [a.status, a.error?.code])).toEqual([["aborted", "TESTNET_PAUSED"]]);
    expect(sim.stats.sign).toBe(0);
    expect(sim.net.paid.size).toBe(0);
  });
});
