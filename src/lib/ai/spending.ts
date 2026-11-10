// Spending guard (ported from PoC-A0): hard daily USD cap + max-calls ceiling, enforced BEFORE each
// call using a worst case, then settled with real usage. Unknown billing counts as worst case.
//
// The check-and-reserve is ONE atomic step in the SpendStore: it refuses if the call ceiling is reached
// or if spent + already-reserved + this call's worst case would pass the cap; otherwise it counts the
// call and reserves the worst case. Settling releases the reservation and adds the real cost. So
// concurrent calls — in one process or across server instances sharing the store — can never together
// pass the cap. A reservation that is never settled (a crashed instance) stays counted at worst case
// until the day's key expires: conservative, never over budget.
//
// Stores: KvSpendStore (the hosted demo: shared, survives restarts, every instance), FileSpendStore
// (local development: persisted per machine) and MemorySpendStore (tests).
import { AiError } from "./errors";

export type Price = { prompt: number; completion: number }; // USD per token
export type Usage = { prompt_tokens: number; completion_tokens: number };
export type Reservation = { id: number; model: string; worstUsd: number; maxTokens: number; day: string; settled: boolean };
export type SpendSnapshot = { spentByDay: Record<string, number>; reservedByDay?: Record<string, number>; calls: number };
export type ReserveResult = "ok" | "BUDGET_CAP" | "CALL_LIMIT";

export interface SpendStore {
  /** Atomic: refuse, or count the call and reserve the worst case. */
  reserve(o: { day: string; worstUsd: number; capUsd: number; maxCalls: number }): Promise<ReserveResult>;
  /** Release the reservation and add the real cost. */
  settle(o: { day: string; worstUsd: number; actualUsd: number }): Promise<void>;
  snapshot(day: string): Promise<{ spentUsd: number; reservedUsd: number; calls: number }>;
}

/** A whole-snapshot store for ONE process (each operation is synchronous inside, so atomic there). */
export abstract class SnapshotSpendStore implements SpendStore {
  abstract load(): SpendSnapshot;
  abstract save(s: SpendSnapshot): void;
  async reserve(o: { day: string; worstUsd: number; capUsd: number; maxCalls: number }): Promise<ReserveResult> {
    const s = this.load();
    if (s.calls >= o.maxCalls) return "CALL_LIMIT";
    const spent = s.spentByDay[o.day] ?? 0, reserved = (s.reservedByDay ?? {})[o.day] ?? 0;
    if (spent + reserved + o.worstUsd > o.capUsd) return "BUDGET_CAP";
    s.calls++;
    (s.reservedByDay ??= {})[o.day] = reserved + o.worstUsd;
    this.save(s);
    return "ok";
  }
  async settle(o: { day: string; worstUsd: number; actualUsd: number }) {
    const s = this.load();
    (s.reservedByDay ??= {})[o.day] = Math.max(0, (s.reservedByDay[o.day] ?? 0) - o.worstUsd);
    s.spentByDay[o.day] = (s.spentByDay[o.day] ?? 0) + o.actualUsd;
    this.save(s);
  }
  async snapshot(day: string) {
    const s = this.load();
    return { spentUsd: s.spentByDay[day] ?? 0, reservedUsd: (s.reservedByDay ?? {})[day] ?? 0, calls: s.calls };
  }
}

/** In-memory store (tests, or when persistence is not wanted). */
export class MemorySpendStore extends SnapshotSpendStore {
  private s: SpendSnapshot = { spentByDay: {}, reservedByDay: {}, calls: 0 };
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
  private readonly preflight: (() => Promise<void>) | null;
  private seq = 0;
  readonly ledger: Array<{ reservation: number; model: string; usd: number; basis: "usage" | "worst_case"; inferenceId?: string }> = [];

