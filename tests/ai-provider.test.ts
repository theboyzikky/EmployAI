// AI provider layer. NEVER calls NEAR AI: config-refusal tests prove no request is made, and adapter tests
// point the real openai SDK at a local HTTP server on 127.0.0.1 that returns NEAR AI's response shapes.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { z } from "zod";
import { AiError } from "@/lib/ai/errors";
import { configuredProvider, createProvider } from "@/lib/ai/factory";
import { MemorySpendStore, SpendingGuard } from "@/lib/ai/spending";
import { blockedFetch } from "./setup";

const realFetch = (globalThis as unknown as { __realFetch: typeof fetch }).__realFetch;
const KEY = "sk-test-0123456789abcdef";
const Schema = z.object({ ok: z.boolean(), note: z.string() }).strict();

// ---- local fake NEAR AI server --------------------------------------------------------------
type Reply = (req: IncomingMessage, res: ServerResponse) => void;
let server: Server; let base = ""; let reply: Reply; let chatCalls = 0;
const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => { res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(body)); };
const completion = (content: string, usage: unknown = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }, finish = "stop") =>
  ({ id: "c1", object: "chat.completion", created: 1, model: "Qwen/Qwen3.8-27B", choices: [{ index: 0, finish_reason: finish, message: { role: "assistant", content } }], usage });

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url?.endsWith("/models")) return json(res, 200, { data: [{ id: "Qwen/Qwen3.8-27B", is_ready: true, pricing: { prompt: "0.00000004", completion: "0.00000135" } }] });
    if (req.url?.endsWith("/chat/completions")) { chatCalls++; return reply(req, res); }
    json(res, 404, {});
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
afterAll(() => new Promise<void>(r => server.close(() => r())));

const env = (extra: Record<string, string> = {}) => ({ AI_PROVIDER: "nearai", NEAR_AI_CALLS_APPROVED: "true", NEAR_AI_API_KEY: KEY, NEAR_AI_BASE_URL: base, NEAR_AI_MAX_CALLS: "50", NEAR_AI_MAX_USD_PER_DAY: "0.05", NEAR_AI_TIMEOUT_MS: "2000", ...extra });
const live = (extra: Record<string, string> = {}, store = new MemorySpendStore()) => createProvider(env(extra), { fetchImpl: realFetch, allowHttpLocalhost: true, spendStore: store });
const ask = (p: Awaited<ReturnType<typeof live>>) => p.structured({ task: "discovery_turn", schema: Schema, system: "s", user: "u", context: {}, maxTokens: 200 });

