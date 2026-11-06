// Local stand-in for the documented NEAR AI Cloud API shapes (OpenAI-compatible). 127.0.0.1 only.
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

export type Scenario =
  | 'discovery_ok' | 'discovery_bad_json' | 'discovery_schema_mismatch' | 'length'
  | 'tool_ok' | 'tool_bad_args' | 'no_tool' | 'two_tools'
  | 'http_401' | 'http_402' | 'http_429' | 'http_500' | 'slow' | 'no_usage' | 'usage_over_max';

export const TEST_KEY = 'sk-test-0000000000000000000000';
export const CATALOGUE = {
  object: 'list',
  data: [
    { id: 'Qwen/Qwen3.8-27B', pricing: { prompt: '0.00000004', completion: '0.00000135' }, supported_features: ['tools', 'structured_outputs'], is_ready: true },
    { id: 'anthropic/claude-haiku-5-5', pricing: { prompt: '0.0000001', completion: '0.0000005' }, supported_features: ['tools', 'structured_outputs'] },
  ],
};

export async function startMockServer() {
  const state = { scenario: 'discovery_ok' as Scenario, chatCalls: 0, otherCalls: 0, authFailures: 0, lastBody: null as any, billed: new Map<string, number>(), billingMultiplier: 1, catalogueStatus: 200 };
  const prices: Record<string, { p: number; c: number }> = { 'Qwen/Qwen3.8-27B': { p: 4e-8, c: 1.35e-6 }, 'anthropic/claude-haiku-5-5': { p: 1e-7, c: 5e-7 } };
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
    if (req.method === 'GET' && req.url === '/v1/models') { state.otherCalls++; return state.catalogueStatus === 200 ? send(200, CATALOGUE) : send(state.catalogueStatus, { error: { message: 'down' } }); }
    if (req.headers.authorization !== `Bearer ${TEST_KEY}`) { state.authFailures++; return send(401, { error: { message: 'Invalid API key' } }); }
    if (req.url === '/v1/billing/costs') {
      state.otherCalls++;
      const ids: string[] = JSON.parse(raw).requestIds;
      return send(200, { requests: ids.map(id => ({ requestId: id, costNanoUsd: Math.round((state.billed.get(id) ?? 0) * 1e9 * state.billingMultiplier) })), warning: ids.some(id => !state.billed.has(id)) ? 'Some request IDs matched no usage record' : null });
    }
    if (req.url !== '/v1/chat/completions') return send(404, { error: { message: 'not found' } });
    state.chatCalls++;
    const body = JSON.parse(raw); state.lastBody = body;
    const s = state.scenario;
    if (s === 'http_401') return send(401, { error: { message: 'Invalid API key' } });
    if (s === 'http_402') return send(402, { error: { message: 'Insufficient credits or spend limit exceeded' } });
    if (s === 'http_429') return send(429, { error: { message: 'Rate limit exceeded' } });
    if (s === 'http_500') return send(500, { error: { message: 'Internal server error' } });
    if (s === 'slow') { await new Promise(r => setTimeout(r, 1500)); }
    const id = randomUUID(); const inferenceId = randomUUID();
    const usage = s === 'usage_over_max' ? { prompt_tokens: 100, completion_tokens: body.max_tokens + 50 } : { prompt_tokens: 150, completion_tokens: 120 };
    const pr = prices[body.model] ?? { p: 0, c: 0 };
    state.billed.set(inferenceId, usage.prompt_tokens * pr.p + usage.completion_tokens * pr.c);
    const discovery = { reply: 'How do customers place orders today?', facts: [{ field: 'business_type', value: 'restaurant / café', status: 'confirmed' }], unknowns: ['order_channels'], ready_for_summary: false };
    let message: any = { role: 'assistant', content: null }; let finish = 'stop';
    switch (s) {
      case 'discovery_ok': case 'slow': case 'no_usage': case 'usage_over_max': message.content = JSON.stringify(discovery); break;
      case 'discovery_bad_json': message.content = 'Sure! Here is the profile: {business_type: restaurant'; break;
      case 'discovery_schema_mismatch': message.content = JSON.stringify({ ...discovery, facts: [{ field: 'favourite_colour', value: 'blue', status: 'confirmed' }] }); break;
      case 'length': message.content = '{"reply":"How do cust'; finish = 'length'; break;
      case 'tool_ok': message.tool_calls = [{ id: 'c1', type: 'function', function: { name: 'propose_payment', arguments: JSON.stringify({ recipient: 'supplier-2.employai-demo.testnet', amount_near: 1.2, reason: 'cheapest approved' }) } }]; finish = 'tool_calls'; break;
      case 'tool_bad_args': message.tool_calls = [{ id: 'c1', type: 'function', function: { name: 'propose_payment', arguments: JSON.stringify({ recipient: 'supplier-2.employai-demo.testnet', amount_near: 'lots' }) } }]; finish = 'tool_calls'; break;
      case 'two_tools': message.tool_calls = [1, 2].map(i => ({ id: 'c' + i, type: 'function', function: { name: 'no_action', arguments: '{"reason":"x"}' } })); finish = 'tool_calls'; break;
      case 'no_tool': message.content = 'I would pay supplier 2.'; break;
    }
    const resp: any = { id, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: body.model, choices: [{ index: 0, message, finish_reason: finish }] };
    if (s !== 'no_usage') resp.usage = { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens };
    send(200, resp, { 'inference-id': inferenceId });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return { state, baseURL: `http://127.0.0.1:${port}/v1`, close: () => new Promise<void>(r => { server.closeAllConnections?.(); server.close(() => r()); }) };
}
