import type { z } from "zod";

export type ProviderName = "mock" | "nearai" | "ollama";
/** Every AI task in the app. Agent selection, security and transactions are never AI tasks. */
export type TaskName = "discovery_turn" | "business_analysis" | "workforce_plan" | "content_plan" | "content_caption" | "customer_reply";

export type AiMode = "offline-demo" | "live";

export type AiResult<T> = {
  data: T;
  provider: ProviderName;        // which provider actually produced the data
  model: string;
  mode: AiMode;                  // shown as the "AI mode" badge
  usage: { input: number; output: number };
  costUsd: number;
  inferenceId?: string;
};

export type StructuredRequest<T, C = unknown> = {
  task: TaskName;
  schema: z.ZodType<T>;
  /** System instructions (version-controlled in src/lib/ai/prompts). */
  system: string;
  /** Prompt text for live models; untrusted owner text is already wrapped in labelled blocks. */
  user: string;
  /** Typed context. The offline provider works from this instead of parsing prompt text. */
  context: C;
  maxTokens: number;
};

export interface AiProvider {
  readonly name: ProviderName;
  structured<T, C = unknown>(req: StructuredRequest<T, C>): Promise<AiResult<T>>;
}
