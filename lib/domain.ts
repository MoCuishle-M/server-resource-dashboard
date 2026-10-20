import type {
  Action,
  Actor,
  Audit,
  Booking,
  Resource,
  State,
  UsageRequest,
  Priority,
} from "./types";
export class DomainError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export const priorityRank = { normal: 0, high: 1, urgent: 2 };
export const priorityLabel = { normal: "普通", high: "高优", urgent: "紧急" };
export const slots = [
  { label: "上午", start: "09:00", end: "12:00" },
  { label: "午间", start: "12:00", end: "14:00" },
  { label: "下午", start: "14:00", end: "17:30" },
  { label: "晚间", start: "17:30", end: "21:00" },
  { label: "跨夜", start: "21:00", end: "09:00" },
];
export function emptyState(): State {
  return {
    revision: 0,
    resources: [],
    groups: Array.from({ length: 10 }, (_, i) => ({
      id: `g${i + 1}`,
      name: `${String(i + 1).padStart(2, "0")}组`,
      contactName: "",
      employeeId: "",
    })),
    accounts: [],
    requests: [],
    bookings: [],
    audits: [],
  };
}
export function overlaps(
  a: { startAt: string; endAt: string },
  b: { startAt: string; endAt: string },
) {
  return (
    Date.parse(a.startAt) < Date.parse(b.endAt) &&
    Date.parse(b.startAt) < Date.parse(a.endAt)
  );
}
export function activeBookings(s: State, now: string) {
  return s.bookings.filter(
    (b) => b.status === "scheduled" && b.startAt <= now && b.endAt > now,
  );
}
export function timeRange(date: string, slot: number) {
  const s = slots[slot];
  const startAt = new Date(`${date}T${s.start}:00+08:00`).toISOString();
  const end = new Date(`${date}T${s.end}:00+08:00`);
  if (s.end <= s.start) end.setUTCDate(end.getUTCDate() + 1);
  return { startAt, endAt: end.toISOString() };
}
export function chinaDate(now = new Date()) {
  return new Date(now.getTime() + 8 * 3600000).toISOString().slice(0, 10);
}
function fail(message: string, status = 400): never {
  throw new DomainError(status, message);
}
function text(value: unknown, label: string, max = 200, required = true) {
  if (typeof value !== "string") fail(`${label}格式不正确`);
  const v = value.trim();
  if ((required && !v) || v.length > max)
    fail(`${label}${v ? `不能超过${max}字` : "不能为空"}`);
  return v;
}
function ids(value: unknown, label: string) {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > 200 ||
    value.some((v) => typeof v !== "string")
  )
    fail(`请选择${label}（最多200项）`);
  return [...new Set(value as string[])];
}
function ipValid(ip: string) {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip))
    return ip.split(".").every((n) => +n <= 255);
  if (!ip.includes(":") || /[^\da-fA-F:.]/.test(ip)) return false;
  try {
    return !!new URL(`http://[${ip}]/`).hostname;
  } catch {
    return false;
  }
}
export function mutate(
  original: State,
  actor: Actor,
  action: Action,
  now = new Date().toISOString(),
): State {
  const s: State = structuredClone(original);
  const admin = actor.role === "admin";
  const contact = admin || actor.role === "contact";
  function needAdmin() {
    if (!admin) fail("仅服务器管理员可以执行此操作", 403);
  }
  function needContact() {
    if (!contact) fail("请先登录并通过组接口人认证", 403);
  }
  function audit(
    kind: string,
    entityType: string,
    entityId: string,
    summary: string,
    before: unknown = null,
    after: unknown = null,
  ) {
    s.audits.push({
      id: crypto.randomUUID(),
      at: now,
      actorId: actor.userId,
      actorName: actor.displayName,
      action: kind,
      entityType,
      entityId,
      summary,
      before: JSON.stringify(before),
      after: JSON.stringify(after),
    });
  }
  function findRequest() {
    const r = s.requests.find((r) => r.id === action.id);
    if (!r) fail("申请不存在", 404);
    return r;
  }
  function owned(r: UsageRequest) {
    if (!admin && r.groupId !== actor.groupId) fail("只能操作本组申请", 403);
  }
  function resourceInput(value: unknown, previous?: Resource): Resource {
    const v = value as Record<string, unknown>;
    if (!v || typeof v !== "object") fail("服务器数据格式不正确");
    const ip = text(v.ip, "IP", 64);
    if (!ipValid(ip)) fail(`IP地址格式不正确：${ip}`);
    if (!["bare", "lingshu"].includes(v.accessMode as string))
      fail("请选择裸机或灵枢平台");
    if (!["available", "maintenance"].includes(v.status as string))
      fail("资源状态不正确");
    return {
      id: previous?.id ?? crypto.randomUUID(),
      name: text(v.name, "服务器名称", 80),
      type: text(v.type, "服务器类型", 80),
      ip,
      accessMode: v.accessMode as Resource["accessMode"],
      status: v.status as Resource["status"],
      location: text(v.location ?? "", "位置", 100, false),
      note: text(v.note ?? "", "备注", 1000, false),
      deleted: false,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };
  }
  function validateUniqueResources() {
    const live = s.resources.filter((r) => !r.deleted);
    if (new Set(live.map((r) => r.ip.toLowerCase())).size !== live.length)
      fail("IP地址重复，请检查已有资源及导入表格");
    if (new Set(live.map((r) => r.name)).size !== live.length)
      fail("服务器名称重复");
  }
  switch (action.type) {
    case "resource.save": {
      needAdmin();
      const existing = action.id
        ? s.resources.find((r) => r.id === action.id && !r.deleted)
        : undefined;
      if (action.id && !existing) fail("服务器不存在", 404);
      const r = resourceInput(action.resource, existing);
      if (
        existing &&
        r.status === "maintenance" &&
        s.bookings.some(
          (b) =>
            b.resourceId === r.id && b.status === "scheduled" && b.endAt > now,
        )
      )
        fail("该服务器还有有效预约，请先取消或释放预约再维护", 409);
      if (existing) s.resources[s.resources.indexOf(existing)] = r;
      else s.resources.push(r);
      validateUniqueResources();
      audit(
        existing ? "修改服务器" : "新增服务器",
        "resource",
        r.id,
        `${existing ? "修改" : "新增"} ${r.name}`,
        existing,
        r,
      );
      break;
    }
    case "resource.import": {
      needAdmin();
      if (
        !Array.isArray(action.rows) ||
        !action.rows.length ||
        action.rows.length > 200
      )
        fail("每批导入1至200行");
      const rows = action.rows.map((r) => resourceInput(r));
      s.resources.push(...rows);
      validateUniqueResources();
      audit(
        "批量导入",
        "resource",
        rows.map((r) => r.id).join(","),
        `批量导入${rows.length}台服务器`,
        null,
        rows,
      );
      break;
    }
    case "resource.delete": {
      needAdmin();
      const selected = ids(action.ids, "服务器");
      const rows = selected.map(
        (id) =>
          s.resources.find((r) => r.id === id && !r.deleted) ??
          fail("部分服务器已不存在", 404),
      );
      if (
        s.bookings.some(
          (b) =>
            selected.includes(b.resourceId) &&
            b.status === "scheduled" &&
            b.endAt > now,
        )
      )
        fail("所选服务器还有有效预约，请先取消或释放预约", 409);
      for (const r of rows) {
        const before = { ...r };
        r.deleted = true;
        r.updatedAt = now;
        audit(
          "删除服务器",
          "resource",
          r.id,
          `删除 ${r.name}，保留使用历史`,
          before,
          r,
        );
      }
      break;
    }
    case "group.save": {
      needAdmin();
      const g = s.groups.find((g) => g.id === action.id);
      if (!g) fail("组不存在", 404);
      const before = { ...g };
      g.name = text(action.name, "组名称", 50);
      g.contactName = text(action.contactName ?? "", "接口人姓名", 50, false);
      g.employeeId = text(action.employeeId ?? "", "工号", 50, false);
      if (s.groups.some((x) => x.id !== g.id && x.name === g.name))
        fail("组名称重复");
      audit(
        "修改组信息",
        "group",
        g.id,
        `更新 ${g.name} 接口人信息`,
        before,
        g,
      );
      break;
    }
    case "account.apply": {
      if (!actor.userId) fail("请先登录", 401);
      const g = s.groups.find((g) => g.id === action.groupId);
      if (!g) fail("请选择所属组");
      const employeeId = text(action.employeeId, "工号", 50);
      const displayName = text(action.displayName, "姓名", 50);
      const prev = s.accounts.find((a) => a.userId === actor.userId);
      if (prev?.status === "approved") fail("已认证账号请联系管理员调整权限");
      if (prev?.status === "pending") fail("接口人认证正在审核中");
      const a = {
        id: prev?.id ?? crypto.randomUUID(),
        userId: actor.userId,
        email: actor.email,
        displayName,
        employeeId,
        groupId: g.id,
        role: "contact" as const,
        status: "pending" as const,
        createdAt: now,
      };
      if (prev) s.accounts[s.accounts.indexOf(prev)] = a;
      else s.accounts.push(a);
      audit(
        "申请接口人认证",
        "account",
        a.id,
        `${displayName} 申请成为 ${g.name} 接口人`,
        prev,
        a,
      );
      break;
    }
    case "account.review": {
      needAdmin();
      const a = s.accounts.find((a) => a.id === action.id);
      if (!a || a.status !== "pending") fail("认证申请已被处理或不存在", 409);
      const before = { ...a };
      if (typeof action.approve !== "boolean") fail("审核结果不正确");
      if (
        action.approve &&
        s.accounts.some(
          (x) =>
            x.id !== a.id &&
            x.status === "approved" &&
            x.employeeId === a.employeeId,
        )
      )
        fail("该工号已有认证账号");
      a.status = action.approve ? "approved" : "rejected";
      if (action.approve) {
        const g = s.groups.find((g) => g.id === a.groupId)!;
        g.contactName = a.displayName;
        g.employeeId = a.employeeId;
      }
      audit(
        action.approve ? "通过接口人认证" : "拒绝接口人认证",
        "account",
        a.id,
        `${a.displayName} 的接口人认证${action.approve ? "通过" : "被拒绝"}`,
        before,
        a,
      );
      break;
    }
    case "account.revoke": {
      needAdmin();
      const a = s.accounts.find(
        (a) =>
          a.id === action.id && a.role === "contact" && a.status === "approved",
      );
      if (!a) fail("接口人账号不存在", 404);
      const before = { ...a };
      a.status = "rejected";
      audit(
        "撤销接口人权限",
        "account",
        a.id,
        `撤销 ${a.displayName} 的接口人权限`,
        before,
        a,
      );
      break;
    }
    case "request.create": {
      needContact();
      const groupId = admin ? text(action.groupId, "所属组") : actor.groupId;
      if (!s.groups.some((g) => g.id === groupId)) fail("所属组不存在");
      const resourceIds = ids(action.resourceIds, "服务器");
      for (const id of resourceIds) {
        const r = s.resources.find((r) => r.id === id && !r.deleted);
        if (!r || r.status !== "available")
          fail("部分服务器已删除或维护中，请重新选择", 409);
      }
      const startAt = new Date(
        text(action.startAt, "开始时间", 50),
      ).toISOString();
      const endAt = new Date(text(action.endAt, "结束时间", 50)).toISOString();
      if (endAt <= startAt) fail("结束时间必须晚于开始时间");
      if (startAt < now) fail("开始时间不能早于当前时间");
      if (Date.parse(endAt) - Date.parse(startAt) > 366 * 86400000)
        fail("单次预约最长366天");
      if (!["normal", "high", "urgent"].includes(action.priority as string))
        fail("任务优先级不正确");
      const r: UsageRequest = {
        id: crypto.randomUUID(),
        groupId,
        resourceIds,
        startAt,
        endAt,
        purpose: text(action.purpose, "任务用途", 1000),
        priority: action.priority as Priority,
        status: "pending",
        applicantId: actor.userId,
        applicantName: actor.displayName,
        createdAt: now,
        reviewedAt: "",
        reviewer: "",
        reviewNote: "",
      };
      s.requests.push(r);
      audit(
        "提交使用申请",
        "request",
        r.id,
        `${s.groups.find((g) => g.id === groupId)!.name} 申请${resourceIds.length}台服务器：${r.purpose}`,
        null,
        r,
      );
      break;
    }
    case "request.review": {
      needAdmin();
      const r = findRequest();
      if (r.status !== "pending") fail("该申请已处理，请刷新", 409);
      const before = { ...r };
      if (typeof action.approve !== "boolean") fail("审批结果不正确");
      const note = text(action.note ?? "", "审批说明", 1000, false);
      if (!action.approve && !note) fail("拒绝申请请填写原因");
      if (action.approve) {
        if (r.startAt < now) fail("该申请开始时间已过，请重新申请", 409);
        for (const id of r.resourceIds) {
          const resource = s.resources.find((x) => x.id === id && !x.deleted);
          if (!resource || resource.status !== "available")
            fail("服务器已删除或维护中", 409);
        }
        const conflicts = s.bookings.filter(
          (b) =>
            b.status === "scheduled" &&
            r.resourceIds.includes(b.resourceId) &&
            overlaps(b, r),
        );
        if (conflicts.length) {
          if (action.preempt !== true)
            fail(
              `与${conflicts.length}条已批准预约冲突；如为更高优先级任务，请明确确认抢占`,
              409,
            );
          if (!note) fail("抢占预约必须填写原因");
          if (
            conflicts.some(
              (b) => priorityRank[b.priority] >= priorityRank[r.priority],
            )
          )
            fail("只能抢占优先级低于当前任务的预约", 409);
          for (const b of conflicts) {
            const old = { ...b };
            b.status = "preempted";
            b.updatedAt = now;
            if (b.startAt < r.startAt)
              s.bookings.push({
                ...old,
                id: crypto.randomUUID(),
                endAt: r.startAt,
                parentId: b.id,
                updatedAt: now,
              });
            if (b.endAt > r.endAt)
              s.bookings.push({
                ...old,
                id: crypto.randomUUID(),
                startAt: r.endAt,
                parentId: b.id,
                updatedAt: now,
              });
            audit(
              "高优任务抢占",
              "booking",
              b.id,
              `${s.resources.find((x) => x.id === b.resourceId)!.name} 被更高优任务抢占：${note}`,
              old,
              b,
            );
          }
        }
        for (const resourceId of r.resourceIds)
          s.bookings.push({
            id: crypto.randomUUID(),
            requestId: r.id,
            resourceId,
            groupId: r.groupId,
            startAt: r.startAt,
            endAt: r.endAt,
            purpose: r.purpose,
            priority: r.priority,
            status: "scheduled",
            parentId: "",
            createdAt: now,
            updatedAt: now,
          });
      }
      r.status = action.approve ? "approved" : "rejected";
      r.reviewedAt = now;
      r.reviewer = actor.displayName;
      r.reviewNote = note;
      audit(
        action.approve ? "批准申请" : "拒绝申请",
        "request",
        r.id,
        `${action.approve ? "批准" : "拒绝"} ${r.applicantName} 的使用申请${note ? `：${note}` : ""}`,
        before,
        r,
      );
      break;
    }
    case "request.cancel": {
      needContact();
      const r = findRequest();
      owned(r);
      if (!["pending", "approved"].includes(r.status))
        fail("该申请已经结束", 409);
      const note = text(action.note ?? "", "取消说明", 1000, false);
      const before = { ...r };
      const future = s.bookings.filter(
        (b) =>
          b.requestId === r.id && b.status === "scheduled" && b.endAt > now,
      );
      if (r.status === "approved" && !future.length)
        fail("该申请已经全部结束", 409);
      r.status = "cancelled";
      for (const b of future) {
        const old = { ...b };
        if (b.startAt < now) {
          b.endAt = now;
          b.status = "released";
        } else b.status = "cancelled";
        b.updatedAt = now;
        audit(
          b.status === "released" ? "提前释放" : "取消预约",
          "booking",
          b.id,
          `${b.status === "released" ? "提前释放" : "取消"} ${s.resources.find((x) => x.id === b.resourceId)?.name} 的占用${note ? `：${note}` : ""}`,
          old,
          b,
        );
      }
      audit(
        "取消申请",
        "request",
        r.id,
        `取消 ${r.applicantName} 的申请${note ? `：${note}` : ""}`,
        before,
        r,
      );
      break;
    }
    default:
      fail("未知操作");
  }
  s.revision++;
  return s;
}
export function serializePublic(
  s: State,
  actor: Actor,
  now: string,
  adminConfigured: boolean,
) {
  return {
    ...s,
    accounts:
      actor.role === "admin"
        ? s.accounts
        : s.accounts.filter((a) => a.userId === actor.userId),
    requests: s.requests.map((r) => ({
      ...r,
      applicantId:
        actor.role === "admin" || r.groupId === actor.groupId
          ? r.applicantId
          : "",
    })),
    audits: s.audits
      .filter((a) => actor.role === "admin" || a.entityType !== "account")
      .map((a) =>
        actor.role === "admin"
          ? a
          : { ...a, actorId: "", before: "", after: "" },
      ),
    actor,
    now,
    adminConfigured,
  };
}
