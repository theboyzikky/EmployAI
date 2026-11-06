import "server-only";
import { readFileSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createProvider } from "./factory";
import type { AiProvider } from "./provider";
import type { SpendSnapshot, SpendStore } from "./spending";

/**
 * Spending totals persisted in .data/ai-spend.json so a dev-server restart doesn't reset the cap.
 * LOCAL DEVELOPMENT ONLY: per machine, not shared between servers, not a production-grade global
 * spending limit. Production enforcement uses `ledger_entries` (inference_cost) in the database.
 */
class FileSpendStore implements SpendStore {
  private readonly file = path.join(process.cwd(), ".data", "ai-spend.json");
  load(): SpendSnapshot {
    try { return JSON.parse(readFileSync(this.file, "utf8")) as SpendSnapshot; }
    catch { return { spentByDay: {}, calls: 0 }; }
  }
  save(s: SpendSnapshot) {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(s), "utf8");
    renameSync(tmp, this.file);
  }
}

let cached: Promise<AiProvider> | null = null;

/** Test hook: forget the cached provider so a test can change AI_PROVIDER. */
export function resetAiForTests() { cached = null; }

/** The configured provider. A failed initialisation is not cached, so a retry re-checks the config. */
export function getAi(): Promise<AiProvider> {
  if (!cached) {
    cached = createProvider(process.env, { spendStore: new FileSpendStore() });
    cached.catch(() => { cached = null; });
  }
  return cached;
}