describe("provider selection: explicit, approved, no fallback", () => {
  test("AI_PROVIDER has no default", async () => {
    await expect(createProvider({})).rejects.toMatchObject({ code: "CONFIG" });
    await expect(createProvider({ AI_PROVIDER: "openai" })).rejects.toMatchObject({ code: "CONFIG" });
    expect(configuredProvider({}).problem).toMatch(/not set/);
  });

  test("nearai is refused before any network access unless approved, keyed and capped", async () => {
    await expect(createProvider({ ...env(), NEAR_AI_CALLS_APPROVED: "" })).rejects.toMatchObject({ code: "CONFIG" });
    await expect(createProvider({ ...env(), NEAR_AI_MAX_USD_PER_DAY: "" })).rejects.toMatchObject({ code: "CONFIG" });
    await expect(createProvider({ ...env(), NEAR_AI_MAX_CALLS: "0" })).rejects.toMatchObject({ code: "CONFIG" });
    await expect(createProvider({ ...env(), NEAR_AI_API_KEY: "not-a-key" })).rejects.toMatchObject({ code: "CONFIG" });
    await expect(createProvider({ ...env(), NEAR_AI_BASE_URL: "http://cloud-api.near.ai/v1" })).rejects.toMatchObject({ code: "CONFIG" }); // https only
    expect(blockedFetch).not.toHaveBeenCalled();
  });

  test("mock is used only when explicitly selected, and is labelled offline", async () => {
    const p = await createProvider({ AI_PROVIDER: "mock" });
    expect(p.name).toBe("mock");
    expect(configuredProvider({ AI_PROVIDER: "mock" }).label).toBe("Offline demo AI (rule-based)");
  });

  test("source check: the live adapter never references the offline provider", () => {
    const src = readFileSync("src/lib/ai/providers/openai-compatible.ts", "utf8");
    expect(src).not.toMatch(/from\s+["'].*mock["']|MockProvider|offlineDiscoveryTurn|offlineAnalysis/);
    expect(src).toMatch(/maxRetries:\s*0/);
  });
});

describe("live adapter against a local fake server", () => {
  test("valid structured output is parsed, costed and labelled live", async () => {
    reply = (_q, res) => json(res, 200, completion(JSON.stringify({ ok: true, note: "fine" })), { "inference-id": "inf-1" });
    const r = await ask(await live());
    expect(r).toMatchObject({ data: { ok: true, note: "fine" }, provider: "nearai", mode: "live", inferenceId: "inf-1" });
    expect(r.costUsd).toBeCloseTo(100 * 0.00000004 + 20 * 0.00000135, 12);
  });

  test("failures are typed errors with exactly ONE request each (no SDK retries), never a mock answer", async () => {
    const p = await live();
    const cases: Array<[Reply, string]> = [
      [(_q, res) => json(res, 500, { error: { message: "boom" } }), "UPSTREAM"],
      [(_q, res) => json(res, 429, { error: { message: "slow down" } }), "RATE_LIMITED"],
      [(_q, res) => json(res, 402, { error: { message: "no credit" } }), "CREDITS_EXHAUSTED"],
      [(_q, res) => json(res, 200, completion("not json")), "SCHEMA_INVALID"],
      [(_q, res) => json(res, 200, completion(JSON.stringify({ ok: "yes" }))), "SCHEMA_INVALID"],
      [(_q, res) => json(res, 200, completion("{\"ok\":tr", undefined, "length")), "TRUNCATED"],
      [(_q, res) => json(res, 200, completion(JSON.stringify({ ok: true, note: "x" }), null)), "USAGE_MISSING"],
    ];
    for (const [r, code] of cases) {
      reply = r; const before = chatCalls;
      const err = await ask(p).catch(e => e);
      expect(err).toBeInstanceOf(AiError);
      expect(err.code).toBe(code);
      expect(chatCalls - before).toBe(1);
      expect(String(err.message)).not.toContain(KEY);
    }
  });

  test("timeout is a typed error after one attempt", async () => {
    reply = () => { /* never answers */ };
    const before = chatCalls;
    const err = await ask(await live({ NEAR_AI_TIMEOUT_MS: "300" })).catch(e => e);
    expect(err.code).toBe("TIMEOUT");
    expect(chatCalls - before).toBe(1);
  });
});

describe("spending safeguards", () => {
  test("the daily cap is checked BEFORE the request and survives a restart (persisted store)", async () => {
    reply = (_q, res) => json(res, 200, completion(JSON.stringify({ ok: true, note: "n" })));
    const store = new MemorySpendStore();
    store.save({ spentByDay: { [new Date().toISOString().slice(0, 10)]: 0.04999 }, calls: 3 }); // spent earlier "before a restart"
    const before = chatCalls;
    const err = await ask(await live({}, store)).catch(e => e);
    expect(err.code).toBe("BUDGET_CAP");
    expect(chatCalls - before).toBe(0);
  });

  test("the call ceiling holds across instances sharing the store", async () => {
    const store = new MemorySpendStore();
    const mk = () => new SpendingGuard({ provider: "t", capUsdPerDay: 1, maxCalls: 2, prices: { m: { prompt: 0, completion: 0 } }, store });
    await mk().reserve("m", 1, 1); await mk().reserve("m", 1, 1);
    await expect(mk().reserve("m", 1, 1)).rejects.toThrow(/Call limit/);
  });

  test("a failed request is charged at worst case", async () => {
    const store = new MemorySpendStore();
    const g = new SpendingGuard({ provider: "t", capUsdPerDay: 1, maxCalls: 9, prices: { m: { prompt: 0.001, completion: 0.002 } }, store });
    await g.fail(await g.reserve("m", 100, 50));
    expect(await g.spentToday()).toBeCloseTo(100 * 0.001 + 50 * 0.002, 9);
  });
});
