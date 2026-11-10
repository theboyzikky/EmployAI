// M0.3 · Inbound events through the REAL generic signed-webhook connector and the public hook route.
// Runs on both stores. No network (requests are built in-process; nothing is fetched).
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { POST as hook } from "@/app/api/hooks/[connectionId]/route";
import { discoveryRepository, setDiscoveryRepository } from "@/lib/discovery/store";
import { createConnection, setConnectionStatus } from "@/lib/integrations/connections";
import { isPublicAddress, sign, webhookConnector } from "@/lib/integrations/providers/webhook";
import { getKv, MemoryKv, setKvForTests } from "@/lib/kv";
import { KvUnavailableError } from "@/lib/kv/types";
import { readyRestaurant, tempStore } from "./helpers/run-fixture";
import { sharedMode } from "./helpers/store";

beforeEach(() => { vi.stubEnv("APP_ENCRYPTION_KEY", "e".repeat(40)); if (!sharedMode) setKvForTests(new MemoryKv()); });
afterEach(() => { vi.unstubAllEnvs(); setDiscoveryRepository(null); setKvForTests(null); });

async function setup(routes = [{ event_type: "order.created", agent: "order" }]) {
  const t = tempStore();
  const { businessId } = await readyRestaurant(t.store);
  const { view, revealOnce } = await createConnection(businessId, { connector: "webhook", label: "POS", setup: {}, routes });
  return { businessId, id: view.id, secret: revealOnce.inbound_secret };
}
const post = (id: string, secret: string, body: unknown, o: { ts?: number; tamper?: boolean; sig?: string } = {}) => {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const ts = String(o.ts ?? Math.floor(Date.now() / 1000));
  const signature = o.sig ?? sign(secret, ts, raw);
  return hook(new Request(`https://demo.example/api/hooks/${id}`, { method: "POST", headers: { "content-type": "application/json", "x-employai-timestamp": ts, "x-employai-signature": signature }, body: o.tamper ? raw.replace("2", "9") : raw }), { params: Promise.resolve({ connectionId: id }) } as never);
};
const events = (b: string) => discoveryRepository().readState(b, s => (s.inbound_events ?? {})[b] ?? []);
const ORDER = { id: "evt_1001", type: "order.created", subject: "customer-42", data: { items: [{ item: "Jollof Rice", qty: 2 }] } };

describe("inbound webhooks", () => {
  test("a correctly signed event is stored once, as untrusted, and routed to the employee the owner chose", async () => {
    const { businessId, id, secret } = await setup();
    const r = await post(id, secret, ORDER);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ received: 1, duplicates: 0 });
    const [ev] = await events(businessId);
    expect(ev).toMatchObject({ connector: "webhook", external_id: "evt_1001", type: "order.created", subject: "customer-42", provenance: "untrusted", status: "routed", routed_to: "order" });
    // A provider retry of the same event is recognised.
    const again = await post(id, secret, ORDER);
    expect(await again.json()).toMatchObject({ received: 0, duplicates: 1 });
    expect(await events(businessId)).toHaveLength(1);
  });

  test("an event type nobody is assigned to is kept and flagged for the owner (never silently dropped)", async () => {
    const { businessId, id, secret } = await setup([]);
    await post(id, secret, { ...ORDER, id: "evt_2" });
    expect((await events(businessId))[0]).toMatchObject({ status: "unrouted", routed_to: null });
    expect(await discoveryRepository().readState(businessId, s => (s.activity_events ?? {})[businessId]!.some(e => e.type === "event.unrouted"))).toBe(true);
  });

  test("refused, with nothing stored: bad signature, stale timestamp, tampered body, invalid JSON, unknown type, oversized", async () => {
    const { businessId, id, secret } = await setup();
    expect((await post(id, secret, ORDER, { sig: "v1=" + "0".repeat(64) })).status).toBe(401);
    expect((await post(id, "wrong-secret", ORDER)).status).toBe(401);
    expect((await post(id, secret, ORDER, { ts: Math.floor(Date.now() / 1000) - 3600 })).status).toBe(401);
    expect((await post(id, secret, ORDER, { tamper: true })).status).toBe(401);
    expect((await post(id, secret, "{not json")).status).toBe(400);
    expect((await post(id, secret, { ...ORDER, type: "payment.send" })).status).toBe(400);
    expect((await post(id, secret, { ...ORDER, data: { blob: "x".repeat(70_000) } })).status).toBe(413);
    expect(await events(businessId)).toHaveLength(0);
  });

  test("unknown and disabled connections look the same (404, no enumeration)", async () => {
    const { businessId, id, secret } = await setup();
    expect((await post("A".repeat(24), secret, ORDER)).status).toBe(404);
    expect((await post("not-an-id", secret, ORDER)).status).toBe(404);
    await setConnectionStatus(businessId, id, "disabled");
    expect((await post(id, secret, ORDER)).status).toBe(404);
    expect(await events(businessId)).toHaveLength(0);
  });

  test("the shared store unreachable → 503 (the provider retries; nothing is lost or half-stored)", async () => {
    const { businessId, id, secret } = await setup();
    const kv = getKv() as MemoryKv;
    kv.failWith = new KvUnavailableError("down");
    expect((await post(id, secret, ORDER)).status).toBe(503);
    kv.failWith = null;
    expect((await post(id, secret, ORDER)).status).toBe(200);
    expect(await events(businessId)).toHaveLength(1);
  });

  test("a connection sending too much is slowed down (429), per connection", async () => {
    vi.stubEnv("EMPLOYAI_LIMIT_HOOK_PER_CONNECTION_MIN", "3");
    const { id, secret } = await setup();
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await post(id, secret, { ...ORDER, id: `evt_r${i}` })).status);
    expect(codes).toEqual([200, 200, 200, 429]);
  });
});

describe("generic webhook delivery target checks (SSRF)", () => {
  test("only public https targets are accepted at setup; private address ranges are recognised", () => {
    expect(() => webhookConnector.setup({ target_url: "http://example.com/hook" })).toThrow(/https/);
    expect(() => webhookConnector.setup({ target_url: "https://localhost/hook" })).toThrow(/public/);
    expect(() => webhookConnector.setup({ target_url: "https://10.0.0.5/hook" })).toThrow(/public/);
    expect(() => webhookConnector.setup({ target_url: "https://user:pw@example.com/hook" })).toThrow(/credentials/);
    expect((webhookConnector.setup({ target_url: "https://hooks.example.com/in" }) as { config: Record<string, unknown> }).config.target_url).toBe("https://hooks.example.com/in");
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"]) expect([ip, isPublicAddress(ip)]).toEqual([ip, false]);
    for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) expect([ip, isPublicAddress(ip)]).toEqual([ip, true]);
  });
});
