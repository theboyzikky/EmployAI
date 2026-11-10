import "server-only";
// The hosted demo's AI spending ledger: shared by every server instance, survives restarts. One Redis
// script does check-and-reserve atomically (src/lib/kv: spendReserve), so concurrent calls on separate
// instances can't together pass the daily cap or the call ceiling. Amounts are whole nano-USD;
// a worst case is rounded UP, so rounding can only make the cap stricter.
import type { Kv } from "@/lib/kv/types";
import type { ReserveResult, SpendStore } from "./spending";

const NANO = 1e9;
const KEEP_MS = 3 * 24 * 60 * 60 * 1000;   // a day's totals are kept 3 days, then expire

export class KvSpendStore implements SpendStore {
  constructor(private readonly kv: Kv, private readonly provider: string) {}
  private keys(day: string) {
    return { spentKey: `ai:${this.provider}:spent:${day}`, reservedKey: `ai:${this.provider}:reserved:${day}`, callsKey: `ai:${this.provider}:calls` };
  }
  reserve(o: { day: string; worstUsd: number; capUsd: number; maxCalls: number }): Promise<ReserveResult> {
    return this.kv.spendReserve({ ...this.keys(o.day), worstNano: Math.ceil(o.worstUsd * NANO), capNano: Math.floor(o.capUsd * NANO), maxCalls: o.maxCalls, ttlMs: KEEP_MS });
  }
  settle(o: { day: string; worstUsd: number; actualUsd: number }): Promise<void> {
    const { spentKey, reservedKey } = this.keys(o.day);
    return this.kv.spendSettle({ spentKey, reservedKey, worstNano: Math.ceil(o.worstUsd * NANO), actualNano: Math.ceil(o.actualUsd * NANO), ttlMs: KEEP_MS });
  }
  async snapshot(day: string) {
    const k = this.keys(day);
    const [spent, reserved, calls] = await this.kv.mget([k.spentKey, k.reservedKey, k.callsKey]);
    return { spentUsd: Number(spent ?? "0") / NANO, reservedUsd: Number(reserved ?? "0") / NANO, calls: Number(calls ?? "0") };
  }
}
