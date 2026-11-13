import { env } from "cloudflare:workers";
import { DomainError } from "@/lib/domain";
import { authorizeCollector, readCollectorPayload, saveUsage } from "@/lib/npu-storage";
import { errorResponse } from "@/lib/server";

export async function POST(request: Request) {
  try {
    await authorizeCollector(request, env.NPU_INGEST_TOKEN);
    if (!env.DB) throw new DomainError(503, "数据库尚未连接");
    const body = await readCollectorPayload(request);
    return Response.json(await saveUsage(env.DB, body, Date.now()));
  } catch (error) {
    return errorResponse(error);
  }
}
