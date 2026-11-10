// M0.2 · Connections and per-business encrypted credentials. Runs on the file store and (npm run
// test:shared) on the shared store. A test connector stands in for a real one (it never reaches out).
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({ jar: new Map<string, string>(), headers: new Map<string, string>([["host", "localhost:3101"]]) }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (n: string) => (h.jar.has(n) ? { name: n, value: h.jar.get(n)! } : undefined), set: (n: string, v: string) => { h.jar.set(n, v); } }),
  headers: async () => ({ get: (n: string) => h.headers.get(n.toLowerCase()) ?? null }),
}));

import { GET as listRoute, POST as createRoute } from "@/app/api/w/[id]/connections/route";
import { PATCH as patchRoute } from "@/app/api/w/[id]/connections/[connectionId]/route";
import { discoveryRepository, hashOwnerToken, setDiscoveryRepository } from "@/lib/discovery/store";
import { CredentialError, decryptSecrets, encryptSecrets } from "@/lib/integrations/credentials";
import { createConnection, IntegrationError, listConnections, loadConnectionForUse, setConnectionStatus } from "@/lib/integrations/connections";
import { registerConnector, unregisterConnectorForTests } from "@/lib/integrations/registry";
import type { Connector } from "@/lib/integrations/types";
import { MemoryKv } from "@/lib/kv";
import { RedisStore, storeKeys } from "@/lib/store/redis-store";
import { readyRestaurant, tempStore } from "./helpers/run-fixture";

const KEY = "k".repeat(40);
const SECRET = "super-secret-token-value-0123456789";
const testConnector: Connector = {
  key: "test_channel", name: "Test channel", kind: "communication", reality: "simulated", eventTypes: ["message.received"],
  actions: { "test_channel.send": { sideEffect: "external_message", idempotency: "none", parse: x => x as Record<string, unknown>, execute: async () => ({ kind: "done", ref: "m1" }) } },
  setup: (input: unknown) => {
    const i = input as { token?: string };
    if (!i.token) throw new Error("A token is required.");
    return { config: { mode: "test" }, secrets: { token: i.token, signing: "generated-signing-secret" }, revealOnce: { signing: "generated-signing-secret" } };
  },
};

beforeEach(() => { vi.stubEnv("APP_ENCRYPTION_KEY", KEY); registerConnector(testConnector); h.jar.clear(); });
afterEach(() => { vi.unstubAllEnvs(); unregisterConnectorForTests("test_channel"); setDiscoveryRepository(null); });

describe("credential encryption", () => {
  test("round trip; ciphertext never contains the secret", () => {
    const blob = encryptSecrets("biz-1", "conn-1", { token: SECRET });
    expect(JSON.stringify(blob)).not.toContain(SECRET);
    expect(decryptSecrets("biz-1", "conn-1", blob)).toEqual({ token: SECRET });
    expect(encryptSecrets("biz-1", "conn-1", { token: SECRET }).iv).not.toBe(blob.iv);   // fresh IV each time
  });
  test("tampering, a swapped connection, another business or another key: all refused, with the same error", () => {
    const blob = encryptSecrets("biz-1", "conn-1", { token: SECRET });
    const flip = (s: string) => (s[0] === "A" ? "B" : "A") + s.slice(1);
    expect(() => decryptSecrets("biz-1", "conn-1", { ...blob, ct: flip(blob.ct) })).toThrow(CredentialError);
    expect(() => decryptSecrets("biz-1", "conn-1", { ...blob, tag: flip(blob.tag) })).toThrow(CredentialError);
    expect(() => decryptSecrets("biz-1", "conn-2", blob)).toThrow(CredentialError);
    expect(() => decryptSecrets("biz-2", "conn-1", blob)).toThrow(CredentialError);
    expect(() => decryptSecrets("biz-1", "conn-1", blob, { APP_ENCRYPTION_KEY: "x".repeat(40) })).toThrow(CredentialError);
  });
  test("no key, or a weak key: nothing can be stored or used (fail closed)", () => {
    expect(() => encryptSecrets("b", "c", { t: "x" }, {})).toThrow(CredentialError);
    expect(() => encryptSecrets("b", "c", { t: "x" }, { APP_ENCRYPTION_KEY: "short" })).toThrow(CredentialError);
  });
});

