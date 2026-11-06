import "server-only";
import { randomUUID } from "node:crypto";
import { headers } from "next/headers";
import type { z } from "zod";

export const newCorrelationId = () => randomUUID();

export function jsonError(status: number, code: string, message: string, correlationId: string, extra: Record<string, unknown> = {}) {
  return Response.json({ error: { code, message, correlation_id: correlationId }, ...extra }, { status, headers: { "X-Correlation-Id": correlationId } });
}

export function jsonOk(body: unknown, correlationId: string, status = 200) {
  return Response.json(body, { status, headers: { "X-Correlation-Id": correlationId, "Cache-Control": "no-store" } });
}

/** JSON-only, same-origin checks for every state-changing request. Returns an error Response or null. */
export async function checkMutation(request: Request, correlationId: string): Promise<Response | null> {
  if (!(request.headers.get("content-type") ?? "").includes("application/json")) {
    return jsonError(415, "UNSUPPORTED_MEDIA_TYPE", "Send the request as JSON.", correlationId);
  }
  const h = await headers();
  const origin = request.headers.get("origin");
  const host = h.get("x-forwarded-host") ?? h.get("host");
  if (origin && host) {
    let originHost: string | null = null;
    try { originHost = new URL(origin).host; } catch { /* malformed origin */ }
    if (originHost !== host) return jsonError(403, "FORBIDDEN", "Cross-site requests are not allowed.", correlationId);
  }
  return null;
}

/** Parse a JSON body with a strict schema. Unknown fields are rejected by the schema. */
export async function readBody<T>(request: Request, schema: z.ZodType<T>, correlationId: string): Promise<{ data: T } | { response: Response }> {
  let json: unknown;
  try {
    const text = await request.text();
    if (text.length > 20_000) return { response: jsonError(413, "PAYLOAD_TOO_LARGE", "The request is too large.", correlationId) };
    json = text ? JSON.parse(text) : {};
  } catch {
    return { response: jsonError(400, "VALIDATION_FAILED", "The request body is not valid JSON.", correlationId) };
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) return { response: jsonError(400, "VALIDATION_FAILED", parsed.error.issues[0]?.message ?? "Invalid request.", correlationId) };
  return { data: parsed.data };
}
