import { env } from "cloudflare:workers";
import { context, errorResponse } from "@/lib/server";
import { readUsage } from "@/lib/npu-storage";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const { actor, db, s } = await context();
    return Response.json(await readUsage(db, s, actor, new URL(request.url), Date.now(), env.NPU_MONITORING_RETIREMENTS), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
