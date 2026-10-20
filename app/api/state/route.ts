import { read, errorResponse } from "@/lib/server";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    return Response.json(await read(), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
