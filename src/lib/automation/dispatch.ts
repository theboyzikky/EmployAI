import "server-only";
// Waking workers. Three independent paths, so QStash is never a single point of failure:
//   1. inline   — after() in the request that created the work runs it right after the response;
//   2. QStash   — a signed POST to /api/worker (delayed retries, and a backstop if the inline run dies);
//   3. sweep    — /api/worker without a business (QStash schedule, the daily Vercel cron, or piggy-backed
//                 on inbound webhooks) walks the due-work index and runs whatever is due.
// Tasks are in the shared store; every path only says "look now". If QStash is down, out of quota or not
// configured, paths 1 and 3 still run the work. If the store is down, nothing runs and nothing is lost.
import { after } from "next/server";
import { discoveryRepository } from "@/lib/discovery/store";
import { qstashPublish, type PublishResult } from "./qstash";
import { runDueTasks } from "./worker";

type Env = Record<string, string | undefined>;

/** The public https origin QStash should call (null locally: QStash can't reach localhost). */
export function publicBaseUrl(env: Env = process.env): string | null {
  const explicit = env.EMPLOYAI_PUBLIC_URL?.replace(/\/$/, "");
  if (explicit?.startsWith("https://")) return explicit;
  if (env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${env.VERCEL_PROJECT_PRODUCTION_URL.replace(/^https?:\/\//, "").replace(/\/$/, "")}`;
  return null;
}
export const workerUrl = (env: Env = process.env) => { const b = publicBaseUrl(env); return b ? `${b}/api/worker` : null; };

export type WakeReport = { inline: boolean; qstash: PublishResult };

/** Ask for this business's due tasks to be run (soon, or at `atIso`). Never throws. */
export async function wake(businessId: string, o: { atIso?: string | null } = {}, env: Env = process.env): Promise<WakeReport> {
  const delayS = o.atIso ? Math.max(0, Math.ceil((Date.parse(o.atIso) - Date.now()) / 1000)) : 0;
  let inline = false;
  if (delayS === 0) {
    try { after(() => runDueTasks(businessId).then(() => undefined, () => undefined)); inline = true; }
    catch { inline = false; }                      // outside a request (tests, scripts): rely on the other paths
  }
  const url = workerUrl(env);
  // QStash: the delayed retry, or a backstop a little after the inline run (in case that instance dies).
  const qstash: PublishResult = url
    ? await qstashPublish(url, { business_id: businessId }, { delaySeconds: inline ? Math.max(delayS, 30) : delayS, dedupeId: `wake:${businessId}:${Math.floor((Date.now() + delayS * 1000) / 60_000)}` }, env)
    : { ok: false, reason: "NO_PUBLIC_URL" };
  return { inline, qstash };
}

/** Run due work for up to `maxBusinesses` businesses from the due-work index, within a time budget. */
export async function sweep(o: { maxBusinesses?: number; deadlineMs?: number } = {}): Promise<{ businesses: number; processed: number }> {
  const deadline = Date.now() + (o.deadlineMs ?? 25_000);
  const ids = await discoveryRepository().businessesWithDueWork();
  let businesses = 0, processed = 0;
  for (const id of ids.slice(0, o.maxBusinesses ?? 10)) {
    if (Date.now() >= deadline) break;
    const r = await runDueTasks(id, { deadlineMs: Math.max(1_000, deadline - Date.now()) });
    businesses++; processed += r.processed;
  }
  return { businesses, processed };
}

/** Piggy-back a small sweep on any request (e.g. inbound webhooks), after the response. Never throws. */
export function sweepAfterResponse(o: { maxBusinesses?: number; deadlineMs?: number } = { maxBusinesses: 3, deadlineMs: 15_000 }) {
  try { after(() => sweep(o).then(() => undefined, () => undefined)); } catch { /* outside a request */ }
}
