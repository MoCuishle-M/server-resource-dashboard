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
import { lingshuStatusLabels, platformGroup, PLATFORM_GROUP_ID, resourceLingshuStatus } from "./lingshu";
import { partialCancellationPlan } from "./booking-adjustment";
import { extensionResourceIds } from "./request-extension";
import { resourceStatusLabels, visibleResourceState } from "./resource-policy";
import { applyWeeklyAction, visibleWeeklyState } from "./weekly-actions";
import { applyWeeklyTableAction } from "./weekly-table-actions";
import { bookingAvailability, displacesBooking, priorityLabel, priorityRank } from "./priority";
import { priorityAdjustmentPlan } from "./priority-adjustment";
import { currentGroupContacts } from "./group-contact";
export { priorityLabel, priorityRank } from "./priority";
export class DomainError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
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
    groups: [...Array.from({ length: 10 }, (_, i) => ({
      id: `g${i + 1}`,
      name: `${String(i + 1).padStart(2, "0")}组`,
      contactName: "",
      employeeId: "",
    })), platformGroup()],
    accounts: [],
    requests: [],
    bookings: [],
    audits: [],
    settings: { announcement: "", authorSignature: "" },
    invitations: [],
    weeklyPlans: [],
    weeklyDemands: [],
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
    (b) => b.status === "scheduled" && b.startAt <= now && b.endAt > now &&
      (resourceSharingMode(s.resources.find(r => r.id === b.resourceId)) !== "shared" ||
        !s.bookings.some(other => other.resourceId === b.resourceId && other.status === "scheduled"
          && other.startAt <= now && other.endAt > now && priorityRank[other.priority] > priorityRank[b.priority])),
  );
}
export function resourceSharingMode(resource?: Pick<Resource, "sharingMode">) {
  return resource?.sharingMode ?? "exclusive";
}
export function approvalConflicts(s: State, request: UsageRequest, notBefore?: string) {
  const range = notBefore && request.startAt < notBefore ? { ...request, startAt: notBefore } : request;
  if (range.endAt <= range.startAt) return [];
  return s.bookings.filter(
    (b) =>
      b.status === "scheduled" &&
      request.resourceIds.includes(b.resourceId) &&
      (resourceSharingMode(s.resources.find((r) => r.id === b.resourceId)) === "exclusive" ||
        (priorityRank[b.priority] < priorityRank[request.priority] && displacesBooking(b, s.bookings, range))) &&
      overlaps(b, range),
  );
}
export function currentResourceUsage(
  s: State,
  resourceId: string,
  now: string,
) {
  const bookings = activeBookings(s, now).filter(
    (b) => b.resourceId === resourceId,
  );
  return {
    bookings,
    groupIds: [...new Set(bookings.map((b) => b.groupId))],
    releaseAt: bookings
      .map((b) => b.endAt)
      .sort()
      .at(-1),
  };
}
export function groupUsage(s: State, groupId: string, now: string) {
  const count = new Set(
    activeBookings(s, now)
      .filter((b) => b.groupId === groupId)
      .map((b) => b.resourceId),
  ).size;
  const byResource = new Map<string, { start: number; end: number }[]>();
  for (const b of s.bookings) {
    if (
      b.groupId !== groupId ||
      !["scheduled", "released"].includes(b.status) ||
      b.startAt >= now
    )
      continue;
    const ranges = byResource.get(b.resourceId) ?? [];
    for (const segment of bookingAvailability(b, s.bookings,
      resourceSharingMode(s.resources.find(r => r.id === b.resourceId)) === "shared")) {
      if (!segment.blockedBy.length && segment.startAt < now) ranges.push({
        start: Date.parse(segment.startAt), end: Math.min(Date.parse(segment.endAt), Date.parse(now)),
      });
    }
    byResource.set(b.resourceId, ranges);
  }
  let elapsed = 0;
  for (const ranges of byResource.values()) {
    ranges.sort((a, b) => a.start - b.start);
    let start = 0,
      end = 0;
    for (const r of ranges) {
      if (r.start > end) {
        elapsed += end - start;
        start = r.start;
        end = r.end;
      } else end = Math.max(end, r.end);
    }
    elapsed += end - start;
  }
  return { count, hours: elapsed / 3600000 };
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
export function ipValid(ip: string) {
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
    if (!admin && r.resourceIds.some(id => s.resources.some(resource => resource.id === id && resource.hidden)))
      fail("该申请需要由管理员处理", 403);
  }
  function validateExtension(r: UsageRequest, endAt: string, resourceIds: string[]) {
    const startAt = r.endAt > now ? r.endAt : now;
    if (r.status !== "approved") fail("只能延长已批准的申请", 409);
    if (endAt <= r.endAt || endAt <= now) fail("新的结束时间必须晚于原结束时间和当前时间");
    if (Date.parse(endAt) - Date.parse(r.startAt) > 366 * 86400000) fail("单次预约最长366天");
    const eligible = extensionResourceIds(r, s.bookings, now, true);
    if (!resourceIds.length || resourceIds.some(id => !eligible.includes(id)))
      fail("部分服务器的末段预约已取消或被抢占，请重新提交续期申请", 409);
    for (const id of resourceIds) {
      const resource = s.resources.find(x => x.id === id && !x.deleted);
      if (!resource || resource.status !== "available") fail("部分服务器故障、维护中、不可用或已删除，无法续期", 409);
      if (s.bookings.some(b => b.resourceId === id && b.requestId !== r.id
        && b.status === "scheduled" && overlaps(b, { startAt, endAt })
        && (resourceSharingMode(resource) === "exclusive" || priorityRank[b.priority] !== priorityRank[r.priority])))
        fail(`${resource.name} 在延长时段已有预约，请调整结束时间或先协调资源`, 409);
    }
    return { startAt, resourceIds };
  }
  function applyExtension(r: UsageRequest, endAt: string, resourceIds: string[], note = "") {
    const range = validateExtension(r, endAt, resourceIds);
    const before = structuredClone(r);
    const tails = s.bookings.filter(b => b.requestId === r.id && resourceIds.includes(b.resourceId)
      && b.status === "scheduled" && b.endAt === r.endAt);
    for (const b of tails) {
      if (r.endAt >= now) Object.assign(b, { endAt, updatedAt: now });
      else s.bookings.push({ ...b, id: crypto.randomUUID(), parentId: b.id, startAt: range.startAt,
        endAt, createdAt: now, updatedAt: now });
    }
    r.endAt = endAt;
    delete r.pendingExtension;
    audit("延长服务器使用", "request", [r.id, ...resourceIds].join(","),
      `${r.purpose}：${resourceIds.length}台服务器延长至${endAt}${note ? `：${note}` : ""}`, before, r);
  }
  function resourceInput(value: unknown, previous?: Resource): Resource {
    const v = value as Record<string, unknown>;
    if (!v || typeof v !== "object") fail("服务器数据格式不正确");
    const ip = text(v.ip, "IP", 64);
    if (!ipValid(ip)) fail(`IP地址格式不正确：${ip}`);
    if (!["bare", "lingshu"].includes(v.accessMode as string))
      fail("请选择裸机或灵枢平台");
    const lingshuStatus = v.lingshuStatus ?? resourceLingshuStatus(previous) ?? "platform";
    if (v.accessMode === "lingshu" && !Object.hasOwn(lingshuStatusLabels, String(lingshuStatus)))
      fail("灵枢平台状态不正确");
    if (v.accessMode === "bare" && v.lingshuStatus) fail("灵枢平台状态仅适用于使用方式为灵枢平台的服务器");
    if (!Object.hasOwn(resourceStatusLabels, String(v.status)))
      fail("资源状态不正确");
    if (v.hidden !== undefined && typeof v.hidden !== "boolean") fail("隐藏设置应为是或否");
    const sharingMode =
      v.sharingMode === undefined
        ? resourceSharingMode(previous)
        : v.sharingMode;
    if (!["exclusive", "shared"].includes(sharingMode as string))
      fail("占用模式应为独占或共享");
    if (![undefined, "", "green", "blue"].includes(v.zone as string | undefined)) fail("区域应为绿区或蓝区");
    if (![undefined, "", "A3", "A5"].includes(v.family as string | undefined)) fail("排期型号应为A3或A5");
    return {
      id: previous?.id ?? crypto.randomUUID(),
      name: text(v.name, "服务器名称", 80),
      type: text(v.type, "服务器类型", 80),
      ip,
      accessMode: v.accessMode as Resource["accessMode"],
      ...(v.accessMode === "lingshu" ? { lingshuStatus: lingshuStatus as Resource["lingshuStatus"] } : {}),
      sharingMode: sharingMode as Resource["sharingMode"],
      status: v.status as Resource["status"],
      ...(v.status === "fault" ? { faultDescription: text(v.faultDescription ?? previous?.faultDescription ?? "", "故障说明", 1000) } : {}),
      hidden: v.hidden === undefined ? previous?.hidden ?? false : v.hidden,
      location: text(v.location ?? "", "位置", 100, false),
      zone: text(v.zone ?? previous?.zone ?? "", "区域", 10, false) as Resource["zone"],
      family: text(v.family ?? previous?.family ?? "", "排期型号", 10, false) as Resource["family"],
      rack: text(v.rack ?? previous?.rack ?? "", "机柜", 80, false),
      note: text(v.note ?? "", "备注", 1000, false),
      deleted: false,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };
  }
  function validateResourceChange(previous: Resource, r: Resource) {
    if (
      resourceSharingMode(previous) === "shared" &&
      r.sharingMode === "exclusive"
    ) {
      const future = s.bookings
        .filter(
          (b) =>
            b.resourceId === r.id && b.status === "scheduled" && b.endAt > now,
        )
        .sort((a, b) => a.startAt.localeCompare(b.startAt));
      if (
        future.some(
          (b, i) =>
            i > 0 && future.slice(0, i).some((other) => overlaps(other, b)),
        )
      )
        fail(
          "该服务器还有重叠的共享预约，请先取消或释放冲突预约再改为独占",
          409,
        );
    }
    if (
      !["available", "fault"].includes(r.status) &&
      s.bookings.some(
        (b) =>
          b.resourceId === r.id && b.status === "scheduled" && b.endAt > now,
      )
    )
      fail(`该服务器还有有效预约，请先取消或释放预约再设为${resourceStatusLabels[r.status]}`, 409);
  }
  const editableFields = [
    "name",
    "type",
    "accessMode",
    "lingshuStatus",
    "sharingMode",
    "location",
    "note",
    "faultDescription",
    "status",
    "hidden",
    "zone",
    "family",
    "rack",
  ];
  function checkedChanges(value: unknown) {
    if (!value || typeof value !== "object" || Array.isArray(value))
      fail("批量修改字段格式不正确");
    const changes = value as Record<string, unknown>;
    if (!Object.keys(changes).length) fail("至少选择一个要修改的字段");
    if (Object.keys(changes).some((key) => !editableFields.includes(key)))
      fail("批量修改不允许修改IP或其他系统字段");
    return changes;
  }
  function saveBulkRows(
    rows: { previous: Resource; changes: Record<string, unknown> }[],
    templateNames = false,
  ) {
    const updated = rows.map(({ previous, changes }, index) => {
      const values = { ...changes };
      if (templateNames && typeof values.name === "string")
        values.name = values.name.replace(/\{(name|ip|index)\}/g, (_, key) =>
          key === "name"
            ? previous.name
            : key === "ip"
              ? previous.ip
              : String(index + 1),
        );
      const merged = { ...previous, ...values, ip: previous.ip };
      if (merged.accessMode === "bare" && !("lingshuStatus" in values)) delete merged.lingshuStatus;
      const resource = resourceInput(merged, previous);
      validateResourceChange(previous, resource);
      return { previous, resource };
    });
    for (const { previous, resource } of updated)
      s.resources[s.resources.findIndex((r) => r.id === previous.id)] =
        resource;
    validateUniqueResources();
    for (const { previous, resource } of updated)
      audit(
        "批量修改服务器",
        "resource",
        resource.id,
        `批量修改 ${resource.name}（${resource.ip}）`,
        previous,
        resource,
      );
  }
  function validateUniqueResources() {
    const live = s.resources.filter((r) => !r.deleted);
    if (new Set(live.map((r) => r.ip.toLowerCase())).size !== live.length)
      fail("IP地址重复，请检查已有资源及导入表格");
    if (new Set(live.map((r) => r.name)).size !== live.length)
      fail("服务器名称重复");
  }
  if (action.type.startsWith("weekly.")) {
    if (action.type.startsWith("weekly.table.")) applyWeeklyTableAction(s, actor, action, now, { fail, audit });
    else applyWeeklyAction(s, actor, action, now, { fail, audit });
    s.revision++;
    return s;
  }
  switch (action.type) {
    case "site.settings": {
      needAdmin();
      const before = { ...s.settings };
      s.settings = {
        ...s.settings,
        announcement: text(action.announcement ?? "", "公告内容", 4000, false),
        authorSignature: text(action.authorSignature ?? "", "作者签名", 200, false),
      };
      audit("修改网站信息", "settings", "main", "更新公告栏与作者签名", before, s.settings);
      break;
    }
    case "admin.invite": {
      needAdmin();
      const email = text(action.email, "登录邮箱", 254).toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail("请输入有效的登录邮箱");
      const displayName = text(action.displayName ?? "", "管理员姓名", 50, false);
      const account = s.accounts.find(a => a.email.toLowerCase() === email && a.userId);
      if (account?.role === "admin" && account.status === "approved") fail("该账号已经是管理员");
      if (s.invitations.some(i => i.email === email && i.status === "pending")) fail("该邮箱已有待接受的管理员邀请");
      if (account) {
        const before = { ...account };
        account.role = "admin";
        account.status = "approved";
        if (displayName) account.displayName = displayName;
        audit("新增管理员", "account", account.id, `授予 ${account.displayName} 管理员权限`, before, account);
      } else {
        const invitation = { id: crypto.randomUUID(), email, displayName, status: "pending" as const, createdAt: now };
        s.invitations.push(invitation);
        audit("邀请管理员", "account", invitation.id, `邀请 ${displayName || email} 成为管理员`, null, invitation);
      }
      break;
    }
    case "admin.cancelInvitation": {
      needAdmin();
      const invitation = s.invitations.find(i => i.id === action.id && i.status === "pending");
      if (!invitation) fail("待接受的邀请不存在", 404);
      const before = { ...invitation };
      invitation.status = "cancelled";
      audit("取消管理员邀请", "account", invitation.id, "取消管理员邀请", before, invitation);
      break;
    }
    case "admin.revoke": {
      needAdmin();
      const account = s.accounts.find(a => a.id === action.id && a.role === "admin" && a.status === "approved");
      if (!account) fail("管理员账号不存在", 404);
      if (s.accounts.filter(a => a.role === "admin" && a.status === "approved").length <= 1) fail("至少保留一位管理员");
      if (account.userId === actor.userId) fail("不能撤销自己的管理员权限");
      const before = { ...account };
      account.status = "rejected";
      audit("撤销管理员权限", "account", account.id, `撤销 ${account.displayName} 的管理员权限`, before, account);
      break;
    }
    case "resource.fault": {
      needAdmin();
      const previous = s.resources.find(r => r.id === action.id && !r.deleted);
      if (!previous) fail("服务器不存在", 404);
      const r = resourceInput({ ...previous, status: "fault", faultDescription: action.description }, previous);
      s.resources[s.resources.indexOf(previous)] = r;
      audit("标记服务器故障", "resource", r.id, `${r.name} 故障：${r.faultDescription}`, previous, r);
      break;
    }
    case "resource.recover": {
      needAdmin();
      const previous = s.resources.find(r => r.id === action.id && !r.deleted);
      if (!previous || previous.status !== "fault") fail("服务器当前不是故障状态，请刷新", 409);
      const r = resourceInput({ ...previous, status: "available" }, previous);
      s.resources[s.resources.indexOf(previous)] = r;
      audit("服务器故障恢复", "resource", r.id, `${r.name} 已恢复可申请`, previous, r);
      break;
    }
    case "resource.save": {
      needAdmin();
      const existing = action.id
        ? s.resources.find((r) => r.id === action.id && !r.deleted)
        : undefined;
      if (action.id && !existing) fail("服务器不存在", 404);
      const r = resourceInput(action.resource, existing);
      if (existing) validateResourceChange(existing, r);
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
    case "resource.bulkUpdate": {
      needAdmin();
      const selected = ids(action.ids, "服务器");
      const changes = checkedChanges(action.changes);
      const rows = selected.map((id) => ({
        previous:
          s.resources.find((r) => r.id === id && !r.deleted) ??
          fail("部分服务器已不存在", 404),
        changes,
      }));
      saveBulkRows(rows, true);
      break;
    }
    case "resource.updateByIp": {
      needAdmin();
      if (
        !Array.isArray(action.rows) ||
        !action.rows.length ||
        action.rows.length > 200
      )
        fail("每批更新1至200行");
      const seen = new Set<string>();
      const rows = action.rows.map((value: unknown) => {
        if (!value || typeof value !== "object" || Array.isArray(value))
          fail("更新表格格式不正确");
        const { ip, ...fields } = value as Record<string, unknown>;
        const address = text(ip, "IP", 64);
        if (seen.has(address.toLowerCase())) fail(`更新表格IP重复：${address}`);
        seen.add(address.toLowerCase());
        const previous = s.resources.find(
          (r) => !r.deleted && r.ip.toLowerCase() === address.toLowerCase(),
        );
        if (!previous)
          fail(`未找到IP为 ${address} 的服务器，整批更新已取消`, 404);
        return { previous, changes: checkedChanges(fields) };
      });
      saveBulkRows(rows);
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
      if (g.id === PLATFORM_GROUP_ID && action.name !== "灵枢平台") fail("灵枢平台名称固定，可修改接口人信息");
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
      if (prev?.role === "admin" && prev.status !== "approved") fail("管理员身份已撤销，请联系现有管理员调整权限");
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
    case "account.update": {
      needAdmin();
      const a = s.accounts.find((a) => a.id === action.id && a.role === "contact");
      if (!a) fail("接口人账号不存在", 404);
      const before = { ...a };
      const g = s.groups.find((g) => g.id === action.groupId);
      if (!g) fail("请选择所属组");
      const displayName = text(action.displayName, "姓名", 50);
      const employeeId = text(action.employeeId, "工号", 50);
      if (a.status === "approved" && s.accounts.some((x) => x.id !== a.id && x.status === "approved" && x.employeeId === employeeId))
        fail("该工号已有认证账号");
      if (a.status === "approved") {
        // Clear only the old matching profile before moving this active contact.
        s.groups = currentGroupContacts({ ...s, accounts: s.accounts.map((x) => x.id === a.id ? { ...x, status: "rejected" } : x) });
      }
      Object.assign(a, { displayName, employeeId, groupId: g.id });
      if (a.status === "approved") {
        const target = s.groups.find((group) => group.id === g.id)!;
        target.contactName = a.displayName;
        target.employeeId = a.employeeId;
      }
      audit("更正接口人资料", "account", a.id, `更正 ${before.displayName} 的姓名、工号或所属组`, before, a);
      break;
    }
    case "account.restore":
    case "account.review": {
      needAdmin();
      const a = s.accounts.find((a) => a.id === action.id);
      const restore = action.type === "account.restore";
      if (!a || a.role !== "contact" || a.status !== (restore ? "rejected" : "pending")) fail("认证申请已被处理或不存在", 409);
      const before = { ...a };
      const approve = restore || action.approve;
      if (typeof approve !== "boolean") fail("审核结果不正确");
      if (
        approve &&
        s.accounts.some(
          (x) =>
            x.id !== a.id &&
            x.status === "approved" &&
            x.employeeId === a.employeeId,
        )
      )
        fail("该工号已有认证账号");
      a.status = approve ? "approved" : "rejected";
      if (approve) {
        const g = s.groups.find((g) => g.id === a.groupId)!;
        g.contactName = a.displayName;
        g.employeeId = a.employeeId;
      }
      audit(
        restore ? "重新授予接口人权限" : approve ? "通过接口人认证" : "拒绝接口人认证",
        "account",
        a.id,
        restore ? `重新授予 ${a.displayName} 在 ${s.groups.find((g) => g.id === a.groupId)!.name} 的接口人权限` : `${a.displayName} 的接口人认证${approve ? "通过" : "被拒绝"}`,
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
      s.groups = currentGroupContacts(s);
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
        if (!r || (r.hidden && !admin)) fail("部分服务器不存在或不可见，请重新选择", 409);
        if (r.status !== "available")
          fail("部分服务器维护中或不可用，请重新选择", 409);
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
        if (r.endAt <= now) fail("该申请结束时间已过，无法批准，请重新申请", 409);
        const effectiveStart = r.startAt < now ? now : r.startAt;
        for (const id of r.resourceIds) {
          const resource = s.resources.find((x) => x.id === id && !x.deleted);
          if (!resource || resource.status !== "available")
            fail("服务器已删除、维护中或不可用", 409);
        }
        const conflicts = approvalConflicts(s, r, effectiveStart);
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
            if (resourceSharingMode(s.resources.find(x => x.id === b.resourceId)) === "shared") {
              audit("高优任务抢占", "booking", b.id,
                `${s.resources.find(x => x.id === b.resourceId)!.name}：低优排期保留，重叠时段暂不可用：${note}`,
                old, { booking: b, blockedByRequestId: r.id, startAt: effectiveStart > b.startAt ? effectiveStart : b.startAt,
                  endAt: r.endAt < b.endAt ? r.endAt : b.endAt });
              continue;
            }
            b.status = "preempted";
            b.updatedAt = now;
            if (b.startAt < effectiveStart)
              s.bookings.push({
                ...old,
                id: crypto.randomUUID(),
                endAt: effectiveStart,
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
            startAt: effectiveStart,
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
    case "request.extend": {
      needContact();
      const r = findRequest();
      owned(r);
      if (r.status !== "approved" || r.endAt <= now) fail("原预约已结束或尚未批准，请重新申请", 409);
      if (!admin && r.pendingExtension) fail("已有待审批续期申请，请等待管理员处理", 409);
      const endAt = new Date(text(action.endAt, "新的结束时间", 64)).toISOString();
      const resourceIds = extensionResourceIds(r, s.bookings, now, false, s.resources);
      validateExtension(r, endAt, resourceIds);
      const note = text(action.note ?? "", "续期说明", 1000, false);
      if (admin) applyExtension(r, endAt, resourceIds, note);
      else {
        const before = structuredClone(r);
        r.pendingExtension = { id: crypto.randomUUID(), originalEndAt: r.endAt, endAt, resourceIds,
          applicantId: actor.userId, applicantName: actor.displayName, requestedAt: now, note };
        audit("提交续期申请", "request", [r.id, ...resourceIds].join(","), `${r.purpose} 申请延长至${endAt}${note ? `：${note}` : ""}`, before, r);
      }
      break;
    }
    case "request.reviewExtension": {
      needAdmin();
      const r = findRequest(), extension = r.pendingExtension;
      if (!extension || extension.id !== action.extensionId) fail("续期申请已处理或发生变化，请刷新", 409);
      if (typeof action.approve !== "boolean") fail("审批结果不正确");
      const note = text(action.note ?? "", "续期审批说明", 1000, false);
      if (!action.approve && !note) fail("拒绝续期请填写原因");
      const before = structuredClone(r);
      if (action.approve) {
        if (r.endAt !== extension.originalEndAt) fail("原预约已发生变化，请重新提交续期申请", 409);
        applyExtension(r, extension.endAt, extension.resourceIds, note);
      } else delete r.pendingExtension;
      audit(action.approve ? "批准续期申请" : "拒绝续期申请", "request", [r.id, ...extension.resourceIds].join(","),
        `${r.purpose} 续期${action.approve ? "批准" : "拒绝"}${note ? `：${note}` : ""}`, before, r);
      break;
    }
    case "request.changePriority": {
      needAdmin();
      const r = findRequest();
      if (r.status !== "approved" || r.endAt <= now) fail("只能调整尚未结束的已批准排期", 409);
      if (r.pendingExtension) fail("请先处理待审批续期申请，再调整优先级", 409);
      if (!["normal", "high", "urgent"].includes(action.priority as string)) fail("优先级不正确");
      const priority = action.priority as Priority;
      if (r.priority === priority) fail("优先级未发生变化");
      const resourceIds = ids(action.resourceIds, "需要调整的服务器");
      if (resourceIds.some(id => !r.resourceIds.includes(id))) fail("只能调整该申请中的服务器");
      if (resourceIds.some(id => !s.resources.some(resource => resource.id === id && !resource.deleted)))
        fail("部分服务器已删除，请刷新后重试", 409);
      if (resourceIds.some(id => !s.bookings.some(b => b.requestId === r.id && b.resourceId === id && b.status === "scheduled" && b.endAt > now)))
        fail("部分服务器已无剩余排期，请重新选择", 409);
      const note = text(action.note, "调整原因", 1000);
      if (action.confirm !== true) fail("请确认优先级调整及使用权变化", 409);
      const before = structuredClone(r);
      const selected = new Set(resourceIds);
      const bookings = s.bookings.filter(b => b.requestId === r.id && selected.has(b.resourceId));
      const oldBookings = structuredClone(bookings);
      const plan = priorityAdjustmentPlan(s.bookings, r.id, resourceIds, priority, now);
      if (!plan.length) fail("所选服务器已无可调整的排期", 409);
      let target = r;
      if (resourceIds.length < r.resourceIds.length) {
        target = { ...r, id: crypto.randomUUID(), sourceRequestId: r.sourceRequestId ?? r.id,
          resourceIds: r.resourceIds.filter(id => selected.has(id)) };
        r.resourceIds = r.resourceIds.filter(id => !selected.has(id));
        s.requests.push(target);
        for (const b of bookings) b.requestId = target.id;
      }
      target.priority = priority;
      for (const { booking: b, startAt } of plan) {
        if (b.startAt < now) {
          const future = { ...b, id: crypto.randomUUID(), startAt, priority, parentId: b.id, createdAt: now, updatedAt: now };
          b.endAt = now;
          b.updatedAt = now;
          s.bookings.push(future);
        } else Object.assign(b, { priority, updatedAt: now });
      }
      audit("调整排期优先级", "request", [...new Set([r.id, target.id, ...resourceIds])].join(","),
        `${target.purpose}：${resourceIds.length}台服务器优先级 ${priorityLabel[before.priority]} → ${priorityLabel[priority]}，从调整时刻起作用于剩余排期：${note}`,
        { request: before, bookings: oldBookings }, { source: r, request: target, effectiveAt: now,
          bookings: s.bookings.filter(b => b.requestId === target.id && selected.has(b.resourceId)), note });
      break;
    }
    case "request.reassign": {
      needAdmin();
      const r = findRequest();
      if (r.pendingExtension) fail("请先处理待审批续期申请，再调整使用组和事项", 409);
      if (!["pending", "approved"].includes(r.status) || r.endAt <= now)
        fail("只能调整尚未结束的待审批或已批准申请", 409);
      const resourceIds = ids(action.resourceIds, "需要调整的服务器");
      if (resourceIds.some(id => !r.resourceIds.includes(id)))
        fail("只能调整该申请中的服务器");
      if (resourceIds.some(id => !s.resources.some(resource => resource.id === id && !resource.deleted)))
        fail("部分服务器已删除，请刷新后重试", 409);
      if (r.status === "approved" && resourceIds.some(id => !s.bookings.some(b =>
        b.requestId === r.id && b.resourceId === id && b.status === "scheduled" && b.endAt > now)))
        fail("部分服务器已无剩余有效预约，请重新选择", 409);
      const groupId = text(action.groupId, "使用组");
      if (!s.groups.some(g => g.id === groupId)) fail("使用组不存在");
      const purpose = text(action.purpose, "使用事项", 1000);
      if (groupId === r.groupId && purpose === r.purpose) fail("使用组和事项未发生变化");
      const before = structuredClone(r);
      const selected = new Set(resourceIds);
      const bookings = s.bookings.filter(b => b.requestId === r.id && selected.has(b.resourceId));
      const oldBookings = structuredClone(bookings);
      let target = r;
      if (resourceIds.length < r.resourceIds.length) {
        target = { ...r, id: crypto.randomUUID(), sourceRequestId: r.sourceRequestId ?? r.id,
          resourceIds: r.resourceIds.filter(id => selected.has(id)) };
        r.resourceIds = r.resourceIds.filter(id => !selected.has(id));
        s.requests.push(target);
      }
      target.groupId = groupId;
      target.purpose = purpose;
      // This corrects the allocation for the original application period. Preserve every
      // interval, booking identity and cancellation/preemption state, including split tails.
      for (const b of bookings) Object.assign(b, {
        requestId: target.id, groupId, purpose, updatedAt: now,
      });
      audit("调整使用组与事项", "request", [...new Set([r.id, target.id, ...resourceIds])].join(","),
        `${resourceIds.length}台服务器调整至${s.groups.find(g => g.id === groupId)!.name}：${purpose}${target !== r ? "（从原申请拆分）" : ""}`,
        { request: before, bookings: oldBookings },
        { source: r, request: target, bookings });
      break;
    }
    case "request.cancelPartial": {
      needContact();
      const r = findRequest();
      owned(r);
      if (r.status !== "approved") fail("只能调整已批准的申请", 409);
      const note = text(action.note, "取消原因", 1000);
      const resourceIds = ids(action.resourceIds, "需要调整的服务器");
      if (resourceIds.some(id => !r.resourceIds.includes(id))) fail("只能调整该申请中的服务器");
      const start = Date.parse(text(action.startAt, "取消开始时间", 64));
      const end = Date.parse(text(action.endAt, "取消结束时间", 64));
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
        fail("取消结束时间必须晚于开始时间");
      if (start < Date.parse(now)) fail("不能取消已经过去的时间段");
      if (start < Date.parse(r.startAt) || end > Date.parse(r.endAt))
        fail("取消时间必须在原申请范围内");
      const plan = partialCancellationPlan(s.bookings, r.id, resourceIds, {
        startAt: new Date(start).toISOString(), endAt: new Date(end).toISOString(),
      });
      if (!plan.length) fail("所选时间内没有可取消的有效预约，请刷新后重试", 409);
      const before = { ...r };
      for (const { booking: b, cancelled, retained } of plan) {
        const old = { ...b };
        // Preserve only the cancelled intersection as history; the tails remain active.
        Object.assign(b, cancelled, { status: "cancelled", updatedAt: now });
        const tails = retained.map(range => ({
          ...old, ...range, id: crypto.randomUUID(), parentId: b.id,
          createdAt: now, updatedAt: now,
        }));
        s.bookings.push(...tails);
        audit("取消部分时段", "booking", b.id,
          `${s.resources.find(x => x.id === b.resourceId)?.name} 取消 ${new Date(Date.parse(cancelled.startAt) + 8 * 3600000).toISOString().slice(0, 16).replace("T", " ")} 至 ${new Date(Date.parse(cancelled.endAt) + 8 * 3600000).toISOString().slice(0, 16).replace("T", " ")}（北京时间）：${note}`,
          old, { cancelled: b, retained: tails });
      }
      if (!s.bookings.some(b => b.requestId === r.id && b.status === "scheduled" && b.endAt > now)) {
        r.status = "cancelled";
        delete r.pendingExtension;
        audit("取消申请", "request", r.id, `剩余预约已全部取消：${note}`, before, r);
      }
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
      delete r.pendingExtension;
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
  const weekly = visibleWeeklyState(s, actor);
  s = visibleResourceState(s, actor);
  return {
    ...s,
    ...weekly,
    groups: currentGroupContacts(s),
    settings: actor.role === "admin" ? s.settings : { announcement: s.settings.announcement, authorSignature: s.settings.authorSignature },
    invitations: actor.role === "admin" ? s.invitations : [],
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
      .filter((a) => actor.role === "admin" || !["account", "weekly"].includes(a.entityType))
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
