// M5 Phase 3 · Strict restricted-key verifier (AC5-3), tested against the REAL B2 response from the
// EmployAI-controlled finance-agent key (B0-3) and every unsafe variant, including B0's observed shapes.
import { describe, expect, it } from "vitest";
import { verifyRestrictedKey } from "@/lib/chain/key-check";
import type { ViewAccessKeyResponse } from "@/lib/chain/types";
import { T, fixture } from "./helpers/fake-chain";

const real = fixture<ViewAccessKeyResponse>("b2-finance-agent-view_access_key.json");
const fc = (f: Record<string, unknown>): ViewAccessKeyResponse =>
  ({ result: { nonce: 5, block_hash: "h", block_height: 1, permission: { FunctionCall: { allowance: null, receiver_id: T, method_names: ["request_payment"], ...f } } } }) as ViewAccessKeyResponse;

describe("verifyRestrictedKey", () => {
  it("accepts the real on-chain response captured in B2", () => {
    expect(verifyRestrictedKey(real, { treasury: T })).toEqual({ ok: true, nonce: 276931238000000 });
  });

  it.each<[string, ViewAccessKeyResponse | null]>([
    ["FullAccess (B0 shape)", { result: { nonce: 1, permission: "FullAccess" } }],
    ["missing key reported inside result.error (B0-1 shape)", { result: { error: "access key ed25519:111 does not exist while viewing", logs: [] } }],
    ["another receiver", fc({ receiver_id: "evil.testnet" })],
    ["an extra method", fc({ method_names: ["request_payment", "pause"] })],
    ["no methods (= every method)", fc({ method_names: [] })],
    ["a different single method", fc({ method_names: ["withdraw"] })],
    ["an allowance set", fc({ allowance: "250000000000000000000000" })],
    ["an RPC error", { error: { name: "HANDLER_ERROR" } }],
    ["no result", {}],
    ["null response", null],
  ])("refuses %s", (_label, resp) => {
    const r = verifyRestrictedKey(resp, { treasury: T });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("SIGNER_KEY_UNSAFE");
  });

  it("refuses the real response when the configured treasury differs", () => {
    expect(verifyRestrictedKey(real, { treasury: "treasury-v2.employai-demo.testnet" }).ok).toBe(false);
  });
});
