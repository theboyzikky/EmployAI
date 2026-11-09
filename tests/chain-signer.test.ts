// M5 CP-2 · Signer tests. No network and no real key: every key here is generated at random in memory
// (KeyPair.fromRandom) and never leaves the test. The approved agent public key is swapped for the
// random test key through a module mock, so the production constant itself stays pinned (see the
// static guard) and a non-approved key is still refused.
import { createHash } from "node:crypto";
import { KeyPair, PublicKey, SignedTransaction, baseEncode, encodeTransaction } from "near-api-js";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT, AGENT_FC_KEY, CONFIG, OWNER, S1, S2, T, fakeChain, fixture } from "./helpers/fake-chain";
import type { ViewAccessKeyResponse } from "@/lib/chain/types";

const approved = vi.hoisted(() => ({ agentPublicKey: "" }));
vi.mock("@/lib/chain/config", async importOriginal => {
  const orig = await importOriginal<typeof import("@/lib/chain/config")>();
  return {
    ...orig,
    APPROVED_ACCOUNTS: new Proxy(orig.APPROVED_ACCOUNTS, { get: (t, p) => (p === "agentPublicKey" ? approved.agentPublicKey : Reflect.get(t, p)) }),
  };
});

import { APPROVED_ACCOUNTS } from "@/lib/chain/config";
import { AGENT_KEY_ENV, AgentKeyError, loadAgentKey, type AgentKeyHandle } from "@/lib/chain/keys";
import { SignerRefusal, broadcastSigned, resetSignerStateForTests, signPaymentRequest, type PaymentToSign, type SignedPayment } from "@/lib/chain/signer";
import { RpcError } from "@/lib/chain/rpc";

const NEAR_0_1 = "100000000000000000000000";
const NEAR_0_05 = "50000000000000000000000";
const KEY_FIXTURE = fixture<ViewAccessKeyResponse>("b2-finance-agent-view_access_key.json");
const FIXTURE_NONCE = BigInt(String(KEY_FIXTURE.result!.nonce));
const FIXTURE_BLOCK = KEY_FIXTURE.result!.block_hash!;
const FIXTURE_HEIGHT = KEY_FIXTURE.result!.block_height!;

let secret: string;
let key: AgentKeyHandle;
let otherKey: AgentKeyHandle;

beforeAll(async () => {
  secret = KeyPair.fromRandom("ed25519").toString();
  key = await loadAgentKey({ [AGENT_KEY_ENV]: secret });
  otherKey = await loadAgentKey({ [AGENT_KEY_ENV]: KeyPair.fromRandom("ed25519").toString() });
  approved.agentPublicKey = key.publicKey;
});
beforeEach(() => resetSignerStateForTests());

/** Wrap the key so tests can see whether (and when) a signature was produced. */
function spyKey(k: AgentKeyHandle, calls?: string[]) {
  const signTransaction = vi.fn(async (tx: Parameters<AgentKeyHandle["signTransaction"]>[0]) => { calls?.push("SIGN"); return k.signTransaction(tx); });
  return { ...k, publicKey: k.publicKey, signTransaction } as AgentKeyHandle & { signTransaction: typeof signTransaction };
}
const pay = (over: Partial<PaymentToSign> = {}): PaymentToSign => ({ requestId: "pay-wf1-step3-0001", recipient: S1, amountYocto: NEAR_0_05, mode: "new", ...over } as PaymentToSign);
const keyView = (permission: unknown, extra: Record<string, unknown> = {}): ViewAccessKeyResponse =>
  ({ result: { nonce: 42, permission, block_hash: FIXTURE_BLOCK, block_height: FIXTURE_HEIGHT, ...extra } } as ViewAccessKeyResponse);
const fc = (over: Record<string, unknown> = {}) => keyView({ FunctionCall: { allowance: null, method_names: ["request_payment"], receiver_id: T, ...over } });
const record = (status: "Pending" | "Paid" | "Failed", over: Record<string, unknown> = {}) =>
  ({ recipient: S1, amount: NEAR_0_05, day: 20401, status, agent: AGENT, requested_at_block: 1, settled_at_block: status === "Pending" ? null : 2, attempts: 1, ...over });

