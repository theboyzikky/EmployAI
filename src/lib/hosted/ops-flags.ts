// Operator switches for the hosted demo, set in the shared store (no redeploy needed):
//   ops:testnet_paused  → no new testnet signature or broadcast (runs abort cleanly; nothing is sent)
//   ops:ai_paused       → no live AI call (discovery answers AI_UNAVAILABLE)
// Set one from the Upstash console with:  SET eai:ops:testnet_paused 1   (DEL to resume)
// Reading a flag goes through the shared store: if it can't be read, the caller fails closed.
import { getKv } from "@/lib/kv";

export type OpsFlag = "testnet_paused" | "ai_paused";
export const opsFlagKey = (f: OpsFlag) => `ops:${f}`;

export async function opsFlag(f: OpsFlag): Promise<boolean> {
  const v = await getKv().get(opsFlagKey(f));
  return v !== null && v !== "" && v !== "0";
}
