import { afterEach, beforeEach, vi } from "vitest";

// Tests that talk to a LOCAL test server (127.0.0.1) pass this real fetch explicitly.
const realFetch = globalThis.fetch;
(globalThis as unknown as { __realFetch: typeof fetch }).__realFetch = realFetch;

// No test may reach the network implicitly (and so no test can ever make a NEAR AI call).
export const blockedFetch = vi.fn(() => { throw new Error("Network access is disabled in tests"); });
beforeEach(() => {
  blockedFetch.mockClear();
  vi.stubGlobal("fetch", blockedFetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
});