async function refused(p: Promise<unknown>): Promise<SignerRefusal> {
  try { await p; } catch (e) { expect(e).toBeInstanceOf(SignerRefusal); return e as SignerRefusal; }
  throw new Error("expected a SignerRefusal, but the signer produced a transaction");
}

function decode(signed: SignedPayment) {
  const st = SignedTransaction.decode(Buffer.from(signed.signedTxBase64, "base64"));
  const tx = st.transaction;
  const fn = (tx.actions[0] as unknown as { functionCall: { methodName: string; args: Uint8Array; gas: bigint; deposit: bigint } }).functionCall;
  const sig = new Uint8Array((st.signature as unknown as { ed25519Signature: { data: ArrayLike<number> } }).ed25519Signature.data);
  return { st, tx, fn, sig };
}

describe("agent key loading", () => {
  it("refuses a missing key without echoing anything", async () => {
    await expect(loadAgentKey({})).rejects.toMatchObject({ code: "AGENT_KEY_MISSING" });
    await expect(loadAgentKey({ [AGENT_KEY_ENV]: "   " })).rejects.toBeInstanceOf(AgentKeyError);
  });

  it("refuses malformed and non-ed25519 keys, and the error never contains the input", async () => {
    for (const bad of ["ed25519:not-base58-0OIl", "secp256k1:" + secret.slice(8), secret.slice(8), "ed25519:"]) {
      const e = await loadAgentKey({ [AGENT_KEY_ENV]: bad }).then(() => null, (x: unknown) => x as AgentKeyError);
      expect(e).toBeInstanceOf(AgentKeyError);
      expect(e!.code).toBe("AGENT_KEY_INVALID");
      expect(`${e!.message} ${e!.stack}`).not.toContain(bad.slice(8, 30) || "\u0000");
    }
  });

  it("the handle exposes and serialises only the public key", async () => {
    const body = secret.slice("ed25519:".length);
    expect(key.publicKey).toMatch(/^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/);
    expect(JSON.stringify(key)).toBe(JSON.stringify({ publicKey: key.publicKey }));
    expect(String(key)).toBe(`AgentKey(${key.publicKey})`);
    expect(Object.keys(key).sort()).toEqual(["publicKey", "signTransaction", "toJSON", "toString"]);
    for (const v of Object.values(key)) expect(String(v)).not.toContain(body);
    expect(JSON.stringify({ nested: { key } })).not.toContain(body);
    expect(Object.isFrozen(key)).toBe(true);
  });
});