describe("connections", () => {
  async function biz(owner = "owner-a") {
    const t = tempStore();
    const { businessId } = await readyRestaurant(t.store, { ownerHash: owner });
    return { store: t.store, businessId };
  }

  test("create: secrets stored only encrypted, never in any view; generated secrets revealed once", async () => {
    const { businessId } = await biz();
    const { view, revealOnce } = await createConnection(businessId, { connector: "test_channel", label: "Shop chat", setup: { token: SECRET }, grants: [{ agent: "messaging", actions: ["test_channel.send"] }], routes: [{ event_type: "message.received", agent: "order" }] });
    expect(revealOnce).toEqual({ signing: "generated-signing-secret" });
    expect(view).toMatchObject({ connector: "test_channel", status: "active", reality: "simulated", hasSecrets: true, webhookPath: null });
    expect(JSON.stringify(view)).not.toContain(SECRET);
    expect(JSON.stringify(await listConnections(businessId))).not.toContain(SECRET);
    const raw = await discoveryRepository().readState(businessId, s => JSON.stringify(s.connections));
    expect(raw).not.toContain(SECRET);
    expect(raw).not.toContain("generated-signing-secret");
    expect((await loadConnectionForUse(businessId, view.id))!.secrets).toEqual({ token: SECRET, signing: "generated-signing-secret" });
    expect(view.id).toMatch(/^[A-Za-z0-9_-]{24}$/);
  });

  test("grants and routes are validated against the connector and the employee catalogue", async () => {
    const { businessId } = await biz();
    const base = { connector: "test_channel", label: "x", setup: { token: "t" } };
    await expect(createConnection(businessId, { ...base, grants: [{ agent: "finance", actions: ["test_channel.pay"] }] })).rejects.toBeInstanceOf(IntegrationError);
    await expect(createConnection(businessId, { ...base, grants: [{ agent: "intruder", actions: ["test_channel.send"] }] })).rejects.toBeInstanceOf(IntegrationError);
    await expect(createConnection(businessId, { ...base, routes: [{ event_type: "payment.requested", agent: "finance" }] })).rejects.toBeInstanceOf(IntegrationError);
    await expect(createConnection(businessId, { ...base, connector: "nope" })).rejects.toBeInstanceOf(IntegrationError);
    await expect(createConnection(businessId, { ...base, setup: {} })).rejects.toThrow(/token is required/);
  });

  test("disable and re-enable; a business can't exceed the connection limit", async () => {
    const { businessId } = await biz();
    const { view } = await createConnection(businessId, { connector: "test_channel", label: "a", setup: { token: "t" } });
    expect((await setConnectionStatus(businessId, view.id, "disabled")).status).toBe("disabled");
    expect((await setConnectionStatus(businessId, view.id, "active")).status).toBe("active");
    for (let i = 0; i < 9; i++) await createConnection(businessId, { connector: "test_channel", label: `c${i}`, setup: { token: "t" } });
    await expect(createConnection(businessId, { connector: "test_channel", label: "eleventh", setup: { token: "t" } })).rejects.toMatchObject({ code: "LIMIT_REACHED" });
  });

  test("routing index: a connection id leads to its business only; a tampered index pointer is refused", async () => {
    const kv = new MemoryKv();
    const store = new RedisStore(kv);
    setDiscoveryRepository(store);
    const a = await readyRestaurant(store, { ownerHash: "a" });
    const b = await readyRestaurant(store, { ownerHash: "b" });
    const { view } = await createConnection(a.businessId, { connector: "test_channel", label: "a", setup: { token: "t" } });
    expect(await store.businessIdForConnection(view.id)).toBe(a.businessId);
    expect(await store.businessIdForConnection("x".repeat(24))).toBeNull();
    await kv.set(storeKeys.connection(view.id), b.businessId);              // a poisoned index entry
    expect(await store.businessIdForConnection(view.id)).toBeNull();          // b doesn't hold it: refused
  });

  test("owner API: create returns the secret once; list never; another owner gets 404; no encryption key → 503", async () => {
    const t = tempStore();
    const owner = "o".repeat(43), other = "p".repeat(43);
    const { businessId } = await readyRestaurant(t.store, { ownerHash: hashOwnerToken(owner) });
    const req = (method: string, body?: unknown) => new Request("http://localhost:3101/x", { method, headers: { "content-type": "application/json", origin: "http://localhost:3101" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const ctx = { params: Promise.resolve({ id: businessId }) } as never;
    h.jar.set("eai_owner", owner);
    const created = await createRoute(req("POST", { connector: "test_channel", label: "Chat", setup: { token: SECRET } }), ctx);
    expect(created.status).toBe(201);
    const body = await created.json() as { connection: { id: string }; reveal_once: Record<string, string> };
    expect(body.reveal_once.signing).toBe("generated-signing-secret");
    expect(JSON.stringify(body)).not.toContain(SECRET);
    const listed = await (await listRoute(req("GET"), ctx)).text();
    expect(listed).not.toContain(SECRET);
    expect(listed).not.toContain("generated-signing-secret");
    h.jar.set("eai_owner", other);
    expect((await listRoute(req("GET"), ctx)).status).toBe(404);
    expect((await patchRoute(req("PATCH", { status: "disabled" }), { params: Promise.resolve({ id: businessId, connectionId: body.connection.id }) } as never)).status).toBe(404);
    h.jar.set("eai_owner", owner);
    vi.stubEnv("APP_ENCRYPTION_KEY", "");
    expect((await createRoute(req("POST", { connector: "test_channel", label: "Chat", setup: { token: SECRET } }), ctx)).status).toBe(503);
  });
});
