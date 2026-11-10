import { randomUUID } from "node:crypto";
import { cookies, headers } from "next/headers";
import { StartRequest, type ApiError, type StartResponse } from "@/lib/discovery/message";
import { OWNER_COOKIE, discoveryRepository, hashOwnerToken, newOwnerToken } from "@/lib/discovery/store";
import { callerKey, limitResponse, limits } from "@/lib/hosted/rate-limit";


function error(status: number, code: string, message: string, correlationId: string) {
  const body: ApiError = { error: { code, message, correlation_id: correlationId } };
  return Response.json(body, { status, headers: { "X-Correlation-Id": correlationId } });
}

/** POST /api/start — create a discovery session from the hero description and hand off to /start/[id]. */
export async function POST(request: Request) {
  const correlationId = randomUUID();
  const h = await headers();

  if (!(request.headers.get("content-type") ?? "").includes("application/json")) {
    return error(415, "UNSUPPORTED_MEDIA_TYPE", "Send the description as JSON.", correlationId);
  }
  // Same-origin only (browsers always send Origin on POST).
  const origin = request.headers.get("origin");
  const host = h.get("x-forwarded-host") ?? h.get("host");
  if (origin && host && new URL(origin).host !== host) {
    return error(403, "FORBIDDEN", "Cross-site requests are not allowed.", correlationId);
  }
  // Shared limit per (hashed) IP, across every server instance; refused if the store is down.
  const limited = await limitResponse([{ limit: limits().startPerIp, subject: await callerKey() }], correlationId);
  if (limited) return limited;

  let json: unknown;
  try { json = await request.json(); } catch { return error(400, "VALIDATION_FAILED", "The request body is not valid JSON.", correlationId); }
  const parsed = StartRequest.safeParse(json);
  if (!parsed.success) {
    return error(400, "VALIDATION_FAILED", parsed.error.issues[0]?.message ?? "Invalid request.", correlationId);
  }

  try {
    const jar = await cookies();
    let token = jar.get(OWNER_COOKIE)?.value;
    if (!token || token.length < 32) token = newOwnerToken();
    const session = await discoveryRepository().createBusiness({ ownerHash: hashOwnerToken(token), initialMessage: parsed.data.message });
    jar.set(OWNER_COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
    });
    const body: StartResponse = { sessionId: session.id, redirectTo: `/start/${session.id}` };
    return Response.json(body, { status: 201, headers: { "X-Correlation-Id": correlationId } });
  } catch {
    return error(500, "SESSION_CREATE_FAILED", "We couldn't save your description. Please try again.", correlationId);
  }
}