describe("transaction construction", () => {
  it("builds exactly one request_payment call to the treasury, signed by the agent's restricted key", async () => {
    const { reader } = fakeChain();
    const signed = await signPaymentRequest({ chain: reader, config: CONFIG, agentKey: key }, pay());
    const { st, tx, fn, sig } = decode(signed);

    expect(tx.signerId).toBe(AGENT);
    expect(tx.receiverId).toBe(T);
    expect(tx.publicKey.toString()).toBe(key.publicKey);
    expect(tx.nonce).toBe(FIXTURE_NONCE + BigInt(1));
    expect(baseEncode(new Uint8Array(tx.blockHash))).toBe(FIXTURE_BLOCK);
    expect(tx.actions).toHaveLength(1);
    expect(Object.keys(tx.actions[0])).toEqual(["functionCall"]);
    expect(fn.methodName).toBe("request_payment");
    expect(JSON.parse(Buffer.from(fn.args).toString("utf8"))).toEqual({ request_id: "pay-wf1-step3-0001", recipient: S1, amount: NEAR_0_05 });
    expect(fn.deposit).toBe(BigInt(0));
    expect(fn.gas).toBe(BigInt("100000000000000"));

    const hash = createHash("sha256").update(encodeTransaction(tx)).digest();
    expect(signed.txHash).toBe(baseEncode(hash));
    expect(PublicKey.fromString(key.publicKey).verify(new Uint8Array(hash), sig)).toBe(true);
    expect(PublicKey.fromString(otherKey.publicKey).verify(new Uint8Array(hash), sig)).toBe(false);
    expect(Buffer.from(st.encode()).toString("base64")).toBe(signed.signedTxBase64);
  });

  it("returns complete write-ahead data with the validity window, and no secret", async () => {
    const { reader } = fakeChain();
    const signed = await signPaymentRequest({ chain: reader, config: CONFIG, agentKey: key }, pay());
    expect(signed).toMatchObject({
      signerId: AGENT, receiverId: T, method: "request_payment", publicKey: key.publicKey,
      args: { request_id: "pay-wf1-step3-0001", recipient: S1, amount: NEAR_0_05 },
      nonce: (FIXTURE_NONCE + BigInt(1)).toString(), blockHash: FIXTURE_BLOCK,
      signedBlockHeight: FIXTURE_HEIGHT, validityPeriodBlocks: 86_400, expiresAfterHeight: FIXTURE_HEIGHT + 86_400,
    });
    expect(JSON.stringify(signed)).not.toContain(secret.slice(8));
  });

  it("allows exactly 0.1 NEAR (the per-transaction limit is inclusive)", async () => {
    const { reader } = fakeChain();
    const signed = await signPaymentRequest({ chain: reader, config: CONFIG, agentKey: key }, pay({ amountYocto: NEAR_0_1 }));
    expect(signed.args.amount).toBe(NEAR_0_1);
  });
});

