// Live provider over an OpenAI-compatible API (NEAR AI Cloud, or optional local Ollama).
// Rules: no SDK retries, explicit timeout, spending guard before every call, strict validation,
// typed errors, and NO fallback to any other provider. This file must never import the mock provider.
import OpenAI from 'openai';
import { AiError, redact, registerSecret } from '../errors.ts';
import { toJsonSchema } from '../schemas.ts';
import { SpendingGuard } from '../spending.ts';
import type { AiProvider, AiResult, ProviderName, TaskName, ToolDef } from '../provider.ts';
import type { z } from 'zod';

export type LiveConfig = {
  name: Exclude<ProviderName, 'mock'>;
  baseURL: string;
  apiKey: string;
  modelFor: Record<TaskName, string>;
  extraBody?: Record<string, Record<string, unknown>>; // per model, e.g. Qwen chat_template_kwargs
  guard: SpendingGuard;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
};

const inputUpper = (body: unknown) => Math.ceil(JSON.stringify(body).length / 2); // conservative (real ≈ chars/4)

export class OpenAICompatibleProvider implements AiProvider {
  readonly name: Exclude<ProviderName, 'mock'>;
  private readonly cfg: LiveConfig;
  private readonly client: OpenAI;
  constructor(cfg: LiveConfig) {
    this.cfg = cfg; this.name = cfg.name;
    registerSecret(cfg.apiKey);
    this.client = new OpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseURL, maxRetries: 0, timeout: cfg.timeoutMs, fetch: cfg.fetchImpl });
  }

  private mapError(e: unknown): AiError {
    if (e instanceof AiError) return e;
    const err = e as { status?: number; name?: string; message?: string };
    const msg = `${this.name}: ${err?.message ?? 'request failed'}`;
    if (e instanceof OpenAI.APIConnectionTimeoutError || err?.name === 'APIConnectionTimeoutError') return new AiError('TIMEOUT', this.name, msg);
    if (e instanceof OpenAI.APIConnectionError) return new AiError('NETWORK', this.name, msg);
    switch (err?.status) {
      case 401: return new AiError('AUTH', this.name, msg, 401);
      case 402: return new AiError('CREDITS_EXHAUSTED', this.name, msg, 402);
      case 429: return new AiError('RATE_LIMITED', this.name, msg, 429);
      default: return new AiError('UPSTREAM', this.name, msg, err?.status);
    }
  }

  private async complete(task: TaskName, body: Record<string, unknown>, maxTokens: number) {
    const model = this.cfg.modelFor[task];
    const full = { model, max_tokens: maxTokens, temperature: 0, ...body, ...(this.cfg.extraBody?.[model] ?? {}) };
    const r = this.cfg.guard.reserve(model, inputUpper(full), maxTokens);   // throws BUDGET_CAP / CALL_LIMIT / PRICE_UNKNOWN
    let data: any, response: Response;
    try {
      ({ data, response } = await this.client.chat.completions.create(full as any).withResponse());
    } catch (e) { this.cfg.guard.fail(r); throw this.mapError(e); }
    const inferenceId = response.headers.get('inference-id') ?? undefined;
    const costUsd = this.cfg.guard.settle(r, data?.usage, inferenceId);   // throws USAGE_MISSING
    const choice = data?.choices?.[0];
    if (choice?.finish_reason === 'length') throw new AiError('TRUNCATED', this.name, `Output hit max_tokens (${maxTokens}) for ${task}`);
    return { model, choice, costUsd, inferenceId, usage: { input: data.usage.prompt_tokens, output: data.usage.completion_tokens } };
  }

  async structured<T>(req: { task: TaskName; schema: z.ZodType<T>; system: string; user: string; maxTokens: number }): Promise<AiResult<T>> {
    const res = await this.complete(req.task, {
      messages: [{ role: 'system', content: req.system }, { role: 'user', content: req.user }],
      response_format: { type: 'json_schema', json_schema: { name: req.task, strict: true, schema: toJsonSchema(req.schema) } },
    }, req.maxTokens);
    let parsed: unknown;
    try { parsed = JSON.parse(res.choice?.message?.content ?? ''); }
    catch { throw new AiError('SCHEMA_INVALID', this.name, `Model output for ${req.task} is not valid JSON`); }
    const v = req.schema.safeParse(parsed);
    if (!v.success) throw new AiError('SCHEMA_INVALID', this.name, `Output for ${req.task} failed validation: ${v.error.issues.map(i => i.path.join('.') + ' ' + i.message).join('; ').slice(0, 300)}`);
    return { data: v.data, provider: this.name, model: res.model, mode: 'live', usage: res.usage, costUsd: res.costUsd, inferenceId: res.inferenceId };
  }

  async toolCall(req: { task: TaskName; system: string; user: string; tools: readonly ToolDef[]; maxTokens: number }) {
    const res = await this.complete(req.task, {
      messages: [{ role: 'system', content: req.system }, { role: 'user', content: req.user }],
      tools: req.tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: toJsonSchema(t.schema) } })),
      tool_choice: 'required',
    }, req.maxTokens);
    const calls = res.choice?.message?.tool_calls ?? [];
    if (calls.length !== 1) throw new AiError('NO_TOOL_CALL', this.name, `Expected exactly 1 tool call, got ${calls.length}`);
    const tool = req.tools.find(t => t.name === calls[0].function?.name);
    if (!tool) throw new AiError('NO_TOOL_CALL', this.name, `Model called an unknown tool`);
    let args: unknown;
    try { args = JSON.parse(calls[0].function.arguments); } catch { throw new AiError('NO_TOOL_CALL', this.name, 'Tool arguments are not valid JSON'); }
    const v = tool.schema.safeParse(args);
    if (!v.success) throw new AiError('NO_TOOL_CALL', this.name, `Tool arguments failed validation`);
    return { data: { name: tool.name, args: v.data }, provider: this.name, model: res.model, mode: 'live' as const, usage: res.usage, costUsd: res.costUsd, inferenceId: res.inferenceId };
  }

  /** Reconcile billed costs (NEAR AI only). Non-inference endpoint. */
  async billedCosts(ids: string[]) {
    const f = this.cfg.fetchImpl ?? fetch;
    const r = await f(this.cfg.baseURL.replace(/\/$/, '') + '/billing/costs', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.cfg.apiKey}` }, body: JSON.stringify({ requestIds: ids }),
    });
    if (!r.ok) throw new AiError('UPSTREAM', this.name, `billing/costs HTTP ${r.status}`, r.status);
    const j = await r.json() as { requests: Array<{ requestId: string; costNanoUsd: number }>; warning?: string | null };
    return { ...this.cfg.guard.reconcile(j.requests), warning: j.warning ? redact(j.warning) : null };
  }
}
