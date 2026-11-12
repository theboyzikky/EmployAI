import path from "node:path";

/**
 * Where the LOCAL development files live: the file store, the AI spending totals and the testnet
 * signer lock file. Locally: `.data/` in the project (git-ignored). `EMPLOYAI_DATA_DIR` overrides it.
 * The hosted demo doesn't use these files: on Vercel the app uses the shared Upstash store for data,
 * locks and spending (src/lib/kv), and without it fails closed. The `/tmp` path below only keeps a
 * stray write on Vercel's read-only file system from crashing; nothing there is relied on.
 */
export function dataDir(env: Record<string, string | undefined> = process.env): string {
  const override = env.EMPLOYAI_DATA_DIR?.trim();
  if (override) return override;
  if (env.VERCEL) return path.join("/tmp", "employai");
  return path.join(process.cwd(), ".data");
}