describe("signing restrictions (fail closed; nothing is signed)", () => {
  const cases: Array<[string, Parameters<typeof fakeChain>[0], string]> = [
    ["a FullAccess key (e.g. the owner's key)", { keyResponse: keyView("FullAccess") }, "SIGNER_KEY_UNSAFE"],
    ["a key that is not on the agent account", { keyResponse: { result: { error: "access key does not exist while viewing", block_hash: FIXTURE_BLOCK, block_height: FIXTURE_HEIGHT } } }, "SIGNER_KEY_UNSAFE"],
    ["a key for another receiver", { keyResponse: fc({ receiver_id: "evil.testnet" }) }, "SIGNER_KEY_UNSAFE"],
    ["a key with extra methods", { keyResponse: fc({ method_names: ["request_payment", "settle"] }) }, "SIGNER_KEY_UNSAFE"],
    ["a key allowing every method", { keyResponse: fc({ method_names: [] }) }, "SIGNER_KEY_UNSAFE"],
    ["a key with a finite allowance (differs from the approved key)", { keyResponse: fc({ allowance: "250000000000000000000000" }) }, "SIGNER_KEY_UNSAFE"],
    ["an RPC error for the key view", { keyResponse: { error: { name: "HANDLER_ERROR" } } }, "SIGNER_KEY_UNSAFE"],
    ["a different treasury code hash", { accounts: { [T]: { amount: "2498538709076408000000002", locked: "0", code_hash: "11111111111111111111111111111111", storage_usage: 174820, block_height: 1, block_hash: "h" } } }, "TREASURY_CODE_MISMATCH"],
    ["a missing treasury", { accounts: { [T]: null } }, "TREASURY_NOT_FOUND"],
    ["a loosened per-transaction limit", { policy: { owner: OWNER, agent: AGENT, max_per_tx: "1000000000000000000000000", daily_cap: "250000000000000000000000", paused: false, sales_enabled: false } }, "TREASURY_POLICY_MISMATCH"],
    ["a loosened daily cap", { policy: { owner: OWNER, agent: AGENT, max_per_tx: NEAR_0_1, daily_cap: "500000000000000000000000", paused: false, sales_enabled: false } }, "TREASURY_POLICY_MISMATCH"],
    ["a different agent in the policy", { policy: { owner: OWNER, agent: "someone.testnet", max_per_tx: NEAR_0_1, daily_cap: "250000000000000000000000", paused: false, sales_enabled: false } }, "TREASURY_POLICY_MISMATCH"],
    ["a different owner in the policy", { policy: { owner: "someone.testnet", agent: AGENT, max_per_tx: NEAR_0_1, daily_cap: "250000000000000000000000", paused: false, sales_enabled: false } }, "TREASURY_POLICY_MISMATCH"],
    ["a daily-cap view that differs", { spentToday: { day: 1, spent: "0", daily_cap: "300000000000000000000000" } }, "TREASURY_POLICY_MISMATCH"],
    ["a paused treasury", { policy: { owner: OWNER, agent: AGENT, max_per_tx: NEAR_0_1, daily_cap: "250000000000000000000000", paused: true, sales_enabled: false } }, "TREASURY_PAUSED"],
    ["customer sales switched on", { salesEnabled: true }, "SALES_UNEXPECTEDLY_ENABLED"],
    ["an agent without gas money", { accounts: { [AGENT]: { amount: "1000", locked: "0", code_hash: "11111111111111111111111111111111", storage_usage: 182, block_height: 1, block_hash: "h" } } }, "INSUFFICIENT_GAS"],
    ["an underfunded treasury", { accounts: { [T]: { amount: "1750000000000000000000000", locked: "0", code_hash: "HvewFdJa6y2jaJxWn5oU4VckoUDhXo61fKyvd9VFBDJt", storage_usage: 174820, block_height: 1, block_hash: "h" } } }, "TREASURY_UNDERFUNDED"],
    ["an unknown recipient", { accounts: { [S1]: null } }, "RECIPIENT_NOT_FOUND"],
    ["a recipient that is a contract", { accounts: { [S1]: { amount: "1", locked: "0", code_hash: "HvewFdJa6y2jaJxWn5oU4VckoUDhXo61fKyvd9VFBDJt", storage_usage: 1, block_height: 1, block_hash: "h" } } }, "RECIPIENT_IS_CONTRACT"],
    ["a recipient not on the on-chain allowlist", { approved: [S2] }, "RECIPIENT_NOT_APPROVED_ONCHAIN"],
    ["a key view without a block reference", { keyResponse: { result: { nonce: 42, permission: { FunctionCall: { allowance: null, method_names: ["request_payment"], receiver_id: T } } } } }, "CHAIN_UNAVAILABLE"],
  ];
  it.each(cases)("refuses %s", async (_label, over, code) => {
    const { reader } = fakeChain(over);
    const k = spyKey(key);
    const e = await refused(signPaymentRequest({ chain: reader, config: CONFIG, agentKey: k }, pay()));
    expect(e.code).toBe(code);
    expect(k.signTransaction).not.toHaveBeenCalled();
    expect(e.message).not.toContain(secret.slice(8));
  });

  it("refuses a non-approved key before any chain read, even if that key's on-chain permission looks right", async () => {
    const { reader, calls } = fakeChain();
    const k = spyKey(otherKey);
    expect((await refused(signPaymentRequest({ chain: reader, config: CONFIG, agentKey: k }, pay()))).code).toBe("KEY_MISMATCH");
    expect(calls).toEqual([]);
    expect(k.signTransaction).not.toHaveBeenCalled();
  });

  it("the production approved key is the B1 restricted key (sanity check of the un-mocked constant)", async () => {
    const real = await vi.importActual<typeof import("@/lib/chain/config")>("@/lib/chain/config");
    expect(real.APPROVED_ACCOUNTS.agentPublicKey).toBe(AGENT_FC_KEY);
    expect(APPROVED_ACCOUNTS.agentPublicKey).toBe(key.publicKey);
  });

  const configs: Array<[string, Record<string, unknown>]> = [
    ["another network", { network: "mainnet" }],
    ["another treasury", { treasury: "treasury2.employai-demo.testnet" }],
    ["another agent", { agent: "other-agent.employai-demo.testnet" }],
    ["another owner", { owner: "someone-else.testnet" }],
    ["the owner as the signer account", { agent: OWNER }],
  ];
  it.each(configs)("refuses %s in the configuration, before any chain read", async (_label, over) => {
    const { reader, calls } = fakeChain();
    const k = spyKey(key);
    expect((await refused(signPaymentRequest({ chain: reader, config: { ...CONFIG, ...over } as typeof CONFIG, agentKey: k }, pay()))).code).toBe("ACCOUNT_CONFIG_MISMATCH");
    expect(calls).toEqual([]);
    expect(k.signTransaction).not.toHaveBeenCalled();
  });

  it("refuses a key whose permission changes between the readiness check and signing", async () => {
    const { reader, calls } = fakeChain({ keyResponses: [KEY_FIXTURE, keyView("FullAccess")] });
    const k = spyKey(key);
    expect((await refused(signPaymentRequest({ chain: reader, config: CONFIG, agentKey: k }, pay()))).code).toBe("SIGNER_KEY_UNSAFE");
    expect(calls.filter(c => c.startsWith("viewAccessKey:"))).toHaveLength(2);
    expect(k.signTransaction).not.toHaveBeenCalled();
  });

  it("the fresh key check is the last chain read, immediately before the signature", async () => {
    const { reader, calls } = fakeChain();
    const k = spyKey(key, calls);
    await signPaymentRequest({ chain: reader, config: CONFIG, agentKey: k }, pay());
    expect(calls.at(-1)).toBe("SIGN");
    expect(calls.at(-2)).toBe(`viewAccessKey:${AGENT}:${key.publicKey}`);
    for (const read of ["getSpentToday:", "getRequest:", "transactionValidityPeriod", "isApproved:", "getPolicy:"]) {
      expect(calls.findIndex(c => c.startsWith(read))).toBeLessThan(calls.length - 2);
    }
    expect(calls.filter(c => c.startsWith("viewAccessKey:")).every(c => c === `viewAccessKey:${AGENT}:${key.publicKey}`)).toBe(true);
  });
});

