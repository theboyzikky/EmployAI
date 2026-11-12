// The store the tests run against. Default: the local file store. With EMPLOYAI_TEST_STORE=shared
// (npm run test:shared), the SAME suites run against the hosted demo's shared store (RedisStore over
// MemoryKv, with an async pause on every operation so concurrent calls interleave like separate server
// instances sharing one Redis).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { FileDevStore, type DiscoveryRepository } from "@/lib/discovery/store";
import { getKv, MemoryKv, setKvForTests } from "@/lib/kv";
import { RedisStore } from "@/lib/store/redis-store";

export const sharedMode = process.env.EMPLOYAI_TEST_STORE === "shared";

const kvByDir = new Map<string, MemoryKv>();

export function makeTestStore(dir: string): DiscoveryRepository {
  if (!sharedMode) return new FileDevStore(dir);
  // One shared Kv per directory: a new store on the same directory is a restarted server, same data.
  let kv = kvByDir.get(dir);
  if (!kv) { kv = new MemoryKv({ latency: () => new Promise<void>(r => setImmediate(r)) }); kvByDir.set(dir, kv); }
  setKvForTests(kv);   // locks, fences, limits and the store share one Kv, as on the hosted demo
  return new RedisStore(kv);
}

/** A digest of everything stored: the file locally, every key and value in shared mode. */
export function storeDigest(file: string): string {
  const content = sharedMode ? (getKv() as MemoryKv).dump() : readFileSync(file);
  return createHash("sha256").update(content).digest("hex");
}
