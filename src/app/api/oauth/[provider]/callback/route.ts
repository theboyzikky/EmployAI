import { NextResponse } from "next/server";
import "@/lib/integrations/providers";   // connectors used to verify the account
import { wake } from "@/lib/automation/dispatch";
import { getOwnedBusiness } from "@/lib/discovery/access";
import { completeOAuth, isOAuthKind, peekState } from "@/lib/integrations/oauth";

type Ctx = { params: Promise<{ provider: string }> };

const page = (status: number, text: string) => new NextResponse(`<!doctype html><meta charset="utf-8"><title>EmployAI</title><body style="font-family:system-ui;padding:40px"><p>${text}</p><p><a href="/">Back to EmployAI</a></p></body>`, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });

/**
 * GET /api/oauth/[provider]/callback — the provider sends the owner back here after consent.
 * The state must be one we issued (single use, 10 minutes) AND the browser must carry the owner cookie
 * of the business that started it; otherwise nothing is connected. Tokens never appear in the response.
 */
export async function GET(request: Request, ctx: Ctx) {
  const { provider } = await ctx.params;
  if (!isOAuthKind(provider)) return page(404, "Unknown connection flow.");
  const url = new URL(request.url);
  const state = url.searchParams.get("state") ?? "";
  const pending = await peekState(state);
  if (!pending || pending.k !== provider) return page(400, "This connection link has expired or was already used. Start again from Integrations.");
  const business = await getOwnedBusiness(pending.b);
  if (!business) return page(403, "Open this link in the browser where you manage this EmployAI workspace.");
  let outcome = "error", returnTo = pending.ret;
  try {
    const r = await completeOAuth(provider, state, pending, { code: url.searchParams.get("code"), error: url.searchParams.get("error") });
    outcome = r.outcome; returnTo = r.returnTo;
    if (outcome === "connected") await wake(pending.b);   // e.g. a mailbox's first check starts now
  } catch { outcome = "error"; }
  const back = new URL(returnTo, url.origin);
  back.searchParams.set("oauth", outcome);
  back.searchParams.set("provider", pending.p);
  return NextResponse.redirect(back, { status: 303, headers: { "Cache-Control": "no-store" } });
}
