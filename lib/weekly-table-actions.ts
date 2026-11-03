import type { Action, Actor, State, WeeklyDemand, WeeklyLine, WeeklyPlan, WeeklyServerRow } from "./types";
import { calendarRange, weeklyPlanRange } from "./schedule";
import { checkTablePlan, clearFutureSchedules, inheritedTableRows, recommendTableRows, tableAllocations, tableDemands, tableGroups, tableRows } from "./weekly-table";

type Helpers = { fail: (message: string, status?: number) => never; audit: (kind: string, entityType: string, entityId: string, summary: string, before?: unknown, after?: unknown) => void };
export function applyWeeklyTableAction(s: State, actor: Actor, a: Action, now: string, { fail, audit }: Helpers) {
  const admin = actor.role === "admin";
  const needAdmin = () => { if (!admin) fail("仅服务器管理员可以执行此操作", 403); };
  if (!actor.userId || (!admin && actor.role !== "contact")) fail("请先登录并通过组接口人认证", 403);
  const str = (v: unknown, label: string, max = 1000, required = true) => { if (typeof v !== "string" || v.trim().length > max || (required && !v.trim())) fail(`请填写有效的${label}`); return (v as string).trim(); };
  const ids = (v: unknown): string[] => { if (!Array.isArray(v) || v.length > 200 || v.some(x => typeof x !== "string") || new Set(v).size !== v.length) fail("清单格式不正确"); return v as string[]; };
  const num = (v: unknown, max: number, label: string, min = 0) => { if (!Number.isInteger(v) || Number(v) < min || Number(v) > max) fail(`${label}应为${min}至${max}的整数`); return Number(v); };
  const validResourceIds = (v: unknown, allowHidden = false) => { const list = ids(v); if (list.some(id => !s.resources.some(r => r.id === id && !r.deleted && (allowHidden || !r.hidden)))) fail("服务器不存在、已删除或已隐藏"); return list; };
  const checkedRows = (v: unknown, pool: string[]): WeeklyServerRow[] => {
    if (!Array.isArray(v) || v.length > 200) fail("排期表格式不正确");
    const rows = (v as WeeklyServerRow[]).map(row => {
      if (!row || !pool.includes(row.resourceId) || !Array.isArray(row.assignments) || row.assignments.length > 30) fail("排期服务器或使用组格式不正确");
      const assignments = row.assignments.map(x => {
        if (!x || !s.groups.some(g => g.id === x.groupId)) fail("使用组不存在");
        return { groupId: x.groupId, purpose: str(x.purpose ?? "", "使用用途", 1000, false),
          ...(x.demandId ? { demandId: str(x.demandId, "需求标识", 100), lineId: str(x.lineId, "资源行标识", 100) } : {}) };
      });
      if (new Set(assignments.map(x => x.groupId)).size !== assignments.length) fail("同一台服务器不可重复添加同一个组");
      return { resourceId: row.resourceId, assignments, specialNote: str(row.specialNote ?? "", "特殊用途", 2000, false) };
    });
    if (new Set(rows.map(r => r.resourceId)).size !== rows.length) fail("排期表中服务器重复");
    return rows;
  };
  if (a.type === "weekly.table.clear") {
    needAdmin(); const resourceIds = validResourceIds(a.resourceIds, true); if (!resourceIds.length) fail("请先选择服务器");
    const reason = str(a.reason, "清空原因");
    const before = { bookings: s.bookings.filter(b => resourceIds.includes(b.resourceId) && b.endAt > now), plans: structuredClone(s.weeklyPlans), requests: structuredClone(s.requests) };
    clearFutureSchedules(s, resourceIds, now);
    audit("清空服务器未来排期", "weekly", resourceIds.join(","), `${resourceIds.length}台服务器从${now}起的全部排期已清空；${reason}`, before, { resourceIds, at: now }); return;
  }
  if (a.type === "weekly.table.defaults") {
    needAdmin(); const pool = validResourceIds(a.resourceIds), rows = checkedRows(a.rows, pool);
    if (rows.some(r => r.assignments.some(x => x.demandId))) fail("常态分配应填写使用组，不关联某周需求");
    const before = structuredClone(s.settings);
    s.settings.weeklyPoolIds = pool; s.settings.weeklyDefaults = rows;
    audit("保存常态分配", "weekly", pool.join(","), `保存${pool.length}台服务器的常态分配与特殊用途`, before, s.settings); return;
  }
  if (a.type === "weekly.table.create") {
    needAdmin(); const weekStart = str(a.weekStart, "周起始日期", 10), range = calendarRange(weekStart, "week");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart) || new Date(Date.parse(range.startAt) + 28800000).toISOString().slice(0, 10) !== weekStart) fail("请选择北京时间周一");
    if (range.endAt <= now) fail("该周已经结束");
    if (s.weeklyPlans.some(p => p.weekStart === weekStart)) fail("该周已有排期，请选择已有计划", 409);
    const previous = [...s.weeklyPlans].filter(p => p.weekStart < weekStart).sort((a, b) => b.weekStart.localeCompare(a.weekStart))[0];
    const pool = (s.settings.weeklyPoolIds ?? previous?.resourceIds ?? s.resources.filter(r => !r.deleted && !r.hidden).map(r => r.id)).filter(id => s.resources.some(r => r.id === id && !r.deleted && !r.hidden));
    const inherited = inheritedTableRows(s, previous, now);
    const p: WeeklyPlan = { id: crypto.randomUUID(), layout: "table", weekStart, status: "collecting", resourceIds: pool,
      rows: pool.map(id => inherited.find(r => r.resourceId === id) ?? { resourceId: id, assignments: [], specialNote: "" }), allocations: [], deferred: [], confirmations: [], createdAt: now, updatedAt: now, publishedAt: "" };
    s.weeklyPlans.push(p); audit("创建表格周计划", "weekly", p.id, `${weekStart}周，默认继承以前的分配`, null, p); return;
  }
  const p = s.weeklyPlans.find(p => p.id === a.planId); if (!p) fail("周计划不存在", 404);
  const plan = p!;
  if (plan.v2) fail("双流程计划请使用新版排期操作", 409);
  if (weeklyPlanRange(plan).endAt <= now) fail("该周已经结束");
  const before = structuredClone(plan);
  if (a.type === "weekly.table.reopen") {
    needAdmin(); plan.rows = tableRows(s, plan).map(row => ({ ...structuredClone(row), assignments: plan.clearedResourceIds?.includes(row.resourceId) ? [] : row.assignments }));
    plan.layout = "table"; plan.resourceIds ??= [...new Set([...plan.rows.map(r => r.resourceId), ...s.resources.filter(r => !r.hidden && !r.deleted).map(r => r.id)])];
    plan.rows = plan.resourceIds.map(id => plan.rows!.find(r => r.resourceId === id) ?? { resourceId: id, assignments: [], specialNote: "" });
    for (const d of tableDemands(s, plan)) for (const l of d.lines) l.negotiated ??= l.minimum;
    plan.status = "collecting"; plan.confirmations = []; plan.updatedAt = now;
    audit("重新编排周计划", "weekly", plan.id, "重新开放需求；再次发布前须重新确认，正式预约在再次发布时更新", before, plan); return;
  }
  if (plan.layout !== "table") fail("请先转换为表格计划");
  if (plan.status === "published") fail("已发布计划请先重新编排", 409);
  const touch = () => { plan.confirmations = []; plan.updatedAt = now; if (plan.status !== "collecting") plan.status = "draft"; plan.allocations = tableAllocations(s, plan); };
  let kind = "调整周计划";
  switch (a.type) {
    case "weekly.table.sheet": {
      if (!Array.isArray(a.changes) || !a.changes.length || a.changes.length > 200) fail("请提交有效的表格修改");
      const changes = a.changes as { before: WeeklyServerRow; after: WeeklyServerRow }[];
      const resourceIds = validResourceIds(changes.map(c => c?.after?.resourceId));
      for (const change of changes) {
        const current = plan.rows?.find(r => r.resourceId === change.after.resourceId);
        if (!current || JSON.stringify(current) !== JSON.stringify(change.before)) fail("你编辑的行已被其他人修改，请载入最新表格后重试；本次修改未写入", 409);
      }
      const updated = checkedRows(changes.map(c => c.after), plan.resourceIds ?? []);
      for (const row of updated) for (const x of row.assignments) if (x.demandId && !tableDemands(s, plan).some(d => d.id === x.demandId && d.groupId === x.groupId && d.lines.some(l => l.id === x.lineId))) fail("需求关联无效");
      plan.rows = (plan.rows ?? []).map(row => resourceIds.includes(row.resourceId) ? updated.find(r => r.resourceId === row.resourceId)! : row);
      touch(); kind = "在线编辑服务器预排期"; break;
    }
    case "weekly.table.time": {
      needAdmin();
      const value = str(a.endAt, "排期结束时间", 64), ms = Date.parse(value);
      const base = calendarRange(plan.weekStart, "week");
      if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(ms)) fail("请填写有效的排期结束时间（含时区）");
      const endAt = new Date(ms).toISOString();
      if (endAt <= now || endAt <= base.startAt || ms > Date.parse(base.endAt) + 86400000) fail("结束时间必须晚于当前时间，且不晚于下周二零点");
      plan.endAt = endAt;
      for (const d of tableDemands(s, plan)) { d.expectedEnd = endAt; d.deadline = endAt; d.updatedAt = now; }
      touch(); kind = "调整周排期结束时间"; break;
    }
    case "weekly.table.pool": {
      needAdmin(); const pool = validResourceIds(a.resourceIds), defaults = inheritedTableRows(s);
      plan.rows = pool.map(id => plan.rows?.find(r => r.resourceId === id) ?? { resourceId: id, assignments: [], specialNote: defaults.find(r => r.resourceId === id)?.specialNote ?? "" });
      plan.resourceIds = pool; touch(); kind = "选择参与排期的服务器"; break;
    }
    case "weekly.table.rows": {
      needAdmin(); if (a.sourceRevision !== undefined && a.sourceRevision !== s.revision) fail("生成草案后数据已变化，请重新生成", 409);
      plan.rows = checkedRows(a.rows, plan.resourceIds ?? []);
      for (const row of plan.rows) for (const x of row.assignments) if (x.demandId && !tableDemands(s, plan).some(d => d.id === x.demandId && d.groupId === x.groupId && d.lines.some(l => l.id === x.lineId))) fail("需求关联无效");
      touch(); kind = "修改服务器预排期"; break;
    }
    case "weekly.table.inherit": {
      needAdmin(); const previous = [...s.weeklyPlans].filter(p => p.weekStart < plan.weekStart).sort((a, b) => b.weekStart.localeCompare(a.weekStart))[0];
      const rows = a.source === "defaults" ? s.settings.weeklyDefaults ?? inheritedTableRows(s, previous) : inheritedTableRows(s, previous); plan.rows = (plan.resourceIds ?? []).map(id => rows.find(r => r.resourceId === id) ?? { resourceId: id, assignments: [], specialNote: "" });
      touch(); kind = "套用常态及上周分配"; break;
    }
    case "weekly.table.demand": {
      if (plan.status !== "collecting") fail("请先重新开放需求收集", 409);
      const v = a.demand as Partial<WeeklyDemand>; if (!v || !Array.isArray(v.lines) || v.lines.length !== 1) fail("每行需求请填写一种服务器类型");
      const old = v.id ? s.weeklyDemands.find(d => d.id === v.id && d.planId === plan.id) : undefined;
      if (v.id && !old) fail("需求不存在"); if (old && !admin && old.groupId !== actor.groupId) fail("只能修改本组需求", 403);
      const groupId = admin ? str(v.groupId, "使用组", 100) : actor.groupId;
      if (!s.groups.some(g => g.id === groupId) || (old && old.groupId !== groupId)) fail("使用组不正确");
      const l = v.lines![0], previousLine = old?.lines[0];
      const resourceType = str(l.resourceType, "服务器类型", 80), desired = num(l.desired, 200, "理想数量", 1), shareCount = num(l.shareCount, desired, "可共用数量");
      if (!["bare", "lingshu"].includes(l.accessMode)) fail("使用方式不正确");
      const negotiated = admin ? (l.negotiated === undefined ? undefined : num(l.negotiated, desired, "协商后数量")) : previousLine?.negotiated;
      if (negotiated !== undefined && negotiated > desired) fail("理想数量不能低于已协商数量，请管理员先调整协商结果");
      const sameRackCount = num(l.sameRackCount ?? 0, desired, "同柜数量");
      const sameRackGroupIds = ids(l.sameRackGroupIds ?? []); if (sameRackGroupIds.some(id => id === groupId || !s.groups.some(g => g.id === id))) fail("同柜组别不正确");
      const line: WeeklyLine = { id: previousLine?.id ?? crypto.randomUUID(), zone: "green", family: "A3", accessMode: l.accessMode, resourceType, desired, minimum: 0, negotiated,
        mode: "multi", rackPolicy: "prefer", preferredResourceIds: previousLine?.preferredResourceIds ?? [], shareCount, sameRackCount, sameRackGroupIds, requirements: str(l.requirements ?? "", "要求", 2000, false) };
      const range = weeklyPlanRange(plan), purpose = str(v.title, "使用用途", 1000);
      const d: WeeklyDemand = { id: old?.id ?? crypto.randomUUID(), planId: plan.id, groupId, title: purpose, category: "version", reason: purpose, deadline: range.endAt,
        expectedStart: range.startAt, expectedEnd: range.endAt, continuousHours: 0, timeNote: "", holdMode: "week", shareWithDemandIds: [], shareNote: "各组自行协调共用", lines: [line], status: "active",
        applicantName: str(v.applicantName ?? old?.applicantName ?? actor.displayName, "申请人", 100), applicantId: old?.applicantId ?? actor.userId, table: true, createdAt: old?.createdAt ?? now, updatedAt: now };
      if (old) s.weeklyDemands[s.weeklyDemands.indexOf(old)] = d; else s.weeklyDemands.push(d);
      touch(); kind = "保存表格需求"; break;
    }
    case "weekly.table.withdraw": {
      if (plan.status !== "collecting") fail("请先重新开放收集");
      const d = tableDemands(s, plan).find(d => d.id === a.demandId); if (!d) fail("需求不存在");
      if (!admin && d!.groupId !== actor.groupId) fail("只能撤回本组需求", 403);
      d!.status = "withdrawn"; for (const row of plan.rows ?? []) row.assignments = row.assignments.filter(x => x.demandId !== d!.id);
      touch(); kind = "撤回表格需求"; break;
    }
    case "weekly.table.negotiate": {
      needAdmin(); const d = tableDemands(s, plan).find(d => d.id === a.demandId), l = d?.lines.find(l => l.id === a.lineId); if (!l) fail("需求不存在");
      l!.negotiated = num(a.quantity, l!.desired, "协商后数量"); touch(); kind = "填写协商后数量"; break;
    }
    case "weekly.table.recommend": {
      needAdmin(); if (tableDemands(s, plan).some(d => d.lines.some(l => l.negotiated === undefined))) fail("请先填写协商后数量");
      plan.rows = recommendTableRows(s, plan); touch(); kind = "生成规则排期草案"; break;
    }
    case "weekly.table.stage": {
      needAdmin(); if (!["collecting", "draft", "confirming"].includes(String(a.status))) fail("阶段不正确");
      if (a.status === "confirming") {
        const errors = checkTablePlan(s, plan, now).filter(x => x.severity === "error"); if (errors.length) fail(errors[0].message, 409);
        if (!tableGroups(s, plan).length) fail("尚未安排使用组");
      }
      touch(); plan.status = a.status as WeeklyPlan["status"]; kind = "变更周计划阶段"; break;
    }
    case "weekly.table.confirm": {
      if (plan.status !== "confirming") fail("当前不在各组确认阶段");
      const groupId = admin ? str(a.groupId, "使用组", 100) : actor.groupId; if (!tableGroups(s, plan).includes(groupId)) fail("该组没有本周安排");
      if (!["confirmed", "changes"].includes(String(a.status))) fail("确认结果不正确");
      const note = str(a.note ?? "", admin ? "代确认原因" : "反馈说明", 1000, admin || a.status === "changes");
      plan.confirmations = plan.confirmations.filter(c => c.groupId !== groupId); plan.confirmations.push({ groupId, status: a.status as "confirmed" | "changes", note, at: now, by: actor.displayName });
      plan.updatedAt = now; kind = admin ? "管理员代确认周分配" : "确认本组周分配"; break;
    }
    case "weekly.table.publish": {
      needAdmin(); if (plan.status !== "confirming") fail("请先提交各组确认");
      const groups = tableGroups(s, plan); if (!groups.length || groups.some(groupId => !plan.confirmations.some(c => c.groupId === groupId && c.status === "confirmed"))) fail("仍有组未确认或要求调整", 409);
      const errors = checkTablePlan(s, plan, now).filter(x => x.severity === "error"); if (errors.length) fail(`发布校验：${errors[0].message}`, 409);
      // Republication replaces this plan's future bookings only; retain elapsed segments.
      for (const b of s.bookings) if (b.status === "scheduled" && b.endAt > now && s.requests.find(q => q.id === b.requestId)?.weeklyPlanId === plan.id) {
        if (b.startAt < now) { b.endAt = now; b.status = "released"; } else b.status = "cancelled"; b.updatedAt = now;
      }
      for (const q of s.requests) if (q.weeklyPlanId === plan.id) { delete q.pendingExtension; if (q.status === "approved" && !s.bookings.some(b => b.requestId === q.id && b.status === "scheduled" && b.endAt > now)) q.status = "cancelled"; }
      const range = weeklyPlanRange(plan), startAt = range.startAt > now ? range.startAt : now;
      for (const row of plan.rows ?? []) {
        if (row.assignments.length > 1) { const r = s.resources.find(r => r.id === row.resourceId)!; r.sharingMode = "shared"; r.updatedAt = now; }
        for (const x of row.assignments) {
          const id = crypto.randomUUID();
          s.requests.push({ id, weeklyPlanId: plan.id, weeklyDemandId: x.demandId, groupId: x.groupId, resourceIds: [row.resourceId], startAt, endAt: range.endAt, purpose: x.purpose || "常态分配", priority: "normal", status: "approved",
            applicantId: actor.userId, applicantName: actor.displayName, createdAt: now, reviewedAt: now, reviewer: actor.displayName, reviewNote: `${plan.weekStart}周表格排期；各组已确认，含管理员代确认` });
          s.bookings.push({ id: crypto.randomUUID(), requestId: id, resourceId: row.resourceId, groupId: x.groupId, startAt, endAt: range.endAt, purpose: x.purpose || "常态分配", priority: "normal", status: "scheduled", parentId: "", createdAt: now, updatedAt: now });
        }
      }
      plan.allocations = tableAllocations(s, plan); plan.clearedResourceIds = []; plan.status = "published"; plan.publishedAt = now; plan.updatedAt = now; kind = "发布表格周排期"; break;
    }
    default: fail("未知表格排期操作");
  }
  audit(kind, "weekly", plan.id, `${plan.weekStart}周：${kind}`, before, { plan, demands: tableDemands(s, plan) });
}
