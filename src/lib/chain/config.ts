import "server-only";
// M5 · Chain configuration. Account IDs come from the environment (set by the owner); the expected
// contract code and the limits are constants tied to the reviewed Phase 1 artifact and the approved
// policy (R16), so the environment cannot loosen them. Private keys are NOT read here.

/** On-chain code_hash of the reviewed treasury WASM (sha256 fb79aad9…04ad), verified after B1. */
export const EXPECTED_TREASURY_CODE_HASH = "HvewFdJa6y2jaJxWn5oU4VckoUDhXo61fKyvd9VFBDJt";
/** Approved NEAR limits (R16): 0.1 NEAR per payment, 0.25 NEAR per day. */
export const NEAR_MAX_PER_TX_YOCTO = BigInt("100000000000000000000000");
export const NEAR_DAILY_CAP_YOCTO = BigInt("250000000000000000000000");
/** Storage cost per byte (B0: 1e19 yoctoNEAR) and the contract's reserve (1,000 bytes). */
export const STORAGE_BYTE_COST_YOCTO = BigInt("10000000000000000000");
export const STORAGE_RESERVE_BYTES = BigInt("1000");
/** Minimum agent balance for gas: ≥ 5 payments at the 0.01 NEAR worst case (B0-5). */
export const AGENT_GAS_RESERVE_YOCTO = BigInt("50000000000000000000000");
/** The accounts provisioned and verified in batch B1. The signer refuses any other configuration. */
export const APPROVED_ACCOUNTS = {
  owner: "employai-demo.testnet",
  treasury: "treasury.employai-demo.testnet",
  agent: "finance-agent.employai-demo.testnet",
  /** The restricted FunctionCall key added in B1 (verified in B2). The only key the app may sign with. */
  agentPublicKey: "ed25519:8qgGrnTtmKw8excey4uPcBdYL9hdsjnv1FzQECjGNFMZ",
} as const;
/** Prepaid gas for request_payment: 100 Tgas (worst case ≈ 0.01 NEAR at B0's gas price; unused gas is refunded). */
export const REQUEST_PAYMENT_GAS = BigInt("100000000000000");
/** Default RPC: the archival endpoint (it keeps old transactions; public nodes prune them, B0-4). */
export const DEFAULT_TESTNET_RPC_URL = "https://archival-rpc.testnet.fastnear.com";

export type ChainConfig = {
  network: "testnet";
  rpcUrl: string;
  owner: string;
  treasury: string;
  agent: string;
};

export type ChainConfigResult = { ok: true; config: ChainConfig } | { ok: false; missing: string[]; invalid: string[] };

const ACCOUNT_ID = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

/** Read and validate the chain configuration. Pure over the given environment (defaults to process.env). */
export function readChainConfig(env: Record<string, string | undefined> = process.env): ChainConfigResult {
  const missing: string[] = [];
  const invalid: string[] = [];
  const get = (name: string) => {
    const v = env[name]?.trim();
    if (!v) missing.push(name);
    return v ?? "";
  };
  const network = get("NEAR_NETWORK");
  const owner = get("NEAR_PARENT_ACCOUNT_ID");
  const treasury = get("NEAR_TREASURY_CONTRACT_ID");
  const agent = get("NEAR_FINANCE_AGENT_ACCOUNT_ID");
  const rpcUrl = env.NEAR_RPC_URL?.trim() || DEFAULT_TESTNET_RPC_URL;
  if (network && network !== "testnet") invalid.push("NEAR_NETWORK (only testnet is supported)");
  for (const [name, v] of [["NEAR_PARENT_ACCOUNT_ID", owner], ["NEAR_TREASURY_CONTRACT_ID", treasury], ["NEAR_FINANCE_AGENT_ACCOUNT_ID", agent]] as const) {
    if (v && (!ACCOUNT_ID.test(v) || !v.endsWith(".testnet"))) invalid.push(`${name} (must be a .testnet account ID)`);
  }
  if (!/^https:\/\//.test(rpcUrl)) invalid.push("NEAR_RPC_URL (must be https)");
  if (missing.length || invalid.length) return { ok: false, missing, invalid };
  return { ok: true, config: { network: "testnet", rpcUrl, owner, treasury, agent } };
}
