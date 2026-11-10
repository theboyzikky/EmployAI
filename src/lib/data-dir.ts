import path from "node:path";

/**
 * Where the local development store, the AI spending totals and the testnet signer lock live.
 * Locally: `.data/` in the project (git-ignored). On Vercel the deployment's file system is read-only
 * except `/tmp`, so the store goes there. It lasts only while one server instance stays warm and isn't
 * shared between instances, so a hosted demo's data can reset (the README says so).
 * `EMPLOYAI_DATA_DIR` overrides both.
 */
export function dataDir(env: Record<string, string | undefined> = process.env): string {
  const override = env.EMPLOYAI_DATA_DIR?.trim();
  if (override) return override;
  if (env.VERCEL) return path.join("/tmp", "employai");
  return path.join(process.cwd(), ".data");
}
