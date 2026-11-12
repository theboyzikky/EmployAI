// The contract every messaging connector implements, so customer conversations are channel-independent:
//  - inbound: a "message.received" event whose payload is an InboundMessagePayload
//  - outbound: an action named "<connector>.reply" that accepts ReplyInput
import { z } from "zod";

export type InboundMessagePayload = {
  channel: "telegram" | "instagram" | "messenger" | "whatsapp" | "gmail" | "outlook";
  /** The provider's conversation key (chat id, IGSID, PSID, WhatsApp number, email thread id). */
  thread: string;
  from: string | null;
  text: string;
  /** The provider's message id: the dedupe key. */
  message_id: string;
  sent_at: string | null;
  /** What a reply on this channel needs (strings only), e.g. a business connection id or an email subject. */
  context: Record<string, string>;
};

export const ReplyInput = z.object({
  conversation_id: z.string().max(64),
  message_id: z.string().max(64),
  thread: z.string().min(1).max(256),
  text: z.string().min(1).max(2000),
  context: z.record(z.string(), z.string().max(1000)).optional(),
}).strict();
export type ReplyInputT = z.infer<typeof ReplyInput>;