describe("amount, request and limit validation", () => {
  it.each(["0", "-1", "1.5", "01", "1e24", "abc", "", " 1"])("refuses the amount %j", async amountYocto => {
    const { reader, calls } = fakeChain();
    expect((await refused(signPaymentRequest({ chain: reader, config: CONFIG, agentKey: key }, pay({ amountYocto })))).code).toBe("INVALID_AMOUNT");
    expect(calls).toEqual([]);
  });

  it("refuses anything over 0.1 NEAR, by one yocto", async () => {
    const { reader, calls } = fakeChain();
    const over = (BigInt(NEAR_0_1) + BigInt(1)).toString();
    expect((await refused(signPaymentRequest({ chain: reader, config: CONFIG, agentKey: key }, pay({ amountYocto: over })))).code).toBe("OVER_TX_LIMIT");
    expect(calls).toEqual([]);
  });

  it("enforces the 0.25 NEAR daily total: exactly at the cap is allowed, one yocto over is refused", async () => {
    const atCap = fakeChain({ spentToday: { day: 1, spent: "200000000000000000000000", daily_cap: "250000000000000000000000" } });
    await expect(signPaymentRequest({ chain: atCap.reader, config: CONFIG, agentKey: key }, pay())).resolves.toBeDefined();
    const over = fakeChain({ spentToday: { day: 1, spent: "200000000000000000000001", daily_cap: "250000000000000000000000" } });
    expect((await refused(signPaymentRequest({ chain: over.reader, config: CONFIG, agentKey: key }, pay({ requestId: "pay-wf1-step3-0002" })))).code).toBe("OVER_DAILY_LIMIT");
  });

  it.each(["short", "has spaces in it", "a/b/c/d/e/f", "x".repeat(65), "ünïcode-id-1", "id\nwith-newline"])("refuses the request ID %j", async requestId => {
    const { reader, calls } = fakeChain();
    expect((await refused(signPaymentRequest({ chain: reader, config: CONFIG, agentKey: key }, pay({ requestId })))).code).toBe("INVALID_REQUEST_ID");
    expect(calls).toEqual([]);
  });
});

