import "server-only";
import { cookies } from "next/headers";
import { OWNER_COOKIE, discoveryRepository, hashOwnerToken, isSessionId, type BusinessRecord } from "./store";

/**
 * The business, only if the request carries the owner cookie of the browser that created it.
 * Anyone else gets null (callers answer 404, so existence isn't revealed).
 */
export async function getOwnedBusiness(id: string): Promise<BusinessRecord | null> {
  if (!isSessionId(id)) return null;
  const token = (await cookies()).get(OWNER_COOKIE)?.value;
  if (!token || token.length < 32) return null;
  const b = await discoveryRepository().getBusiness(id);
  if (!b || b.owner_hash !== hashOwnerToken(token)) return null;
  return b;
}

/** The owner's most recent unfinished discovery (for "Continue where you left off"). */
export async function latestUnfinished(): Promise<BusinessRecord | null> {
  const token = (await cookies()).get(OWNER_COOKIE)?.value;
  if (!token || token.length < 32) return null;
  const repo = discoveryRepository();
  for (const b of await repo.listBusinessesByOwner(hashOwnerToken(token))) {
    const agents = await repo.listAgents(b.id);
    if (!agents.some(a => a.status === "approved")) return b;
  }
  return null;
}
