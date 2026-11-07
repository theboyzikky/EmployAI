// Browser-side client for the run routes (M4). Every call returns the server's views when it has them,
// so the page never loses state. The page sends one request at a time; only "advance" runs steps.
import type { RunView, RunsView } from "@/lib/runs/view-types";

export type RunsCall =
  | { ok: true; status: number; view?: RunsView; run?: RunView; more?: boolean; settling?: boolean; finalised?: boolean }
  | { ok: false; status: number; code: string; message: string; view?: RunsView; run?: RunView };

const TIMEOUT_MS = 20_000;

export async function callRuns(path: string, method: "GET" | "POST" | "PATCH", body?: unknown, headers: Record<string, string> = {}): Promise<RunsCall> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(path, {
      method,
      headers: body === undefined ? headers : { "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
      cache: "no-store",
    });
    const json = (await res.json().catch(() => null)) as (Record<string, unknown> & { error?: { code: string; message: string } }) | null;
    const view = (json?.view ?? json?.runs) as RunsView | undefined;
    const run = json?.run as RunView | undefined;
    if (res.ok) return { ok: true, status: res.status, view, run, more: json?.more as boolean | undefined, settling: json?.settling as boolean | undefined, finalised: json?.finalised as boolean | undefined };
    return { ok: false, status: res.status, code: json?.error?.code ?? `HTTP_${res.status}`, message: json?.error?.message ?? "Something went wrong. Please try again.", view, run };
  } catch (e) {
    const timeout = (e as Error)?.name === "AbortError";
    return { ok: false, status: 0, code: timeout ? "CLIENT_TIMEOUT" : "NETWORK", message: timeout ? "This is taking longer than expected." : "We couldn't reach EmployAI. Check your connection." };
  } finally {
    clearTimeout(timer);
  }
}

/** A fresh idempotency key for each start the owner asks for (a retry of the same request reuses it). */
export const newIdempotencyKey = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`);
