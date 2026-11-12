// Browser-side client for the platform routes (workforce, content, connections, media upload).
import type { PlatformView } from "@/lib/platform/view";

export type PlatformCall = { ok: true; view?: PlatformView; data: Record<string, unknown> } | { ok: false; status: number; code: string; message: string; view?: PlatformView };

export async function callPlatform(path: string, method: "GET" | "POST" | "PATCH", body?: unknown, raw?: { contentType: string; data: Blob }): Promise<PlatformCall> {
  try {
    const res = await fetch(path, {
      method,
      headers: raw ? { "Content-Type": raw.contentType } : body === undefined ? {} : { "Content-Type": "application/json" },
      body: raw ? raw.data : body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(90_000),
    });
    const json = (await res.json().catch(() => null)) as (Record<string, unknown> & { error?: { code: string; message: string }; view?: PlatformView }) | null;
    if (res.ok) return { ok: true, view: json?.view, data: json ?? {} };
    return { ok: false, status: res.status, code: json?.error?.code ?? `HTTP_${res.status}`, message: json?.error?.message ?? "Something went wrong. Please try again.", view: json?.view };
  } catch {
    return { ok: false, status: 0, code: "NETWORK", message: "We couldn't reach EmployAI. Check your connection." };
  }
}

export const statusPill = (s: string) =>
  s === "connected" || s === "operational" || s === "published" || s === "active" || s === "done" ? "pill pill-ok"
  : s === "available" || s === "scheduled" || s === "publishing" || s === "draft" || s === "preview" ? "pill pill-accent"
  : s === "failed" || s === "needs_attention" || s === "needs_changes" || s === "paused" || s === "escalated" || s === "rejected" ? "pill pill-warn"
  : "pill";
