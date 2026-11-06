// Browser-side client for /api/w/[id]/workflows/*. Every call returns the full workspace view on
// success, and on failure the server's current view when it has one (so the UI never loses state).
import type { WorkspaceApiFailure, WorkspaceView } from "@/lib/workflows/view-types";

export type WorkspaceCall =
  | { ok: true; view: WorkspaceView }
  | { ok: false; status: number; code: string; message: string; view?: WorkspaceView };

const TIMEOUT_MS = 30_000;

export async function callWorkspace(path: string, method: "GET" | "POST" | "PATCH", body?: unknown): Promise<WorkspaceCall> {
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
    const json = (await res.json().catch(() => null)) as ({ view: WorkspaceView } & Partial<WorkspaceApiFailure>) | null;
    if (res.ok && json?.view) return { ok: true, view: json.view };
    return {
      ok: false, status: res.status,
      code: json?.error?.code ?? "HTTP_" + res.status,
      message: json?.error?.message ?? "Something went wrong. Please try again.",
      view: json?.view,
    };
  } catch (e) {
    const timeout = (e as Error)?.name === "AbortError";
    return { ok: false, status: 0, code: timeout ? "CLIENT_TIMEOUT" : "NETWORK", message: timeout ? "This is taking longer than expected. Please try again." : "We couldn't reach EmployAI. Check your connection." };
  } finally {
    clearTimeout(timer);
  }
}

/** Illustrative demo amounts in Nigerian naira. Never converted to any other currency. */
export const ngn = (n: number) => new Intl.NumberFormat("en-NG", { style: "currency", currency: "NGN", maximumFractionDigits: 0 }).format(n);

export const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
