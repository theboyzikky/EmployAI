// M5 Phase 3 · RPC client and config. The client gets an INJECTED fetch; the global fetch stays blocked
// (tests/setup.ts), proving no test touches the network.
import { describe, expect, it, vi } from "vitest";
import { createRpcClient, RpcError } from "@/lib/chain/rpc";
import { chainReaderFromRpc } from "@/lib/chain/port";
import { DEFAULT_TESTNET_RPC_URL, readChainConfig } from "@/lib/chain/config";
import { AGENT, AGENT_FC_KEY, T, fixture } from "./helpers/fake-chain";

type Body = { method: string; params: Record<string, unknown> };
function fakeFetch(handler: (b: Body) => unknown, status = 200) {
  return vi.fn(async (_url: string, init: { body: string }) => ({ ok: status === 200, status, json: async () => handler(JSON.parse(init.body) as Body) }));
}
const URL = "https://rpc.example.test";

describe("createRpcClient", () => {
  it("returns null for UNKNOWN_ACCOUNT and the account otherwise", async () => {
    const f = fakeFetch(b => (b.params.account_id === "missing.testnet"
      ? { error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT" } } }
      : { result: { amount: "1", locked: "0", code_hash: "x", storage_usage: 1, block_height: 1, block_hash: "h" } }));
    const rpc = createRpcClient({ url: URL, fetchImpl: f });
    expect(await rpc.viewAccount("missing.testnet")).toBeNull();
    expect((await rpc.viewAccount("ok.testnet"))?.amount).toBe("1");
    expect(f.mock.calls[0][1].body).toContain('"finality":"final"');
  });

  it("passes view_access_key through RAW, so result.error (B0-1) reaches the verifier", async () => {
    const missing = { result: { error: "access key does not exist while viewing", logs: [] } };
    const rpc = createRpcClient({ url: URL, fetchImpl: fakeFetch(() => missing) });
    expect(await rpc.viewAccessKey(AGENT, AGENT_FC_KEY)).toEqual(missing);
  });

  it("decodes view-function results and maps reader methods to the treasury views", async () => {
    const policy = { owner: "o.testnet", agent: AGENT, max_per_tx: "1", daily_cap: "2", paused: false, sales_enabled: false };
    const f = fakeFetch(b => {
      const m = b.params.method_name as string;
      const v = m === "get_policy" ? policy : m === "get_request" ? null : m === "is_approved" ? true : m === "get_sales_config" ? { enabled: false } : null;
      return { result: { result: [...Buffer.from(JSON.stringify(v))] } };
    });
    const reader = chainReaderFromRpc(createRpcClient({ url: URL, fetchImpl: f }));
    expect(await reader.getPolicy(T)).toEqual(policy);
    expect(await reader.getRequest(T, "run-1:payment")).toBeNull();
    expect(await reader.isApproved(T, "s.testnet")).toBe(true);
    expect(await reader.getSalesEnabled(T)).toBe(false);
    const sent = f.mock.calls.map(c => JSON.parse(c[1].body) as Body);
    expect(sent.map(s => s.params.method_name)).toEqual(["get_policy", "get_request", "is_approved", "get_sales_config"]);
    expect(Buffer.from(sent[1].params.args_base64 as string, "base64").toString()).toBe('{"request_id":"run-1:payment"}');
  });

  it("returns 'unknown_transaction' for UNKNOWN_TRANSACTION (never treated as non-execution here)", async () => {
    const rpc = createRpcClient({ url: URL, fetchImpl: fakeFetch(() => ({ error: { cause: { name: "UNKNOWN_TRANSACTION" } } })) });
    expect(await rpc.txStatus("h", AGENT)).toBe("unknown_transaction");
  });

  it("returns a real tx status result unchanged", async () => {
    const c1 = fixture<{ result: unknown }>("b2-c1-contract-rejected.tx.json");
    const rpc = createRpcClient({ url: URL, fetchImpl: fakeFetch(() => c1) });
    expect(await rpc.txStatus("46cdG6k5U7pnxmGDU1PRgeRXwueR1WyfETWbtV6EwgEu", AGENT)).toEqual(c1.result);
  });

  it("raises typed errors for HTTP failure, timeouts and other RPC errors", async () => {
    await expect(createRpcClient({ url: URL, fetchImpl: fakeFetch(() => ({}), 503) }).finalBlockHeight()).rejects.toMatchObject({ kind: "HTTP" });
    const hang = vi.fn((_u: string, init: { signal: AbortSignal }) => new Promise<never>((_, rej) => init.signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })))));
    await expect(createRpcClient({ url: URL, fetchImpl: hang, timeoutMs: 20 }).finalBlockHeight()).rejects.toMatchObject({ kind: "TIMEOUT" });
    await expect(createRpcClient({ url: URL, fetchImpl: fakeFetch(() => ({ error: { cause: { name: "UNKNOWN_BLOCK" } } })) }).finalBlockHeight()).rejects.toBeInstanceOf(RpcError);
  });

  it("reads the validity period and final height", async () => {
    const rpc = createRpcClient({ url: URL, fetchImpl: fakeFetch(b => (b.method === "block" ? { result: { header: { height: 276940000 } } } : { result: { transaction_validity_period: 86400 } })) });
    expect(await rpc.finalBlockHeight()).toBe(276940000);
    expect(await rpc.transactionValidityPeriod()).toBe(86400);
  });

  it("never uses the global fetch when one is injected", async () => {
    await createRpcClient({ url: URL, fetchImpl: fakeFetch(() => ({ result: { header: { height: 1 } } })) }).finalBlockHeight();
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
  });
});

describe("readChainConfig", () => {
  const env = { NEAR_NETWORK: "testnet", NEAR_PARENT_ACCOUNT_ID: "employai-demo.testnet", NEAR_TREASURY_CONTRACT_ID: T, NEAR_FINANCE_AGENT_ACCOUNT_ID: AGENT };
  it("accepts the B1 accounts and defaults to the archival RPC", () => {
    expect(readChainConfig(env)).toEqual({ ok: true, config: { network: "testnet", rpcUrl: DEFAULT_TESTNET_RPC_URL, owner: "employai-demo.testnet", treasury: T, agent: AGENT } });
  });
  it("lists missing settings", () => {
    const r = readChainConfig({ NEAR_NETWORK: "testnet" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.missing).toEqual(["NEAR_PARENT_ACCOUNT_ID", "NEAR_TREASURY_CONTRACT_ID", "NEAR_FINANCE_AGENT_ACCOUNT_ID"]);
  });
  it("refuses mainnet, non-testnet accounts and non-https RPC URLs", () => {
    for (const bad of [{ ...env, NEAR_NETWORK: "mainnet" }, { ...env, NEAR_TREASURY_CONTRACT_ID: "treasury.near" }, { ...env, NEAR_RPC_URL: "http://rpc.testnet" }]) {
      expect(readChainConfig(bad).ok).toBe(false);
    }
  });
});
