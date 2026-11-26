import { context, errorResponse } from "@/lib/server";
import { readLive } from "@/lib/npu-live";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    const { actor, db, s } = await context();
    return Response.json(await readLive(db, s, actor, new URL(request.url), Date.now()), {
      headers: {"Cache-Control": "private, no-store"},
    });
  } catch (error) {
    return errorResponse(error);
  }
}
