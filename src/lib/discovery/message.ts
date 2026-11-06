import { z } from "zod";

export const MAX_MESSAGE_LENGTH = 4000;

/** Normalise a business description exactly once, the same way on client and server. */
export function normalizeMessage(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    // strip control characters except newline and tab
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim();
}

export const StartRequest = z.object({
  message: z
    .string({ error: "A business description is required." })
    .transform(normalizeMessage)
    .pipe(
      z.string()
        .min(1, "Please describe your business first.")
        .max(MAX_MESSAGE_LENGTH, `Please keep it under ${MAX_MESSAGE_LENGTH} characters.`),
    ),
}).strict();

export type StartResponse = { sessionId: string; redirectTo: string };
export type ApiError = { error: { code: string; message: string; correlation_id: string } };
