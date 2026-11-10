// Live provider over an OpenAI-compatible API (NEAR AI Cloud, or an optional local Ollama).
// Ported from PoC-A0. Rules: no SDK retries, explicit timeout, spending guard before every call,
// strict schema validation, typed errors, and NO fallback to any other provider.
// This file must never import or reference the offline provider (a test checks the source).
import OpenAI from "openai";
import { z } from "zod";
import { AiError, redact, registerSecret } from "../errors";
import type { SpendingGuard } from "../spending";
import type { AiProvider, AiResult, ProviderName, StructuredRequest, TaskName } from "../provider";

export type LiveConfig = {
  name: Exclude<ProviderName, "mock">;
  baseURL: string;
  apiKey: string;
  modelFor: Record<TaskName, string>;
  extraBody?: Record<string, Record<string, unknown>>; // per model, e.g. Qwen chat_template_kwargs
  guard: SpendingGuard;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
};

/** JSON Schema for strict structured output (provider side). */
export const toJsonSchema = (s: z.ZodType) => z.toJSONSchema(s, { target: "draft-7" }) as Record<string, unknown>;
const inputUpper = (body: unknown) => Math.ceil(JSON.stringify(body).length / 2); // conservative (real ≈ chars/4)

type Completion = {
  choices?: Array<{ finish_reason?: string; message?: { content?: string | null } }>;
  usage?: { prompt_tokens: number; completion_tokens: number };
};

export class OpenAICompatibleProvider implements AiProvider {
  readonly name: Exclude<ProviderName, "mock">;
  private readonly cfg: LiveConfig;
  private readonly client: OpenAI;
  constructor(cfg: LiveConfig) {
    this.cfg = cfg; this.name = cfg.name;
    registerSecret(cfg.apiKey);
    // maxRetries: 0 — the SDK default (2) would turn one failure into up to three billed attempts.
    this.client = new OpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseURL, maxRetries: 0, timeout: cfg.timeoutMs, fetch: cfg.fetchImpl });
  }

  private mapError(e: unknown): AiError {
    if (e instanceof AiError) return e;
    const err = e as { status?: number; name?: string; message?: string };
    const msg = `${this.name}: ${err?.message ?? "request failed"}`;
    if (e instanceof OpenAI.APIConnectionTimeoutError || err?.name === "APIConnectionTimeoutError") return new AiError("TIMEOUT", this.name, msg);
    if (e instanceof OpenAI.APIConnectionError) return new AiError("NETWORK", this.name, msg);
    switch (err?.status) {
      case 401: return new AiError("AUTH", this.name, msg, 401);
      case 402: return new AiError("CREDITS_EXHAUSTED", this.name, msg, 402);
      case 429: return new AiError("RATE_LIMITED", this.name, msg, 429);
      default: return new AiError("UPSTREAM", this.name, msg, err?.status);
    }
  }

  async structured<T, C = unknown>(req: StructuredRequest<T, C>): Promise<AiResult<T>> {
    const model = this.cfg.modelFor[req.task];
    const body = {
      model,
      max_tokens: req.maxTokens,
      temperature: 0,
      messages: [{ role: "system", content: req.system }, { role: "user", content: req.user }],
      response_format: { type: "json_schema", json_schema: { name: req.task, strict: true, schema: toJsonSchema(req.schema) } },
      ...(this.cfg.extraBody?.[model] ?? {}),
    };
    const r = await this.cfg.guard.reserve(model, inputUpper(body), req.maxTokens); // BUDGET_CAP / CALL_LIMIT / PRICE_UNKNOWN / ledger unreachable
    let data: Completion, response: Response;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ({ data, response } = (await this.client.chat.completions.create(body as any).withResponse()) as unknown as { data: Completion; response: Response });
    } catch (e) { await this.cfg.guard.fail(r); throw this.mapError(e); }
    const inferenceId = response.headers.get("inference-id") ?? undefined;
    const costUsd = await this.cfg.guard.settle(r, data?.usage, inferenceId); // USAGE_MISSING
    const choice = data?.choices?.[0];
    if (choice?.finish_reason === "length") throw new AiError("TRUNCATED", this.name, `Output hit max_tokens (${req.maxTokens}) for ${req.task}`);
    let parsed: unknown;
    try { parsed = JSON.parse(choice?.message?.content ?? ""); }
    catch { throw new AiError("SCHEMA_INVALID", this.name, `Model output for ${req.task} is not valid JSON`); }
    const v = req.schema.safeParse(parsed);
    if (!v.success) throw new AiError("SCHEMA_INVALID", this.name, `Output for ${req.task} failed validation: ${v.error.issues.map(i => i.path.join(".") + " " + i.message).join("; ").slice(0, 300)}`);
    return {
      data: v.data, provider: this.name, model, mode: "live",
      usage: { input: data.usage!.prompt_tokens, output: data.usage!.completion_tokens }, costUsd, inferenceId,
    };
  }

  /** Reconcile billed costs (NEAR AI only). A non-inference endpoint; used during approved live checks. */
  async billedCosts(ids: string[]) {
    const f = this.cfg.fetchImpl ?? fetch;
    const r = await f(this.cfg.baseURL.replace(/\/$/, "") + "/billing/costs", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.cfg.apiKey}` }, body: JSON.stringify({ requestIds: ids }),
    });
    if (!r.ok) throw new AiError("UPSTREAM", this.name, `billing/costs HTTP ${r.status}`, r.status);
    const j = await r.json() as { requests: Array<{ requestId: string; costNanoUsd: number }>; warning?: string | null };
    return { ...this.cfg.guard.reconcile(j.requests), warning: j.warning ? redact(j.warning) : null };
  }
}
