import { headers } from "next/headers";
import { jsonError, jsonOk } from "@/lib/http";
import { ownerRoute } from "@/lib/discovery/routes";
import { MAX_MEDIA_BYTES, publicMediaUrl, saveJpeg } from "@/lib/media/store";

type Ctx = { params: Promise<{ id: string }> };

/** POST /api/w/[id]/media — upload one real product photo (raw JPEG body, owner only, same origin). */
export function POST(request: Request, ctx: Ctx) {
  return ownerRoute(request, ctx.params, async (business, cid) => {
    if (!(request.headers.get("content-type") ?? "").startsWith("image/jpeg")) return jsonError(415, "UNSUPPORTED_MEDIA_TYPE", "Upload a JPEG photo.", cid);
    const h = await headers();
    const origin = request.headers.get("origin"), host = h.get("x-forwarded-host") ?? h.get("host");
    if (!origin || !host || (() => { try { return new URL(origin).host !== host; } catch { return true; } })()) return jsonError(403, "FORBIDDEN", "Cross-site uploads are not allowed.", cid);
    if (Number(request.headers.get("content-length") ?? "0") > MAX_MEDIA_BYTES) return jsonError(413, "PAYLOAD_TOO_LARGE", "The photo must be at most 4 MB.", cid);
    const bytes = new Uint8Array(await request.arrayBuffer());
    let id: string;
    try { id = await saveJpeg(business.id, bytes); } catch (e) { return jsonError(400, "VALIDATION_FAILED", e instanceof Error ? e.message : "Invalid photo.", cid); }
    return jsonOk({ media_id: id, path: `/api/media/${id}`, public_url: publicMediaUrl(id) }, cid, 201);
  }, { mutation: false });
}