describe("duplicate-payment protection", () => {
  it.each(["Pending", "Paid", "Failed"] as const)("a new payment is refused when the request is already %s on-chain", async status => {
    const { reader } = fakeChain({ requests: { "pay-wf1-step3-0001": record(status) } });
    const k = spyKey(key);
    expect((await refused(signPaymentRequest({ chain: reader, config: CONFIG, agentKey: k }, pay()))).code).toBe("DUPLICATE_REQUEST");
    expect(k.signTransaction).not.toHaveBeenCalled();
  });

  it("a request is signed at most once per process, even when the chain has no record yet", async () => {
    const { reader } = fakeChain();
    await signPaymentRequest({ chain: reader, config: CONFIG, agentKey: key }, pay());
    expect((await refused(signPaymentRequest({ chain: reader, config: CONFIG, agentKey: key }, pay()))).code).toBe("DUPLICATE_REQUEST");
  });

  it("concurrent callers for the same request get exactly one signed transaction", async () => {
    const { reader } = fakeChain();
    const results = await Promise.allSettled([1, 2, 3, 4].map(() => signPaymentRequest({ chain: reader, config: CONFIG, agentKey: key }, pay())));
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results.filter((r): r is PromiseRejectedResult => r.status === "rejected")) expect((r.reason as SignerRefusal).code).toBe("DUPLICATE_REQUEST");
  });

  it.each([["no record", undefined], ["a Pending record", record("Pending")], ["a Paid record", record("Paid")]])("a retry is refused with %s", async (_l, rec) => {
    const { reader } = fakeChain({ requests: rec ? { "pay-wf1-step3-0001": rec } : {} });
    expect((await refused(signPaymentRequest({ chain: reader, config: CONFIG, agentKey: key }, pay({ mode: "retry_after_failed" })))).code).toBe("RETRY_NOT_ALLOWED");
  });

  it.each([["a different recipient", { recipient: S2 }], ["a different amount", { amount: "40000000000000000000000" }]])("a retry is refused with %s than the Failed record", async (_l, rec) => {
    const { reader } = fakeChain({ requests: { "pay-wf1-step3-0001": record("Failed", rec) } });
    expect((await refused(signPaymentRequest({ chain: reader, config: CONFIG, agentKey: key }, pay({ mode: "retry_after_failed" })))).code).toBe("RETRY_NOT_ALLOWED");
  });

  it("a retry of a Failed record with identical details is signed once per attempt", async () => {
    const { reader } = fakeChain({ requests: { "pay-wf1-step3-0001": record("Failed") } });
    const signed = await signPaymentRequest({ chain: reader, config: CONFIG, agentKey: key }, pay({ mode: "retry_after_failed" }));
    expect(signed.args).toEqual({ request_id: "pay-wf1-step3-0001", recipient: S1, amount: NEAR_0_05 });
    expect((await refused(signPaymentRequest({ chain: reader, config: CONFIG, agentKey: key }, pay({ mode: "retry_after_failed" })))).code).toBe("DUPLICATE_REQUEST");
    // the NEXT attempt (after this retry also failed on-chain) is a different attempt and may be signed
    const next = fakeChain({ requests: { "pay-wf1-step3-0001": record("Failed", { attempts: 2 }) } });
    await expect(signPaymentRequest({ chain: next.reader, config: CONFIG, agentKey: key }, pay({ mode: "retry_after_failed" }))).resolves.toBeDefined();
  });

  describe("resubmission after the validity window (plan §11.1)", () => {
    const previous = { args: { request_id: "pay-wf1-step3-0001", recipient: S1, amount: NEAR_0_05 }, expiresAfterHeight: 1_000_000 };
    it("is refused while the earlier transaction can still execute (window open, inclusive)", async () => {
      const { reader } = fakeChain({ height: 1_000_000 });
      expect((await refused(signPaymentRequest({ chain: reader, config: CONFIG, agentKey: key }, pay({ mode: "resubmit_after_expiry", previous })))).code).toBe("RESUBMIT_NOT_ALLOWED");
    });
    it.each(["Pending", "Paid", "Failed"] as const)("is refused when a %s record exists", async status => {
      const { reader } = fakeChain({ height: 2_000_000, requests: { "pay-wf1-step3-0001": record(status) } });
      expect((await refused(signPaymentRequest({ chain: reader, config: CONFIG, agentKey: key }, pay({ mode: "resubmit_after_expiry", previous })))).code).toBe("RESUBMIT_NOT_ALLOWED");
    });
    it("is refused with different details", async () => {
      const { reader } = fakeChain({ height: 2_000_000 });
      const p = pay({ mode: "resubmit_after_expiry", previous: { ...previous, args: { ...previous.args, amount: NEAR_0_1 } } });
      expect((await refused(signPaymentRequest({ chain: reader, config: CONFIG, agentKey: key }, p))).code).toBe("RESUBMIT_NOT_ALLOWED");
    });
    it("is signed only after expiry, with no record and identical details, even though the original was signed here", async () => {
      const first = fakeChain();
      await signPaymentRequest({ chain: first.reader, config: CONFIG, agentKey: key }, pay());
      const later = fakeChain({ height: 2_000_000 });
      const re = await signPaymentRequest({ chain: later.reader, config: CONFIG, agentKey: key }, pay({ mode: "resubmit_after_expiry", previous }));
      expect(re.args).toEqual(previous.args);
    });
  });
});

