// Browser-side client for /api/w/[id]/*. Every call returns the full view on success, and on failure
// the server's current view when it has one (so the UI never loses state).
import type { ApiFailure, DiscoveryView } from "@/lib/discovery/view-types";

export type CallResult =
  | { ok: true; view: DiscoveryView }
  | { ok: false; status: number; code: string; message: string; view?: DiscoveryView; ai?: { code: string; message: string } };

const TIMEOUT_MS = 90_000;

export async function callApi(path: string, method: "GET" | "POST" | "PATCH", body?: unknown): Promise<CallResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
      cache: "no-store",
    });
    const json = (await res.json().catch(() => null)) as ({ view: DiscoveryView } & Partial<ApiFailure>) | null;
    if (res.ok && json?.view) return { ok: true, view: json.view };
    return {
      ok: false, status: res.status,
      code: json?.error?.code ?? "HTTP_" + res.status,
      message: json?.error?.message ?? "Something went wrong. Please try again.",
      view: json?.view, ai: json?.ai,
    };
  } catch (e) {
    const timeout = (e as Error)?.name === "AbortError";
    return {
      ok: false, status: 0, code: timeout ? "CLIENT_TIMEOUT" : "NETWORK",
      message: timeout ? "This is taking longer than expected." : "We couldn't reach EmployAI. Check your connection.",
    };
  } finally {
    clearTimeout(timer);
  }
}
