// Spending guard (ported from PoC-A0): hard daily USD cap + max-calls ceiling, enforced BEFORE each
// call using a worst case, then settled with real usage. Unknown billing counts as worst case.
//
// M2 addition: totals can be persisted through a SpendStore so a server restart does not reset the
// cap. The file-based store is for LOCAL DEVELOPMENT ONLY: it is per machine and per process tree,
// not a production-grade, global spending enforcement (that needs the database: ledger_entries).
import { AiError } from "./errors";

export type Price = { prompt: number; completion: number }; // USD per token
export type Usage = { prompt_tokens: number; completion_tokens: number };
export type Reservation = { id: number; model: string; worstUsd: number; maxTokens: number; day: string; settled: boolean };
export type SpendSnapshot = { spentByDay: Record<string, number>; calls: number };

export interface SpendStore {
  load(): SpendSnapshot;
  save(s: SpendSnapshot): void;
}

/** In-memory store (tests, or when persistence is not wanted). */
export class MemorySpendStore implements SpendStore {
  private s: SpendSnapshot = { spentByDay: {}, calls: 0 };
  load() { return structuredClone(this.s); }
  save(s: SpendSnapshot) { this.s = structuredClone(s); }
}

export class SpendingGuard {
  private readonly provider: string;
  private readonly capUsdPerDay: number;
  private readonly maxCalls: number;
  private readonly prices: Record<string, Price>;
  private readonly today: () => string;
  private readonly store: SpendStore;
  private seq = 0;
  readonly ledger: Array<{ reservation: number; model: string; usd: number; basis: "usage" | "worst_case"; inferenceId?: string }> = [];

  constructor(o: { provider: string; capUsdPerDay: number; maxCalls: number; prices: Record<string, Price>; today?: () => string; store?: SpendStore }) {
    if (!(o.capUsdPerDay > 0)) throw new AiError("CONFIG", o.provider, "Daily USD cap must be > 0");
    if (!Number.isInteger(o.maxCalls) || o.maxCalls < 1) throw new AiError("CONFIG", o.provider, "Max calls must be a positive integer");
    this.provider = o.provider; this.capUsdPerDay = o.capUsdPerDay; this.maxCalls = o.maxCalls; this.prices = o.prices;
    this.today = o.today ?? (() => new Date().toISOString().slice(0, 10));
    this.store = o.store ?? new MemorySpendStore();
  }

  price(model: string): Price {
    const p = this.prices[model];
    if (!p || !(p.prompt >= 0) || !(p.completion >= 0)) throw new AiError("PRICE_UNKNOWN", this.provider, `No catalogue price for ${model}; refusing to call`);
    return p;
  }
  spentToday(): number { return this.store.load().spentByDay[this.today()] ?? 0; }
  callsMade(): number { return this.store.load().calls; }

  /** Must be called before every request. Throws if the worst case could breach a limit. */
  reserve(model: string, inputTokensUpper: number, maxTokens: number): Reservation {
    const p = this.price(model);
    const snap = this.store.load();
    if (snap.calls >= this.maxCalls) throw new AiError("CALL_LIMIT", this.provider, `Call limit ${this.maxCalls} reached`);
    const worstUsd = inputTokensUpper * p.prompt + maxTokens * p.completion;
    const day = this.today();
    const spent = snap.spentByDay[day] ?? 0;
    if (spent + worstUsd > this.capUsdPerDay)
      throw new AiError("BUDGET_CAP", this.provider, `Daily cap $${this.capUsdPerDay} would be exceeded (spent $${spent.toFixed(6)}, next call worst case $${worstUsd.toFixed(6)})`);
    snap.calls++;
    this.store.save(snap);
    return { id: ++this.seq, model, worstUsd, maxTokens, day, settled: false };
  }

  /** Settle with real usage. Missing or impossible usage → charge worst case and throw. */
  settle(r: Reservation, usage: Usage | undefined, inferenceId?: string): number {
    if (r.settled) throw new AiError("CONFIG", this.provider, "Reservation already settled");
    r.settled = true;
    if (!usage || typeof usage.prompt_tokens !== "number" || typeof usage.completion_tokens !== "number") {
      this.add(r, r.worstUsd, "worst_case", inferenceId);
      throw new AiError("USAGE_MISSING", this.provider, "Response had no usage data; charged worst case and stopping");
    }
    const p = this.price(r.model);
    const usd = usage.prompt_tokens * p.prompt + usage.completion_tokens * p.completion;
    if (usage.completion_tokens > r.maxTokens) {
      this.add(r, Math.max(usd, r.worstUsd), "usage", inferenceId);
      throw new AiError("USAGE_MISSING", this.provider, "Completion tokens exceeded max_tokens; spending cannot be capped reliably");
    }
    this.add(r, usd, "usage", inferenceId);
    return usd;
  }

  /** A request failed without usage: we cannot know if it was billed, so count the worst case. */
  fail(r: Reservation): void { if (!r.settled) { r.settled = true; this.add(r, r.worstUsd, "worst_case"); } }

  private add(r: Reservation, usd: number, basis: "usage" | "worst_case", inferenceId?: string) {
    const snap = this.store.load();
    snap.spentByDay[r.day] = (snap.spentByDay[r.day] ?? 0) + usd;
    this.store.save(snap);
    this.ledger.push({ reservation: r.id, model: r.model, usd, basis, inferenceId });
  }

  /** Compare provider-billed costs (NEAR AI /v1/billing/costs) with our estimates for this process. */
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
