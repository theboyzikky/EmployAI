import type { z } from 'zod';

export type ProviderName = 'mock' | 'nearai' | 'ollama';
export type TaskName = 'discovery_turn' | 'procurement_decision';

export type ToolDef = { name: string; description: string; schema: z.ZodType };

export type AiResult<T> = {
  data: T;
  provider: ProviderName;          // which provider actually produced the data
  model: string;
  mode: 'offline-demo' | 'live';   // shown as the "AI mode" badge in the UI
  usage: { input: number; output: number };
  costUsd: number;
  inferenceId?: string;
};

export interface AiProvider {
  readonly name: ProviderName;
  structured<T>(req: { task: TaskName; schema: z.ZodType<T>; system: string; user: string; maxTokens: number }): Promise<AiResult<T>>;
  toolCall(req: { task: TaskName; system: string; user: string; tools: readonly ToolDef[]; maxTokens: number }): Promise<AiResult<{ name: string; args: unknown }>>;
}
