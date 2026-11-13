import { context, errorResponse } from "@/lib/server";
import { readUsage } from "@/lib/npu-storage";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const { actor, db, s } = await context();
    return Response.json(await readUsage(db, s, actor, new URL(request.url), Date.now()), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
