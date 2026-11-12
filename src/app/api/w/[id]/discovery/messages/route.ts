import { z } from "zod";
import { readBody } from "@/lib/http";
import { MAX_MESSAGE_LENGTH, normalizeMessage } from "@/lib/discovery/message";
import { ownerRoute, viewOrAiError } from "@/lib/discovery/routes";
import { consultantTurn } from "@/lib/discovery/service";
import { callerKey, limitResponse, limits } from "@/lib/hosted/rate-limit";

const Body = z.object({
  // Omit content to (re)request the consultant's reply to messages already saved.
  content: z.string().transform(normalizeMessage).pipe(z.string().min(1, "Please write a message first.").max(MAX_MESSAGE_LENGTH, `Please keep it under ${MAX_MESSAGE_LENGTH} characters.`)).optional(),
  client_message_id: z.uuid().optional(),
  skip: z.literal(true).optional(),
}).strict().refine(b => !(b.content && b.skip), "Send a message or skip, not both.");

/**
 * POST /api/w/[id]/discovery/messages — save the owner's message, then return the consultant's reply
 * in the same request. On an AI failure the message stays saved and the response is 502 with the
 * current state, so the client can retry without retyping.
 */
// Structured NEAR AI calls can take over a minute; the provider timeout is 170 s.
export const maxDuration = 180;

export function POST(request: Request, ctx: RouteContext<"/api/w/[id]/discovery/messages">) {
  return ownerRoute(request, ctx.params, async (business, cid) => {
    const body = await readBody(request, Body, cid);
    if ("response" in body) return body.response;
    const lim = limits();
    const limited = await limitResponse([{ limit: lim.aiPerWorkspace, subject: business.id }, { limit: lim.aiPerIp, subject: await callerKey() }], cid);
    if (limited) return limited;
    const { aiError } = await consultantTurn(business, { content: body.data.content, clientMessageId: body.data.client_message_id, skip: body.data.skip });
    return viewOrAiError(business, cid, aiError);
  }, { mutation: true });
}
