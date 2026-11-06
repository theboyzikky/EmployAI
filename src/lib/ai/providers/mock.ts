// Offline demo provider (AI_PROVIDER=mock): deterministic rules, zero cost, no network.
// Labelled "offline-demo" everywhere. It handles only known tasks; anything else is a CONFIG error,
// never a generic fake answer. The live provider never imports this file.
import { AiError } from "../errors";
import type { AiProvider, AiResult, StructuredRequest } from "../provider";
import { offlineDiscoveryTurn, type TurnContext } from "@/lib/rules/consultant";
import { offlineAnalysis } from "@/lib/rules/analysis";
import type { ProfileDoc } from "@/lib/discovery/profile";

export const OFFLINE_MODEL = "offline-rules-v2";

export class MockProvider implements AiProvider {
  readonly name = "mock" as const;

  async structured<T, C = unknown>(req: StructuredRequest<T, C>): Promise<AiResult<T>> {
    let out: unknown;
    switch (req.task) {
      case "discovery_turn": out = offlineDiscoveryTurn(req.context as unknown as TurnContext); break;
      case "business_analysis": out = offlineAnalysis((req.context as unknown as { profile: ProfileDoc }).profile); break;
      default: throw new AiError("CONFIG", "mock", `The offline provider has no handler for task ${String(req.task)}`);
    }
    // Same schema validation as live output.
    const data = req.schema.parse(out);
    return { data, provider: "mock", model: OFFLINE_MODEL, mode: "offline-demo", usage: { input: 0, output: 0 }, costUsd: 0 };
  }
}
