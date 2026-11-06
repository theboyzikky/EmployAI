"use client";

import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { MAX_MESSAGE_LENGTH, normalizeMessage, type ApiError, type StartResponse } from "@/lib/discovery/message";

type Status = "idle" | "submitting" | "error";

/**
 * Hero / onboarding handoff: POST the description to /api/start, which creates the discovery
 * session and returns its URL; then navigate there. The text is kept on failure so it can be retried.
 */
export function useStartConversation() {
  const router = useRouter();
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(async (raw: string) => {
    const message = normalizeMessage(raw);
    if (!message) { setError("Please describe your business first."); setStatus("error"); return false; }
    if (message.length > MAX_MESSAGE_LENGTH) { setError(`Please keep it under ${MAX_MESSAGE_LENGTH} characters.`); setStatus("error"); return false; }
    setStatus("submitting");
    setError(null);
    try {
      const res = await fetch("/api/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as ApiError | null;
        throw new Error(body?.error?.message || "We couldn't start your conversation.");
      }
      const data = (await res.json()) as StartResponse;
      router.push(data.redirectTo);
      return true; // stay in "submitting" while the next page loads
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : "We couldn't start your conversation.");
      setStatus("error");
      return false;
    }
  }, [router]);

  return { submit, status, error, clearError: () => { setError(null); setStatus("idle"); } };
}
