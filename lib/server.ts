import { env } from "cloudflare:workers";
import { getChatGPTUser } from "@/app/chatgpt-auth";
import { DomainError, mutate, serializePublic } from "./domain";
import { enrollAdmin } from "./admin-enrollment";
import { loadState, saveState } from "./repository";
import type { Action, Actor } from "./types";
export async function context() {
  if (!env.DB) throw new DomainError(503, "数据库尚未连接，请联系管理员");
  const s = await loadState(env.DB);
  const u = await getChatGPTUser();
  const actor: Actor = {
    userId: u?.userId ?? "",
    email: u?.email ?? "",
    displayName: u?.displayName ?? "访客",
    role: u ? "member" : "visitor",
    groupId: "",
    employeeId: "",
  };
  const configured = ((env as unknown as Record<string, string>).ADMIN_EMAILS ?? "")
    .split(",").map(x => x.trim().toLowerCase()).filter(Boolean);
  const enrolled = enrollAdmin(s, u, configured, new Date().toISOString());
  if (enrolled !== s) {
    await saveState(env.DB, s, enrolled);
    Object.assign(s, enrolled);
  }
  const existing = s.accounts.find(a => a.userId === actor.userId && a.status === "approved");
  if (existing) {
    actor.role = existing.role;
    actor.groupId = existing.groupId;
    actor.employeeId = existing.employeeId;
    actor.displayName = existing.displayName;
  }
  return {
    s,
    actor,
    db: env.DB,
    adminConfigured:
      !!configured.length ||
      s.accounts.some((a) => a.role === "admin" && a.status === "approved"),
  };
}
export async function read() {
  const c = await context();
  return serializePublic(
    c.s,
    c.actor,
    new Date().toISOString(),
    c.adminConfigured,
  );
}
export async function act(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin || origin !== new URL(request.url).origin)
    throw new DomainError(403, "请求来源校验失败");
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    throw new DomainError(415, "请使用JSON请求");
  const raw = await request.text();
  if (raw.length > 300000)
    throw new DomainError(413, "提交内容过大，请分批导入");
  let a: Action;
  try {
    a = JSON.parse(raw);
  } catch {
    throw new DomainError(400, "请求格式不正确");
  }
  if (
    !a ||
    typeof a !== "object" ||
    Array.isArray(a) ||
    typeof a.type !== "string"
  )
    throw new DomainError(400, "请求格式不正确");
  const c = await context();
  if (!c.actor.userId) throw new DomainError(401, "请先登录");
  if (a.revision !== c.s.revision)
    throw new DomainError(409, "数据已更新，请刷新后重试");
  const next = mutate(c.s, c.actor, a);
  await saveState(c.db, c.s, next);
  return serializePublic(
    next,
    c.actor,
    new Date().toISOString(),
    c.adminConfigured,
  );
}
export function errorResponse(e: unknown) {
  if (e instanceof DomainError)
    return Response.json(
      { error: e.message },
      { status: e.status, headers: { "Cache-Control": "no-store" } },
    );
  if (e instanceof RangeError)
    return Response.json({ error: "日期时间格式不正确" }, { status: 400 });
  console.error(
    "Request failed",
    e instanceof Error ? e.message : "Unknown error",
  );
  return Response.json(
    { error: "服务暂时不可用，请稍后重试" },
    { status: 500 },
  );
}
