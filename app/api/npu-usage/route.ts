import { context, errorResponse } from "@/lib/server";
import { DomainError } from "@/lib/domain";
import { readUsage } from "@/lib/npu-storage";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const { actor, db, s } = await context();
    if (actor.role !== "admin") throw new DomainError(403, "需要管理员权限");
    return Response.json(await readUsage(db, s, new URL(request.url), Date.now()), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