describe("nonces", () => {
  it("uses on-chain nonce + 1, then keeps increasing while the chain has not caught up", async () => {
    const { reader } = fakeChain();
    const a = await signPaymentRequest({ chain: reader, config: CONFIG, agentKey: key }, pay({ requestId: "pay-req-000001" }));
    const b = await signPaymentRequest({ chain: reader, config: CONFIG, agentKey: key }, pay({ requestId: "pay-req-000002" }));
    expect([a.nonce, b.nonce]).toEqual([(FIXTURE_NONCE + BigInt(1)).toString(), (FIXTURE_NONCE + BigInt(2)).toString()]);
  });

  it("follows the chain when its nonce is ahead of this process", async () => {
    const { reader } = fakeChain();
    await signPaymentRequest({ chain: reader, config: CONFIG, agentKey: key }, pay({ requestId: "pay-req-000001" }));
    const ahead = { result: { ...KEY_FIXTURE.result!, nonce: Number(FIXTURE_NONCE) + 500 } };
    const b = await signPaymentRequest({ chain: fakeChain({ keyResponse: ahead }).reader, config: CONFIG, agentKey: key }, pay({ requestId: "pay-req-000002" }));
    expect(b.nonce).toBe((FIXTURE_NONCE + BigInt(501)).toString());
  });

  it("concurrent signatures get distinct, consecutive nonces", async () => {
    const { reader } = fakeChain();
    const out = await Promise.all([1, 2, 3, 4, 5].map(i => signPaymentRequest({ chain: reader, config: CONFIG, agentKey: key }, pay({ requestId: `pay-req-00000${i}` }))));
    expect(out.map(s => BigInt(s.nonce) - FIXTURE_NONCE).sort()).toEqual([1, 2, 3, 4, 5].map(n => BigInt(n)));
    expect(new Set(out.map(s => s.txHash)).size).toBe(5);
  });

  it("a refusal does not consume a nonce", async () => {
    const { reader } = fakeChain({ requests: { "pay-req-000001": record("Paid") } });
    await refused(signPaymentRequest({ chain: reader, config: CONFIG, agentKey: key }, pay({ requestId: "pay-req-000001" })));
    const ok = await signPaymentRequest({ chain: reader, config: CONFIG, agentKey: key }, pay({ requestId: "pay-req-000002" }));
    expect(ok.nonce).toBe((FIXTURE_NONCE + BigInt(1)).toString());
  });
});

