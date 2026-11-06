// Spending guard: hard daily USD cap + max-calls ceiling, enforced BEFORE each call
// using a worst case, then settled with real usage. Unknown billing counts as worst case.
import { AiError } from './errors.ts';

export type Price = { prompt: number; completion: number }; // USD per token
export type Usage = { prompt_tokens: number; completion_tokens: number };
export type Reservation = { id: number; model: string; worstUsd: number; maxTokens: number; day: string; settled: boolean };

export class SpendingGuard {
  private readonly provider: string;
  private readonly capUsdPerDay: number;
  private readonly maxCalls: number;
  private readonly prices: Record<string, Price>;
  private readonly today: () => string;
  private spent = new Map<string, number>(); // day → USD (actual + worst for unknown)
  private calls = 0;
  private seq = 0;
  readonly ledger: Array<{ reservation: number; model: string; usd: number; basis: 'usage' | 'worst_case'; inferenceId?: string }> = [];

  constructor(o: { provider: string; capUsdPerDay: number; maxCalls: number; prices: Record<string, Price>; today?: () => string }) {
    if (!(o.capUsdPerDay > 0)) throw new AiError('CONFIG', o.provider, 'Daily USD cap must be > 0');
    if (!Number.isInteger(o.maxCalls) || o.maxCalls < 1) throw new AiError('CONFIG', o.provider, 'Max calls must be a positive integer');
    this.provider = o.provider; this.capUsdPerDay = o.capUsdPerDay; this.maxCalls = o.maxCalls; this.prices = o.prices;
    this.today = o.today ?? (() => new Date().toISOString().slice(0, 10));
  }

  price(model: string): Price {
    const p = this.prices[model];
    if (!p || !(p.prompt >= 0) || !(p.completion >= 0)) throw new AiError('PRICE_UNKNOWN', this.provider, `No catalogue price for ${model}; refusing to call`);
    return p;
  }
  spentToday(): number { return this.spent.get(this.today()) ?? 0; }
  callsMade(): number { return this.calls; }

  /** Must be called before every request. Throws if the worst case could breach a limit. */
  reserve(model: string, inputTokensUpper: number, maxTokens: number): Reservation {
    const p = this.price(model);
    if (this.calls >= this.maxCalls) throw new AiError('CALL_LIMIT', this.provider, `Call limit ${this.maxCalls} reached`);
    const worstUsd = inputTokensUpper * p.prompt + maxTokens * p.completion;
    const day = this.today();
    if (this.spentToday() + worstUsd > this.capUsdPerDay)
      throw new AiError('BUDGET_CAP', this.provider, `Daily cap $${this.capUsdPerDay} would be exceeded (spent $${this.spentToday().toFixed(6)}, next call worst case $${worstUsd.toFixed(6)})`);
    this.calls++;
    return { id: ++this.seq, model, worstUsd, maxTokens, day, settled: false };
  }

  /** Settle with real usage. Missing or impossible usage → charge worst case and throw. */
  settle(r: Reservation, usage: Usage | undefined, inferenceId?: string): number {
    if (r.settled) throw new AiError('CONFIG', this.provider, 'Reservation already settled');
    r.settled = true;
    if (!usage || typeof usage.prompt_tokens !== 'number' || typeof usage.completion_tokens !== 'number') {
      this.add(r, r.worstUsd, 'worst_case', inferenceId);
      throw new AiError('USAGE_MISSING', this.provider, 'Response had no usage data; charged worst case and stopping');
    }
    const p = this.price(r.model);
    const usd = usage.prompt_tokens * p.prompt + usage.completion_tokens * p.completion;
    if (usage.completion_tokens > r.maxTokens) {
      this.add(r, Math.max(usd, r.worstUsd), 'usage', inferenceId);
      throw new AiError('USAGE_MISSING', this.provider, 'Completion tokens exceeded max_tokens; spending cannot be capped reliably');
    }
    this.add(r, usd, 'usage', inferenceId);
    return usd;
  }

  /** A request failed without usage: we cannot know if it was billed, so count the worst case. */
  fail(r: Reservation): void { if (!r.settled) { r.settled = true; this.add(r, r.worstUsd, 'worst_case'); } }

  private add(r: Reservation, usd: number, basis: 'usage' | 'worst_case', inferenceId?: string) {
    this.spent.set(r.day, (this.spent.get(r.day) ?? 0) + usd);
    this.ledger.push({ reservation: r.id, model: r.model, usd, basis, inferenceId });
  }

  /** Compare provider-billed costs with our estimates. */
  reconcile(billed: Array<{ requestId: string; costNanoUsd: number }>, tolerance = 0.5) {
    const est = new Map(this.ledger.filter(l => l.inferenceId).map(l => [l.inferenceId!, l.usd]));
    const rows = billed.map(b => {
      const e = est.get(b.requestId); const usd = b.costNanoUsd / 1e9;
      const ok = e !== undefined && (e === 0 ? usd === 0 : Math.abs(usd - e) / e <= tolerance);
      return { requestId: b.requestId, estimatedUsd: e ?? null, billedUsd: usd, withinTolerance: ok };
    });
    const unmatched = [...est.keys()].filter(id => !billed.some(b => b.requestId === id));
    return { rows, unmatched, billedTotalUsd: rows.reduce((s, r) => s + r.billedUsd, 0), allWithinTolerance: rows.every(r => r.withinTolerance) && unmatched.length === 0 };
  }
}
