// Provider selection from environment. AI_PROVIDER must be set explicitly.
// There is deliberately NO fallback: if the selected provider is misconfigured or its
// catalogue check fails, createProvider() throws and the app shows "AI unavailable".
import { AiError, registerSecret } from './errors.ts';
import { MockProvider } from './providers/mock.ts';
import { OpenAICompatibleProvider } from './providers/openai-compatible.ts';
import { SpendingGuard, type Price } from './spending.ts';
import type { AiProvider, TaskName } from './provider.ts';

// From PoC-A (2026-11-05): Qwen for structured discovery, Haiku for tool calls.
export const NEAR_AI_DEFAULT_MODELS: Record<TaskName, string> = {
  discovery_turn: 'Qwen/Qwen3.8-27B',
  procurement_decision: 'anthropic/claude-haiku-5-5',
};
const NEAR_AI_EXTRA_BODY = { 'Qwen/Qwen3.8-27B': { chat_template_kwargs: { enable_thinking: false } } };

type Env = Record<string, string | undefined>;
const isLocal = (u: URL) => ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);

function url(name: string, v: string | undefined, provider: string, allowHttpLocal: boolean): string {
  if (!v) throw new AiError('CONFIG', provider, `${name} is required`);
  let u: URL; try { u = new URL(v); } catch { throw new AiError('CONFIG', provider, `${name} is not a valid URL`); }
  if (u.protocol !== 'https:' && !(allowHttpLocal && u.protocol === 'http:' && isLocal(u))) throw new AiError('CONFIG', provider, `${name} must use https`);
  return v.replace(/\/$/, '');
}
function posNumber(name: string, v: string | undefined, provider: string, integer = false): number {
  const n = Number(v);
  if (!v || !Number.isFinite(n) || n <= 0 || (integer && !Number.isInteger(n))) throw new AiError('CONFIG', provider, `${name} must be a positive ${integer ? 'integer' : 'number'}`);
  return n;
}

/** Fetch the public model catalogue and check the chosen models are listed with the needed features. */
async function loadPrices(baseURL: string, models: string[], provider: string, fetchImpl: typeof fetch): Promise<Record<string, Price>> {
  let res: Response;
  try { res = await fetchImpl(baseURL + '/models'); } catch { throw new AiError('NETWORK', provider, 'Model catalogue unreachable'); }
  if (!res.ok) throw new AiError('UPSTREAM', provider, `Model catalogue HTTP ${res.status}`, res.status);
  const j = await res.json() as { data: Array<{ id: string; pricing?: { prompt: string; completion: string }; supported_features?: string[]; is_ready?: boolean }> };
  const prices: Record<string, Price> = {};
  for (const m of models) {
    const e = j.data.find(x => x.id === m);
    if (!e) throw new AiError('CONFIG', provider, `Model ${m} is not in the catalogue`);
    if (e.is_ready === false) throw new AiError('CONFIG', provider, `Model ${m} reports is_ready=false`);
    prices[m] = { prompt: Number(e.pricing?.prompt), completion: Number(e.pricing?.completion) };
    if (!(prices[m].prompt >= 0 && prices[m].completion >= 0)) throw new AiError('PRICE_UNKNOWN', provider, `No price for ${m}`);
  }
  return prices;
}

export async function createProvider(env: Env, deps: { fetchImpl?: typeof fetch; allowHttpLocalhost?: boolean; today?: () => string } = {}): Promise<AiProvider> {
  const choice = env.AI_PROVIDER;
  const fetchImpl = deps.fetchImpl ?? fetch;
  switch (choice) {
    case 'mock':
      return new MockProvider();
    case 'nearai': {
      const p = 'nearai';
      if (env.NEAR_AI_CALLS_APPROVED !== 'true') throw new AiError('CONFIG', p, 'NEAR AI calls are not approved (NEAR_AI_CALLS_APPROVED must be "true")');
      const apiKey = env.NEAR_AI_API_KEY;
      if (!apiKey || !/^sk-/.test(apiKey)) throw new AiError('CONFIG', p, 'NEAR_AI_API_KEY missing or malformed');
      registerSecret(apiKey);
      const baseURL = url('NEAR_AI_BASE_URL', env.NEAR_AI_BASE_URL, p, !!deps.allowHttpLocalhost);
      const maxCalls = posNumber('NEAR_AI_MAX_CALLS', env.NEAR_AI_MAX_CALLS, p, true);
      const cap = posNumber('NEAR_AI_MAX_USD_PER_DAY', env.NEAR_AI_MAX_USD_PER_DAY, p);
      const modelFor = { discovery_turn: env.NEAR_AI_STRUCTURED_MODEL || NEAR_AI_DEFAULT_MODELS.discovery_turn, procurement_decision: env.NEAR_AI_TOOL_MODEL || NEAR_AI_DEFAULT_MODELS.procurement_decision };
      const prices = await loadPrices(baseURL, [...new Set(Object.values(modelFor))], p, fetchImpl);
      const guard = new SpendingGuard({ provider: p, capUsdPerDay: cap, maxCalls, prices, today: deps.today });
      return new OpenAICompatibleProvider({ name: 'nearai', baseURL, apiKey, modelFor, extraBody: NEAR_AI_EXTRA_BODY, guard, timeoutMs: Number(env.NEAR_AI_TIMEOUT_MS) || 60_000, fetchImpl });
    }
    case 'ollama': {
      const p = 'ollama';
      const baseURL = url('OLLAMA_BASE_URL', env.OLLAMA_BASE_URL, p, true);
      if (!isLocal(new URL(baseURL))) throw new AiError('CONFIG', p, 'OLLAMA_BASE_URL must point to this machine');
      const model = env.OLLAMA_MODEL; if (!model) throw new AiError('CONFIG', p, 'OLLAMA_MODEL is required (no model is downloaded automatically)');
      const guard = new SpendingGuard({ provider: p, capUsdPerDay: 1, maxCalls: Number(env.OLLAMA_MAX_CALLS) || 1000, prices: { [model]: { prompt: 0, completion: 0 } } });
      return new OpenAICompatibleProvider({ name: 'ollama', baseURL, apiKey: 'ollama-local', modelFor: { discovery_turn: model, procurement_decision: model }, guard, timeoutMs: Number(env.OLLAMA_TIMEOUT_MS) || 120_000, fetchImpl });
    }
    case undefined: case '':
      throw new AiError('CONFIG', 'none', 'AI_PROVIDER must be set explicitly to mock, nearai or ollama');
    default:
      throw new AiError('CONFIG', String(choice), `Unknown AI_PROVIDER "${choice}"`);
  }
}
