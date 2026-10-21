import type { State } from "./types";

// Only call with the identity returned by server-side ChatGPT authentication.
export function enrollAdmin(s: State, user: { userId: string; email: string; displayName: string } | null, configured: string[], now: string): State {
  if (!user) return s;
  const email = user.email.trim().toLowerCase();
  const invitation = s.invitations.find(i => i.status === "pending" && i.email === email);
  const previous = s.accounts.find(a => a.userId === user.userId);
  const bootstrap = configured.includes(email) && (!previous || (previous.role !== "admin" && previous.status !== "approved"));
  if (!invitation && !bootstrap) return s;
  const next = structuredClone(s);
  const account = {
    id: previous?.id ?? crypto.randomUUID(), userId: user.userId, email: user.email,
    displayName: invitation?.displayName || previous?.displayName || user.displayName,
    employeeId: previous?.employeeId ?? "", groupId: previous?.groupId ?? "",
    role: "admin" as const, status: "approved" as const, createdAt: previous?.createdAt ?? now,
  };
  if (previous) next.accounts[next.accounts.findIndex(a => a.id === previous.id)] = account;
  else next.accounts.push(account);
  if (invitation) next.invitations.find(i => i.id === invitation.id)!.status = "accepted";
  next.revision++;
  next.audits.push({
    id: crypto.randomUUID(), at: now, actorId: user.userId, actorName: account.displayName,
    action: invitation ? "接受管理员邀请" : "初始化管理员", entityType: "account", entityId: account.id,
    summary: invitation ? "通过受邀邮箱登录并绑定管理员账号" : "通过服务器端配置初始化管理员身份",
    before: JSON.stringify(previous ?? null), after: JSON.stringify(account),
  });
  return next;
}
