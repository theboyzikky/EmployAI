import "server-only";
// M5 · The Finance Agent's signing key. The ONLY module that reads NEAR_FINANCE_AGENT_PRIVATE_KEY.
// The key stays inside a closure: the returned handle exposes only the public key and a sign
// function, serialises to the public key alone, and no error message ever contains key material.
// Whether the key is SAFE to use is decided on-chain by the signer (key-check.ts) before every
// signature: this module only loads it.
import { KeyPairSigner, type SignedTransaction, type Transaction } from "near-api-js";

export const AGENT_KEY_ENV = "NEAR_FINANCE_AGENT_PRIVATE_KEY";

export type AgentKeyHandle = {
  readonly publicKey: string;
  signTransaction(tx: Transaction): Promise<{ txHash: Uint8Array; signedTransaction: SignedTransaction }>;
  toJSON(): { publicKey: string };
  toString(): string;
};

export class AgentKeyError extends Error {
  constructor(readonly code: "AGENT_KEY_MISSING" | "AGENT_KEY_INVALID", message: string) {
    super(message);
    this.name = "AgentKeyError";
  }
}

/** Load the agent key from the environment (never from a file, never logged). ed25519 only. */
export async function loadAgentKey(env: Record<string, string | undefined> = process.env): Promise<AgentKeyHandle> {
  const raw = env[AGENT_KEY_ENV]?.trim();
  if (!raw) throw new AgentKeyError("AGENT_KEY_MISSING", `${AGENT_KEY_ENV} is not set`);
  if (!raw.startsWith("ed25519:")) throw new AgentKeyError("AGENT_KEY_INVALID", `${AGENT_KEY_ENV} must be an ed25519 key`);
  let signer: KeyPairSigner;
  let publicKey: string;
  try {
    signer = KeyPairSigner.fromSecretKey(raw as `ed25519:${string}`);
    publicKey = (await signer.getPublicKey()).toString();
  } catch {
    throw new AgentKeyError("AGENT_KEY_INVALID", `${AGENT_KEY_ENV} could not be parsed`);
  }
  const handle: AgentKeyHandle = {
    publicKey,
    signTransaction: tx => signer.signTransaction(tx),
    toJSON: () => ({ publicKey }),
    toString: () => `AgentKey(${publicKey})`,
  };
  return Object.freeze(handle);
}
