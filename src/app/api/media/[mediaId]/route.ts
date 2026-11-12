import { loadMedia } from "@/lib/media/store";

type Ctx = { params: Promise<{ mediaId: string }> };

/** GET /api/media/[mediaId] — an owner-uploaded product photo (public by design: Instagram fetches it). */
export async function GET(_request: Request, ctx: Ctx) {
  const { mediaId } = await ctx.params;
  let m;
  try { m = await loadMedia(mediaId); } catch { return new Response("Unavailable", { status: 503 }); }
  if (!m) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(m.bytes), { status: 200, headers: { "content-type": "image/jpeg", "content-length": String(m.bytes.length), "cache-control": "public, max-age=86400, immutable", "x-content-type-options": "nosniff" } });
}
