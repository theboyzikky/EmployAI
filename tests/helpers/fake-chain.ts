// In-memory ChainReader for tests: no network. State defaults to the VERIFIED post-B1/B2 testnet state
// (docs/architecture/poc-results/m5-batches.md). Every call is recorded so tests can assert on reads.
import { readFileSync } from "node:fs";
import path from "node:path";
import type { ChainReader } from "@/lib/chain/port";
import type { AccountView, PaymentRequestRecord, SpentToday, TreasuryPolicy, TxStatusResult, ViewAccessKeyResponse } from "@/lib/chain/types";

export const T = "treasury.employai-demo.testnet";
export const OWNER = "employai-demo.testnet";
export const AGENT = "finance-agent.employai-demo.testnet";
export const S1 = "supplier-1.employai-demo.testnet";
export const S2 = "supplier-2.employai-demo.testnet";
export const AGENT_FC_KEY = "ed25519:8qgGrnTtmKw8excey4uPcBdYL9hdsjnv1FzQECjGNFMZ";
export const CONFIG = { network: "testnet" as const, rpcUrl: "https://archival-rpc.testnet.fastnear.com", owner: OWNER, treasury: T, agent: AGENT };

export const fixture = <X>(name: string): X => JSON.parse(readFileSync(path.join(process.cwd(), "tests/fixtures/near", name), "utf8")) as X;

const plain = (amount: string, storage = 182): AccountView => ({ amount, locked: "0", code_hash: "11111111111111111111111111111111", storage_usage: storage, block_height: 1, block_hash: "h" });

export function fakeChain(over: Partial<{
  accounts: Record<string, AccountView | null>;
  keyResponse: ViewAccessKeyResponse;
  /** Successive key views (readiness first, then the pre-signing check); the last one repeats. */
  keyResponses: ViewAccessKeyResponse[];
  spentToday: SpentToday;
  policy: TreasuryPolicy;
  salesEnabled: boolean;
  approved: string[];
  requests: Record<string, PaymentRequestRecord>;
  txs: Record<string, TxStatusResult | "unknown_transaction">;
  height: number;
  validity: number;
  failOn: string[];
}> = {}) {
  const calls: string[] = [];
  const accounts: Record<string, AccountView | null> = {
    [OWNER]: plain("6770867689254873299999998"),
    [T]: { amount: "2498538709076408000000002", locked: "0", code_hash: "HvewFdJa6y2jaJxWn5oU4VckoUDhXo61fKyvd9VFBDJt", storage_usage: 174820, block_height: 1, block_hash: "h" },
    [AGENT]: plain("499488732082494500000000"),
    [S1]: plain("100000000000000000000000"),
    [S2]: plain("100000000000000000000000"),
    ...over.accounts,
  };
  const policy: TreasuryPolicy = over.policy ?? { owner: OWNER, agent: AGENT, max_per_tx: "100000000000000000000000", daily_cap: "250000000000000000000000", paused: false, sales_enabled: false };
  const approved = new Set(over.approved ?? [S1, S2]);
  let keyView = 0;
  const fail = (m: string) => { if (over.failOn?.includes(m)) throw new Error(`simulated RPC failure: ${m}`); };
  const reader: ChainReader = {
    async viewAccount(id) { calls.push(`viewAccount:${id}`); fail("viewAccount"); return id in accounts ? accounts[id] : null; },
    async viewAccessKey(id, pk) { calls.push(`viewAccessKey:${id}:${pk}`); fail("viewAccessKey");
      if (over.keyResponses) return over.keyResponses[Math.min(keyView++, over.keyResponses.length - 1)];
      return over.keyResponse ?? fixture<ViewAccessKeyResponse>("b2-finance-agent-view_access_key.json"); },
    async getPolicy(t) { calls.push(`getPolicy:${t}`); fail("getPolicy"); return policy; },
    async getRequest(t, id) { calls.push(`getRequest:${id}`); fail("getRequest"); return over.requests?.[id] ?? null; },
    async isApproved(t, a) { calls.push(`isApproved:${a}`); fail("isApproved"); return approved.has(a); },
    async getSalesEnabled(t) { calls.push(`getSalesEnabled:${t}`); fail("getSalesEnabled"); return over.salesEnabled ?? false; },
    async getSpentToday(t) { calls.push(`getSpentToday:${t}`); fail("getSpentToday"); return over.spentToday ?? { day: 20401, spent: "0", daily_cap: "250000000000000000000000" }; },
    async txStatus(h, s) { calls.push(`txStatus:${h}`); fail("txStatus"); return over.txs?.[h] ?? "unknown_transaction"; },
    async finalBlockHeight() { calls.push("finalBlockHeight"); fail("finalBlockHeight"); return over.height ?? 276_940_000; },
    async transactionValidityPeriod() { calls.push("transactionValidityPeriod"); fail("transactionValidityPeriod"); return over.validity ?? 86_400; },
  };
  return { reader, calls };
}
