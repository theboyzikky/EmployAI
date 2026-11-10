// M0.1 · The integration core: the connector contract, the registry's shape checks, and the static guard
// that only allow-listed modules can reach the network (so runs, security, the workforce layer and the
// automation engine stay network-free and testable, like the chain layer).
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { actionSpec, connectorFor, registerConnector, unregisterConnectorForTests } from "@/lib/integrations/registry";
import type { Connector } from "@/lib/integrations/types";

const root = process.cwd();
const walk = (d: string): string[] => readdirSync(path.join(root, d)).flatMap(f => {
  const p = path.join(d, f);
  return statSync(path.join(root, p)).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(f) ? [p] : [];
});
const read = (p: string) => readFileSync(path.join(root, p), "utf8");
const norm = (p: string) => p.split(path.sep).join("/");

const fake = (over: Partial<Connector> = {}): Connector => ({
  key: "demo_tool", name: "Demo", kind: "developer", reality: "simulated", eventTypes: [],
  actions: { "demo_tool.do": { sideEffect: "write", idempotency: "none", parse: x => x as Record<string, unknown>, execute: async () => ({ kind: "done", ref: null }) } },
  setup: () => ({ config: {}, secrets: {}, revealOnce: {} }),
  ...over,
});

afterEach(() => { unregisterConnectorForTests("demo_tool"); });

describe("connector registry", () => {
  test("a well-formed connector registers and its actions resolve by name", () => {
    const c = fake();
    registerConnector(c);
    expect(connectorFor("demo_tool")).toBe(c);
    expect(actionSpec("demo_tool.do")?.connector).toBe(c);
    expect(actionSpec("demo_tool.nope")).toBeNull();
  });

  test("malformed connectors are refused: no reality label, foreign action names, unknown side effects", () => {
    expect(() => registerConnector(fake({ reality: undefined as never }))).toThrow(/reality/);
    expect(() => registerConnector(fake({ actions: { "other.do": fake().actions["demo_tool.do"] } }))).toThrow(/must be named/);
    expect(() => registerConnector(fake({ actions: { "demo_tool.pay": { ...fake().actions["demo_tool.do"], sideEffect: "money" as never } } }))).toThrow(/side effect/);
    expect(() => registerConnector(fake({ key: "Bad Key" }))).toThrow(/invalid/);
  });

  test("a second, different connector can't take an existing key; a duplicate module copy of the same one can", () => {
    registerConnector(fake());
    expect(() => registerConnector(fake())).not.toThrow();                       // same connector, another bundle copy
    expect(() => registerConnector(fake({ name: "Impostor", reality: "real" }))).toThrow(/already registered/);
  });
});

describe("network isolation (server code)", () => {
  // The ONLY server modules allowed to reach the network. Everything else (runs, security, workforce,
  // automation, inbox, actions, stores) goes through these, so it stays testable and auditable.
  const ALLOWED = [
    "src/lib/chain/rpc.ts",                          // NEAR RPC
    "src/lib/kv/upstash.ts",                         // shared store
    "src/lib/ai/factory.ts",                         // NEAR AI model catalogue (prices)
    "src/lib/ai/providers/openai-compatible.ts",     // NEAR AI completions
    "src/lib/automation/qstash.ts",                  // background queue (M0.5)
  ];
  const PROVIDERS = "src/lib/integrations/providers/";   // connector adapters: the integration layer's only network code

  test("only allow-listed modules and connector providers make network calls", () => {
    const server = walk("src/lib").map(norm);
    const calling = server.filter(f => /\bfetch\(|fetchImpl\(|https?\.request\(|new WebSocket\(|from "node:(net|tls|dgram)"/.test(read(f)));
    for (const f of calling) expect([f, ALLOWED.includes(f) || f.startsWith(PROVIDERS)]).toEqual([f, true]);
  });

  test("runs, security, workforce and automation code never import a connector provider directly (only the action port)", () => {
    const guarded = ["src/lib/runs", "src/lib/security", "src/lib/catalogue", "src/lib/workflows", "src/lib/discovery"].flatMap(walk).map(norm);
    for (const f of guarded) expect([f, /integrations\/providers\//.test(read(f))]).toEqual([f, false]);
  });

  test("client components never import the integration layer (secrets stay on the server)", () => {
    for (const f of walk("src/components").map(norm)) expect([f, /@\/lib\/integrations|@\/lib\/automation/.test(read(f))]).toEqual([f, false]);
  });
});
