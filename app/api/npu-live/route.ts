import { context, errorResponse } from "@/lib/server";
import { readLive } from "@/lib/npu-live";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    const now = Date.now();
    const { actor, db, s } = await context(new Date(now - 5 * 60 * 60 * 1000).toISOString());
    return Response.json(await readLive(db, s, actor, new URL(request.url), now), {
      headers: {"Cache-Control": "private, no-store"},
    });
  } catch (error) {
    return errorResponse(error);
  }
}