describe("failure handling", () => {
  it.each(["viewAccount", "getPolicy", "getSalesEnabled", "viewAccessKey", "isApproved", "getSpentToday", "getRequest", "transactionValidityPeriod"])(
    "an RPC failure in %s refuses with CHAIN_UNAVAILABLE and signs nothing",
    async method => {
      const { reader } = fakeChain({ failOn: [method] });
      const k = spyKey(key);
      expect((await refused(signPaymentRequest({ chain: reader, config: CONFIG, agentKey: k }, pay()))).code).toBe("CHAIN_UNAVAILABLE");
      expect(k.signTransaction).not.toHaveBeenCalled();
    },
  );

  it("a failure inside the signing step is a SIGNING_FAILED refusal (not CHAIN_UNAVAILABLE), not a crash, and leaks no detail", async () => {
    const { reader } = fakeChain();
    const k = { ...key, signTransaction: vi.fn(async () => { throw new Error(`boom ${secret}`); }) } as AgentKeyHandle;
    const e = await refused(signPaymentRequest({ chain: reader, config: CONFIG, agentKey: k }, pay()));
    expect(e.code).toBe("SIGNING_FAILED");   // a local signing failure, distinct from a chain read failure
    expect(e.message).not.toContain(secret.slice(8));
    // nothing was recorded as signed, so the request may be signed once it works again
    await expect(signPaymentRequest({ chain: reader, config: CONFIG, agentKey: key }, pay())).resolves.toBeDefined();
  });

  it("a refusal does not block the next caller (the per-key lock is released)", async () => {
    const { reader } = fakeChain();
    const results = await Promise.allSettled([
      signPaymentRequest({ chain: fakeChain({ failOn: ["getRequest"] }).reader, config: CONFIG, agentKey: key }, pay({ requestId: "pay-req-000001" })),
      signPaymentRequest({ chain: reader, config: CONFIG, agentKey: key }, pay({ requestId: "pay-req-000002" })),
    ]);
    expect(results.map(r => r.status)).toEqual(["rejected", "fulfilled"]);
  });
});

describe("broadcast", () => {
  it("posts the identical signed bytes once via send_tx and never retries", async () => {
    const { reader } = fakeChain();
    const signed = await signPaymentRequest({ chain: reader, config: CONFIG, agentKey: key }, pay());
    const sendTx = vi.fn(async () => { throw new RpcError("TIMEOUT", "timed out"); });
    const r = await broadcastSigned({ sendTx } as never, signed);
    expect(sendTx).toHaveBeenCalledTimes(1);
    expect(sendTx).toHaveBeenCalledWith(signed.signedTxBase64);
    expect(r).toEqual({ status: "unknown", reason: expect.stringContaining("reconcile via get_request") });
  });

  it("returns the final outcome when the node reports one", async () => {
    const outcome = fixture<{ result: unknown }>("b2-c1-contract-rejected.tx.json");
    const sendTx = vi.fn(async () => outcome.result);
    const r = await broadcastSigned({ sendTx } as never, { signedTxBase64: "AAAA" });
    expect(r).toEqual({ status: "final", result: outcome.result });
  });

  it("the rpc client's sendTx posts one send_tx request with wait_until FINAL", async () => {
    const { createRpcClient } = await import("@/lib/chain/rpc");
    const bodies: unknown[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: "x", error: { name: "HANDLER_ERROR", cause: { name: "TIMEOUT_ERROR" } } }), { status: 200 });
    });
    const rpc = createRpcClient({ url: "https://rpc.example.test", fetchImpl: fetchImpl as never });
    await expect(rpc.sendTx("c2lnbmVk")).rejects.toBeInstanceOf(RpcError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(bodies[0]).toMatchObject({ method: "send_tx", params: { signed_tx_base64: "c2lnbmVk", wait_until: "FINAL" } });
  });
});

