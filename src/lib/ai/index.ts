import "server-only";
import { readFileSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { getKv, isSharedStore } from "@/lib/kv";
import { opsFlag } from "@/lib/hosted/ops-flags";
import { AiError } from "./errors";
import { KvSpendStore } from "./kv-spend-store";
import path from "node:path";
import { dataDir } from "@/lib/data-dir";
import { createProvider } from "./factory";
import type { AiProvider } from "./provider";
import { SnapshotSpendStore, type SpendSnapshot, type SpendStore } from "./spending";

/**
 * Spending totals persisted in .data/ai-spend.json so a dev-server restart doesn't reset the cap.
 * LOCAL DEVELOPMENT ONLY: per machine and process. The hosted demo uses KvSpendStore (shared by every
 * instance, survives restarts).
 */
class FileSpendStore extends SnapshotSpendStore {
  private readonly file = path.join(dataDir(), "ai-spend.json");
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
    const shared = isSharedStore();
    const spendStore: SpendStore = shared ? new KvSpendStore(getKv(), "nearai") : new FileSpendStore();
    // Hosted: an operator can pause live AI from the shared store (ops:ai_paused), without a redeploy.
    const preflight = shared ? async () => { if (await opsFlag("ai_paused").catch(() => true)) throw new AiError("CONFIG", "nearai", "Live AI is paused on this demo right now"); } : undefined;
    cached = createProvider(process.env, { spendStore, preflight });
    cached.catch(() => { cached = null; });
  }
  return cached;
}