  constructor(o: { provider: string; capUsdPerDay: number; maxCalls: number; prices: Record<string, Price>; today?: () => string; store?: SpendStore; preflight?: () => Promise<void> }) {
    if (!(o.capUsdPerDay > 0)) throw new AiError("CONFIG", o.provider, "Daily USD cap must be > 0");
    if (!Number.isInteger(o.maxCalls) || o.maxCalls < 1) throw new AiError("CONFIG", o.provider, "Max calls must be a positive integer");
    this.provider = o.provider; this.capUsdPerDay = o.capUsdPerDay; this.maxCalls = o.maxCalls; this.prices = o.prices;
    this.today = o.today ?? (() => new Date().toISOString().slice(0, 10));
    this.store = o.store ?? new MemorySpendStore();
    this.preflight = o.preflight ?? null;
  }

  price(model: string): Price {
    const p = this.prices[model];
    if (!p || !(p.prompt >= 0) || !(p.completion >= 0)) throw new AiError("PRICE_UNKNOWN", this.provider, `No catalogue price for ${model}; refusing to call`);
    return p;
  }
  async spentToday(): Promise<number> { return (await this.store.snapshot(this.today())).spentUsd; }
  async callsMade(): Promise<number> { return (await this.store.snapshot(this.today())).calls; }

  /** Must be called before every request. Throws if the worst case could breach a limit (or the ledger can't be reached). */
  async reserve(model: string, inputTokensUpper: number, maxTokens: number): Promise<Reservation> {
    if (this.preflight) await this.preflight();
    const p = this.price(model);
    const worstUsd = inputTokensUpper * p.prompt + maxTokens * p.completion;
    const day = this.today();
    let r: ReserveResult;
    try { r = await this.store.reserve({ day, worstUsd, capUsd: this.capUsdPerDay, maxCalls: this.maxCalls }); }
    catch { throw new AiError("CONFIG", this.provider, "The shared spending ledger couldn't be reached, so no AI call was made"); }   // fail closed
    if (r === "CALL_LIMIT") throw new AiError("CALL_LIMIT", this.provider, `Call limit ${this.maxCalls} reached`);
    if (r === "BUDGET_CAP") {
      const s = await this.store.snapshot(day).catch(() => null);
      throw new AiError("BUDGET_CAP", this.provider, `Daily cap $${this.capUsdPerDay} would be exceeded (spent $${(s?.spentUsd ?? 0).toFixed(6)}, in flight $${(s?.reservedUsd ?? 0).toFixed(6)}, next call worst case $${worstUsd.toFixed(6)})`);
    }
    return { id: ++this.seq, model, worstUsd, maxTokens, day, settled: false };
  }

  /** Settle with real usage. Missing or impossible usage → charge worst case and throw. */
  async settle(r: Reservation, usage: Usage | undefined, inferenceId?: string): Promise<number> {
    if (r.settled) throw new AiError("CONFIG", this.provider, "Reservation already settled");
    r.settled = true;
    if (!usage || typeof usage.prompt_tokens !== "number" || typeof usage.completion_tokens !== "number") {
      await this.add(r, r.worstUsd, "worst_case", inferenceId);
      throw new AiError("USAGE_MISSING", this.provider, "Response had no usage data; charged worst case and stopping");
    }
    const p = this.price(r.model);
    const usd = usage.prompt_tokens * p.prompt + usage.completion_tokens * p.completion;
    if (usage.completion_tokens > r.maxTokens) {
      await this.add(r, Math.max(usd, r.worstUsd), "usage", inferenceId);
      throw new AiError("USAGE_MISSING", this.provider, "Completion tokens exceeded max_tokens; spending cannot be capped reliably");
    }
    await this.add(r, usd, "usage", inferenceId);
    return usd;
  }

  /** A request failed without usage: we cannot know if it was billed, so count the worst case. */
  async fail(r: Reservation): Promise<void> { if (!r.settled) { r.settled = true; await this.add(r, r.worstUsd, "worst_case"); } }

  private async add(r: Reservation, usd: number, basis: "usage" | "worst_case", inferenceId?: string) {
    // If the ledger can't be written now, the reservation stays counted at worst case (conservative).
    await this.store.settle({ day: r.day, worstUsd: r.worstUsd, actualUsd: usd }).catch(() => undefined);
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
