import "server-only";
// Shared rate limits (fixed windows in the shared store, so they hold across every server instance and
// survive restarts). Mostly per workspace; per IP only as a looser backstop, because several judges may
// share one venue's Wi-Fi. IPs are never stored: only a salted hash. If the store can't be reached the
// request is refused (fail closed): 503, not "allowed".
import { createHash } from "node:crypto";
import { headers } from "next/headers";
import { jsonError } from "@/lib/http";
import { getKv } from "@/lib/kv";

export type Limit = { name: string; max: number; windowMs: number; message: string };

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const num = (v: string | undefined, d: number) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : d; };

export function limits(env: Record<string, string | undefined> = process.env) {
  return {
    startPerIp: { name: "start-ip", max: num(env.EMPLOYAI_LIMIT_START_PER_IP_10MIN, 20), windowMs: 10 * MIN, message: "Too many new conversations from this network. Please wait a few minutes and try again." },
    aiPerWorkspace: { name: "ai-ws", max: num(env.EMPLOYAI_LIMIT_AI_PER_WORKSPACE_DAY, 80), windowMs: DAY, message: "This workspace has used today's AI consultant allowance. It resets tomorrow (UTC)." },
    aiPerIp: { name: "ai-ip", max: num(env.EMPLOYAI_LIMIT_AI_PER_IP_DAY, 300), windowMs: DAY, message: "This network has used today's AI consultant allowance. It resets tomorrow (UTC)." },
    testnetPerWorkspace: { name: "tn-ws", max: num(env.EMPLOYAI_LIMIT_TESTNET_RUNS_PER_WORKSPACE_DAY, 4), windowMs: DAY, message: "This workspace has started today's maximum of real testnet runs. Simulated test runs are still available." },
    hookPerConnection: { name: "hook-conn", max: num(env.EMPLOYAI_LIMIT_HOOK_PER_CONNECTION_MIN, 120), windowMs: MIN, message: "Too many events for this connection; please retry shortly." },
    testnetPerIp: { name: "tn-ip", max: num(env.EMPLOYAI_LIMIT_TESTNET_RUNS_PER_IP_DAY, 8), windowMs: DAY, message: "This network has started today's maximum of real testnet runs. Simulated test runs are still available." },
  } satisfies Record<string, Limit>;
}

/** A salted hash of the caller's IP (Vercel sets x-real-ip; never stored in clear). */
export async function callerKey(): Promise<string> {
  const h = await headers();
  const ip = h.get("x-real-ip") ?? (h.get("x-forwarded-for") ?? "").split(",")[0].trim() ?? "";
  return createHash("sha256").update(`eai-rl:${process.env.EMPLOYAI_RATE_LIMIT_SALT ?? "employai"}:${ip || "local"}`).digest("hex").slice(0, 32);
}

/** Count one hit against each limit; the first one exceeded wins. */
export async function checkLimits(checks: Array<{ limit: Limit; subject: string }>): Promise<{ ok: true } | { ok: false; limit: Limit; retryAfterS: number }> {
  const kv = getKv();
  const now = Date.now();
  for (const { limit, subject } of checks) {
    const window = Math.floor(now / limit.windowMs);
    const count = await kv.hit(`rl:${limit.name}:${subject}:${window}`, limit.windowMs);
    if (count > limit.max) return { ok: false, limit, retryAfterS: Math.max(1, Math.ceil(((window + 1) * limit.windowMs - now) / 1000)) };
  }
  return { ok: true };
}

/** For routes: null when allowed, otherwise the 429 (or 503 if the shared store is down) to return. */
export async function limitResponse(checks: Array<{ limit: Limit; subject: string }>, correlationId: string): Promise<Response | null> {
  let r;
  try { r = await checkLimits(checks); }
  catch { return jsonError(503, "SERVICE_UNAVAILABLE", "The demo's shared store can't be reached right now, so this request was refused. Please try again shortly.", correlationId); }
  if (r.ok) return null;
  const res = jsonError(429, "RATE_LIMITED", r.limit.message, correlationId);
  res.headers.set("Retry-After", String(r.retryAfterS));
  return res;
}
