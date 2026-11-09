import "server-only";
// M5 · Strict verifier for the Finance Agent's signing key (plan §5.3, B0-1 to B0-3, AC5-3).
// The app may sign ONLY if the configured key's on-chain permission is exactly
//   { FunctionCall: { receiver_id: <treasury>, method_names: ["request_payment"], allowance: null } }
// Anything else refuses, including FullAccess, a missing key (reported inside result.error), any RPC
// error, or an unparseable response. Fail closed: "unverified" means "do not sign".
import type { ViewAccessKeyResponse } from "./types";

export type KeyCheck =
  | { ok: true; nonce: number }
  | { ok: false; code: "SIGNER_KEY_UNSAFE"; reason: string };

export function verifyRestrictedKey(resp: ViewAccessKeyResponse | null | undefined, expected: { treasury: string }): KeyCheck {
  const unsafe = (reason: string): KeyCheck => ({ ok: false, code: "SIGNER_KEY_UNSAFE", reason });
  if (!resp || typeof resp !== "object") return unsafe("no response");
  if (resp.error) return unsafe("RPC error while reading the key");
  const r = resp.result;
  if (!r || typeof r !== "object") return unsafe("no result");
  if (typeof r.error === "string") return unsafe(`key missing: ${r.error}`);
  const p = r.permission;
  if (p === "FullAccess") return unsafe("FullAccess keys are never accepted");
  if (!p || typeof p !== "object" || !("FunctionCall" in p) || !p.FunctionCall) return unsafe("unexpected permission");
  const f = p.FunctionCall;
  if (f.receiver_id !== expected.treasury) return unsafe(`receiver ${String(f.receiver_id)} is not the treasury`);
  if (!Array.isArray(f.method_names) || f.method_names.length !== 1 || f.method_names[0] !== "request_payment") {
    return unsafe(`methods ${JSON.stringify(f.method_names)} (must be exactly ["request_payment"]; [] would allow every method)`);
  }
  if (f.allowance !== null) return unsafe("an allowance is set (must be null)");
  if (typeof r.nonce !== "number") return unsafe("nonce missing");
  // JSON numbers above 2^53 lose precision, and a wrong nonce must never be signed: refuse instead.
  // (Today's nonces are ~2.8e14, about 30× below the limit; NEAR nonces grow with block height × 1e6.)
  if (!Number.isSafeInteger(r.nonce) || r.nonce < 0) return unsafe("nonce outside the exactly representable range");
  return { ok: true, nonce: r.nonce };
}
