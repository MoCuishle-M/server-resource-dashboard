import type { Action, Actor, State, WeeklyAllocation, WeeklyDemand, WeeklyLine, WeeklyPlan } from "./types";
import { calendarRange } from "./schedule";
import { checkWeeklyPlan, demandRange, suggestWeeklyPlan, weeklyCategoryLabels, weeklyDemands } from "./weekly-planner";

type Helpers = {
  fail: (message: string, status?: number) => never;
  audit: (kind: string, entityType: string, entityId: string, summary: string, before?: unknown, after?: unknown) => void;
};
export function applyWeeklyAction(s: State, actor: Actor, a: Action, now: string, { fail, audit }: Helpers) {
  const admin = actor.role === "admin";
  const needAdmin = () => { if (!admin) fail("仅服务器管理员可以执行此操作", 403); };
  const str = (v: unknown, label: string, max = 1000, required = true) => {
    if (typeof v !== "string" || v.trim().length > max || (required && !v.trim())) fail(`请填写有效的${label}（最多${max}字）`);
    return (v as string).trim();
  };
  const list = (v: unknown) => {
    if (!Array.isArray(v) || v.length > 200 || v.some(x => typeof x !== "string") || new Set(v).size !== v.length) fail("服务器或任务清单格式不正确");
    return v as string[];
  };
  const num = (v: unknown, min: number, max: number, label: string) => {
    if (!Number.isInteger(v) || (v as number) < min || (v as number) > max) fail(`${label}应为${min}至${max}的整数`);
    return v as number;
  };
  const dateTime = (v: unknown, label: string) => {
    if (typeof v !== "string" || !Number.isFinite(Date.parse(v))) fail(`请填写有效的${label}`);
    return new Date(v as string).toISOString();
  };
  const touch = (p: WeeklyPlan) => { p.updatedAt = now; p.confirmations = []; if (p.status !== "collecting") p.status = "draft"; };
  if (!actor.userId || (!admin && actor.role !== "contact")) fail("请先登录并通过组接口人认证", 403);
  if (a.type === "weekly.create") {
    needAdmin();
    const weekStart = str(a.weekStart, "周起始日期", 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart) || !Number.isFinite(Date.parse(weekStart))) fail("周起始日期不正确");
    const range = calendarRange(weekStart, "week");
    if (new Date(Date.parse(range.startAt) + 8 * 3600000).toISOString().slice(0, 10) !== weekStart) fail("请选择北京时间周一作为周起始日期");
    if (range.endAt <= now) fail("不能为已经结束的一周创建排期");
    if (s.weeklyPlans.some(p => p.weekStart === weekStart)) fail("该周已有排期，请打开已有计划", 409);
    const p: WeeklyPlan = { id: crypto.randomUUID(), weekStart, status: "collecting", allocations: [], deferred: [], confirmations: [], createdAt: now, updatedAt: now, publishedAt: "" };
    s.weeklyPlans.push(p);
    audit("创建周排期", "weekly", p.id, `创建${weekStart}周需求收集`, null, p);
    return;
  }
  const p = s.weeklyPlans.find(p => p.id === a.planId);
  if (!p) fail("周排期不存在", 404);
  const plan = p!;
  if (plan.v2) fail("双流程计划请使用新版排期操作", 409);
  if (plan.status === "published") fail("该周已发布；请通过原有申请、续期或取消功能处理临时事项，已发布方案保持不变", 409);
  if (calendarRange(plan.weekStart, "week").endAt <= now) fail("该周已经结束，不能再修改排期", 409);
  const before = structuredClone(plan);
  const findDemand = () => {
    const d = s.weeklyDemands.find(x => x.id === a.demandId && x.planId === plan.id && x.status === "active");
    if (!d) fail("需求不存在或已撤回", 404);
    if (!admin && d!.groupId !== actor.groupId) fail("只能操作本组需求", 403);
    if (!admin && [...d!.lines.flatMap(l => l.preferredResourceIds), ...plan.allocations.filter(x => x.demandId === d!.id).flatMap(x => x.resourceIds)]
      .some(id => s.resources.some(r => r.id === id && r.hidden))) fail("该需求包含管理员专用资源，请联系管理员处理", 403);
    return d!;
  };
  let kind = "调整周排期";
  let detailIds: string[] = [];
  let previousDemand: WeeklyDemand | undefined;
  switch (a.type) {
    case "weekly.copyPrevious": {
      needAdmin();
      if (plan.status !== "collecting") fail("只能在收集阶段带入上周需求", 409);
      if (weeklyDemands(s, plan).length) fail("当前已有需求，不能整批带入；请先核对已有需求", 409);
      const source = [...s.weeklyPlans].filter(p => p.weekStart < plan.weekStart).sort((a, b) => b.weekStart.localeCompare(a.weekStart))[0];
      if (!source || !weeklyDemands(s, source).length) fail("没有可沿用的上一期需求");
      const delta = Date.parse(calendarRange(plan.weekStart, "week").startAt) - Date.parse(calendarRange(source.weekStart, "week").startAt);
      const shift = (at: string) => new Date(Date.parse(at) + delta).toISOString();
      const ids = new Map(weeklyDemands(s, source).map(d => [d.id, crypto.randomUUID()]));
      for (const d of weeklyDemands(s, source)) s.weeklyDemands.push({ ...structuredClone(d), id: ids.get(d.id)!, planId: plan.id,
        deadline: shift(d.deadline), expectedStart: shift(d.expectedStart), expectedEnd: shift(d.expectedEnd),
        shareWithDemandIds: d.shareWithDemandIds.filter(id => ids.has(id)).map(id => ids.get(id)!),
        lines: d.lines.map(l => ({ ...structuredClone(l), id: crypto.randomUUID(), preferredResourceIds: [...new Set([...l.preferredResourceIds,
          ...(source.allocations.find(a => a.demandId === d.id && a.lineId === l.id)?.resourceIds ?? [])])]
          .filter(id => s.resources.some(r => r.id === id && !r.deleted && !r.hidden)) })), createdAt: now, updatedAt: now });
      touch(plan); kind = "带入上期周需求"; break;
    }
    case "weekly.demand.save": {
      if (plan.status !== "collecting") fail("需求收集已结束，请联系管理员重新开放收集", 409);
      const v = a.demand as Partial<WeeklyDemand>;
      if (!v || typeof v !== "object") fail("需求格式不正确");
      const previous = v.id ? s.weeklyDemands.find(d => d.id === v.id && d.planId === plan.id) : undefined;
      previousDemand = previous ? structuredClone(previous) : undefined;
      if (v.id && !previous) fail("原需求不存在", 404);
      if (previous && !admin && previous.groupId !== actor.groupId) fail("只能修改本组需求", 403);
      const groupId = admin ? str(v.groupId, "使用组", 100) : actor.groupId;
      if (previous && previous.groupId !== groupId) fail("已有需求不能变更使用组，请撤回后重新提交");
      if (!s.groups.some(g => g.id === groupId)) fail("使用组不存在");
      if (!Object.hasOwn(weeklyCategoryLabels, String(v.category))) fail("请选择需求分类");
      const start = dateTime(v.expectedStart, "预计开始时间"), end = dateTime(v.expectedEnd, "预计结束时间");
      const range = calendarRange(plan.weekStart, "week");
      if (start < range.startAt || end > range.endAt || end <= start) fail("预计使用时段应在该周内，且结束晚于开始；跨周任务请分周提交");
      if (end <= now) fail("预计使用时间已经结束");
      const continuousHours = num(v.continuousHours, 0, 168, "连续运行小时数");
      if (continuousHours * 3600000 > Date.parse(end) - Date.parse(start)) fail("预计使用窗口不足以容纳连续运行时长");
      if (!["week", "window"].includes(v.holdMode as string)) fail("请选择整周保留或仅使用窗口");
      if (!Array.isArray(v.lines) || !v.lines.length || v.lines.length > 10) fail("每个任务请填写1至10条资源需求");
      const lines: WeeklyLine[] = v.lines!.map(l => {
        if (!l || !["green", "blue"].includes(l.zone) || !["A3", "A5"].includes(l.family) || !["bare", "lingshu"].includes(l.accessMode)) fail("资源区域、型号或使用方式不正确");
        if (!["single", "multi"].includes(l.mode) || !["required", "prefer", "any"].includes(l.rackPolicy)) fail("请填写单机/多机与跨柜要求");
        const desired = num(l.desired, 1, 200, "理想数量"), minimum = num(l.minimum, 1, desired, "最低数量");
        const preferredResourceIds = list(l.preferredResourceIds ?? []);
        if (preferredResourceIds.some(id => !s.resources.some(r => r.id === id && !r.deleted && (!r.hidden || admin)))) fail("期望沿用的服务器不存在或不可见");
        const id = l.id ? str(l.id, "资源行标识", 100) : crypto.randomUUID();
        return { id, zone: l.zone, family: l.family, accessMode: l.accessMode, desired, minimum, mode: l.mode,
          rackPolicy: l.mode === "single" ? "any" : l.rackPolicy, preferredResourceIds, shareCount: num(l.shareCount, 0, desired, "可共享数量") };
      });
      if (new Set(lines.map(l => l.id)).size !== lines.length) fail("资源行标识不能重复");
      const shareWithDemandIds = list(v.shareWithDemandIds ?? []);
      if (shareWithDemandIds.some(id => id === previous?.id || !s.weeklyDemands.some(d => d.id === id && d.planId === plan.id && d.status === "active"))) fail("共享对象应为本周其他有效任务");
      const shareNote = str(v.shareNote ?? "", "共享条件", 1000, false);
      if (lines.some(l => l.shareCount > 0) && !shareNote) fail("请写清楚共享对象、同时或错峰方式及环境限制");
      const demand: WeeklyDemand = { id: previous?.id ?? crypto.randomUUID(), planId: plan.id, groupId,
        title: str(v.title, "任务名称", 120), category: v.category as WeeklyDemand["category"], reason: str(v.reason, "使用理由"),
        deadline: dateTime(v.deadline, "DDL"), expectedStart: start, expectedEnd: end, continuousHours,
        timeNote: str(v.timeNote ?? "", "时间弹性说明", 1000, false), holdMode: v.holdMode as WeeklyDemand["holdMode"],
        shareWithDemandIds, shareNote, lines, status: "active", createdAt: previous?.createdAt ?? now, updatedAt: now };
      if (demand.deadline <= now) fail("任务DDL已经过去，请更新需求");
      if (previous) s.weeklyDemands[s.weeklyDemands.indexOf(previous)] = demand; else s.weeklyDemands.push(demand);
      // Editing requirements invalidates that task's assignments, including prior locks.
      plan.allocations = plan.allocations.filter(x => x.demandId !== demand.id);
      plan.deferred = plan.deferred.filter(x => x.demandId !== demand.id);
      touch(plan); kind = previous ? "修改周需求" : "提交周需求"; detailIds = [demand.id];
      break;
    }
    case "weekly.demand.withdraw": {
      if (plan.status !== "collecting") fail("需求收集已结束，请联系管理员重新开放收集", 409);
      const d = findDemand(); d.status = "withdrawn"; d.updatedAt = now;
      plan.allocations = plan.allocations.filter(x => x.demandId !== d.id);
      plan.deferred = plan.deferred.filter(x => x.demandId !== d.id);
      touch(plan); kind = "撤回周需求"; detailIds = [d.id]; break;
    }
    case "weekly.stage": {
      needAdmin();
      if (!["collecting", "draft", "confirming"].includes(a.status as string)) fail("排期状态不正确");
      if (a.status === "confirming") {
        if (!weeklyDemands(s, plan).length) fail("请先收集使用需求");
        const errors = checkWeeklyPlan(s, plan).filter(x => x.severity === "error");
        if (errors.length) fail(`请先处理冲突：${errors[0].message}`, 409);
      }
      if (plan.status === a.status) fail("排期已经处于该状态", 409);
      touch(plan); plan.status = a.status as WeeklyPlan["status"]; kind = "变更周排期阶段"; break;
    }
    case "weekly.suggest": {
      needAdmin();
      if (plan.status === "collecting") fail("请先结束收集并进入草稿阶段", 409);
      plan.allocations = suggestWeeklyPlan(s, plan, a.historyOnly === true);
      touch(plan); kind = a.historyOnly ? "沿用历史分配" : "生成规则排期"; break;
    }
    case "weekly.assign": {
      needAdmin();
      if (plan.status === "collecting") fail("请先进入草稿阶段", 409);
      const d = findDemand(), lineId = str(a.lineId, "资源行", 100);
      if (!d.lines.some(l => l.id === lineId)) fail("资源需求行不存在");
      const resourceIds = list(a.resourceIds), sharedResourceIds = list(a.sharedResourceIds ?? []);
      if (resourceIds.some(id => !s.resources.some(r => r.id === id && !r.deleted && !r.hidden))) fail("只能分配存在且公开的服务器");
      if (sharedResourceIds.some(id => !resourceIds.includes(id))) fail("共享机器必须在已选清单内");
      if (typeof a.locked !== "boolean") fail("锁定设置不正确");
      const row: WeeklyAllocation = { demandId: d.id, lineId, resourceIds, sharedResourceIds, locked: a.locked as boolean, note: str(a.note ?? "", "分配说明", 1000, false) };
      plan.allocations = plan.allocations.filter(x => x.demandId !== d.id || x.lineId !== lineId);
      plan.allocations.push(row); plan.deferred = plan.deferred.filter(x => x.demandId !== d.id);
      touch(plan); kind = "手动分配周资源"; detailIds = [d.id, ...resourceIds]; break;
    }
    case "weekly.defer": {
      needAdmin(); const d = findDemand();
      plan.deferred = plan.deferred.filter(x => x.demandId !== d.id);
      if (a.deferred !== false) {
        plan.deferred.push({ demandId: d.id, reason: str(a.reason, "暂缓原因") });
        plan.allocations = plan.allocations.filter(x => x.demandId !== d.id);
      }
      touch(plan); kind = "调整周需求暂缓安排"; detailIds = [d.id]; break;
    }
    case "weekly.confirm": {
      if (plan.status !== "confirming") fail("当前不在各组确认阶段", 409);
      const groupId = admin ? str(a.groupId, "使用组", 100) : actor.groupId;
      if (!weeklyDemands(s, plan).some(d => d.groupId === groupId)) fail("该组没有本周需求");
      if (!["confirmed", "changes"].includes(a.status as string)) fail("确认结果不正确");
      const note = str(a.note ?? "", admin ? "管理员代确认原因" : "反馈说明", 1000, admin || a.status === "changes");
      plan.confirmations = plan.confirmations.filter(c => c.groupId !== groupId);
      plan.confirmations.push({ groupId, status: a.status as "confirmed" | "changes", note, at: now, by: actor.displayName });
      plan.updatedAt = now; kind = a.status === "confirmed" ? "确认本组周分配" : "反馈周分配调整意见"; break;
    }
    case "weekly.publish": {
      needAdmin();
      if (plan.status !== "confirming") fail("请先进入各组确认阶段", 409);
      const ds = weeklyDemands(s, plan);
      if (!ds.length) fail("没有可发布的需求");
      const errors = checkWeeklyPlan(s, plan).filter(x => x.severity === "error");
      if (errors.length) fail(`发布前校验未通过：${errors[0].message}`, 409);
      if ([...new Set(ds.map(d => d.groupId))].some(groupId => !plan.confirmations.some(c => c.groupId === groupId && c.status === "confirmed"))) fail("仍有使用组未确认或提出调整意见", 409);
      for (const d of ds.filter(d => !plan.deferred.some(x => x.demandId === d.id))) {
        const resourceIds = [...new Set(plan.allocations.filter(x => x.demandId === d.id).flatMap(x => x.resourceIds))];
        const range = demandRange(plan, d), startAt = range.startAt > now ? range.startAt : now;
        if (range.endAt <= startAt) fail(`“${d.title}”使用时段已结束，无法发布`, 409);
        const requestId = crypto.randomUUID();
        s.requests.push({ id: requestId, weeklyPlanId: plan.id, weeklyDemandId: d.id, groupId: d.groupId,
          resourceIds, startAt, endAt: range.endAt, purpose: d.title, priority: "normal", status: "approved",
          applicantId: actor.userId, applicantName: actor.displayName, createdAt: now, reviewedAt: now,
          reviewer: actor.displayName, reviewNote: `周排期统一发布（${plan.weekStart}）；各组已确认` });
        for (const resourceId of resourceIds) s.bookings.push({ id: crypto.randomUUID(), requestId, resourceId,
          groupId: d.groupId, startAt, endAt: range.endAt, purpose: d.title, priority: "normal", status: "scheduled", parentId: "", createdAt: now, updatedAt: now });
      }
      plan.status = "published"; plan.publishedAt = now; plan.updatedAt = now; kind = "发布周排期";
      break;
    }
    default: fail("未知周排期操作");
  }
  audit(kind, "weekly", [plan.id, ...detailIds].join(","), `${plan.weekStart}周：${kind}`,
    { plan: before, ...(previousDemand ? { demand: previousDemand } : {}) },
    { plan, demands: s.weeklyDemands.filter(d => detailIds.includes(d.id)) });
}

/** Table drafts are shared by admins and approved contacts; public viewers only see published plans. */
function visibleWorkspace(p: WeeklyPlan, hidden: Set<string>, contact: boolean) {
  const w = structuredClone(p.v2!);
  const safe = (sec: typeof w.sections.day) => {
    const redact = (value: Pick<typeof sec, "rows" | "allocations" | "demands">) => {
      const privateIds = new Set(value.allocations.filter(a => a.resourceIds.some(id => hidden.has(id))).map(a => a.demandId));
      value.demands = value.demands.filter(d => !privateIds.has(d.id)).map(d => ({ ...d, applicantName: contact ? d.applicantName : "" }));
      value.allocations = value.allocations.filter(a => !privateIds.has(a.demandId));
      value.rows = value.rows.filter(r => !hidden.has(r.resourceId));
    };
    if (!contact) {
      const published = sec.published;
      sec = { status: published ? "published" : "collecting", demands: published?.demands ?? [], allocations: published?.allocations ?? [], rows: published?.rows ?? [], confirmations: [], published };
    }
    redact(sec); if (sec.published) redact(sec.published);
    sec.restorations = contact ? sec.restorations?.filter(x => !hidden.has(x.resourceId)) : [];
    sec.confirmations = contact ? sec.confirmations : [];
    return sec;
  };
  w.sections = { day: safe(w.sections.day), multi: safe(w.sections.multi) };
  w.previousRows = contact ? w.previousRows.filter(r => !hidden.has(r.resourceId)) : [];
  w.suppressions = w.suppressions.filter(x => !hidden.has(x.resourceId));
  if (!contact) w.slots = w.sections.multi.published?.slots ?? [];
  if (!contact) w.modelTags = [...new Map([...(w.sections.day.published?.modelTags ?? []), ...(w.sections.multi.published?.modelTags ?? [])].map(t => [t.id, t])).values()];
  return w;
}
export function visibleWeeklyState(s: State, actor: Actor): Pick<State, "weeklyPlans" | "weeklyDemands"> {
  if (actor.role === "admin") return { weeklyPlans: s.weeklyPlans, weeklyDemands: s.weeklyDemands };
  const contact = actor.role === "contact";
  const hidden = new Set(s.resources.filter(r => r.hidden).map(r => r.id));
  const privateDemand = new Set(s.weeklyDemands.filter(d => d.lines.some(l => l.preferredResourceIds.some(id => hidden.has(id)))
    || s.weeklyPlans.some(p => p.allocations.some(a => a.demandId === d.id && a.resourceIds.some(id => hidden.has(id))))).map(d => d.id));
  const ds = s.weeklyDemands.filter(d => !privateDemand.has(d.id));
  const plans = s.weeklyPlans.filter(p => contact || p.status === "published");
  const visible = ds.filter(d => plans.some(p => p.id === d.planId && (p.status === "published" || (contact && d.groupId === actor.groupId))));
  const own = (id: string) => visible.some(d => d.id === id && d.groupId === actor.groupId && contact);
  return {
    weeklyDemands: visible.map(d => own(d.id) ? d : { ...d, applicantId: "", reason: "", timeNote: "", shareNote: "", shareWithDemandIds: [], lines: d.lines.map(l => ({ ...l, preferredResourceIds: [] })) }),
    weeklyPlans: plans.map(p => ({ ...p,
      ...(p.v2 ? { v2: visibleWorkspace(p, hidden, contact) } : {}),
      resourceIds: p.resourceIds?.filter(id => !hidden.has(id)),
      clearedResourceIds: p.clearedResourceIds?.filter(id => !hidden.has(id)),
      aiNote: "",
      rows: (p.v2 && !contact ? p.v2.sections.day.published?.rows ?? [] : p.rows)?.filter(row => !hidden.has(row.resourceId)).map(row => ({ ...row, assignments: row.assignments.filter(a => p.status === "published" || (contact && (p.layout === "table" || a.groupId === actor.groupId))) })),
      directory: contact ? ds.filter(d => d.planId === p.id && d.status === "active").map(d => ({ id: d.id, title: d.title, groupId: d.groupId })) : [],
      allocations: p.allocations.filter(a => visible.some(d => d.id === a.demandId)).map(a => own(a.demandId) ? a : { ...a, note: "" }),
      deferred: p.deferred.filter(a => visible.some(d => d.id === a.demandId)).map(a => own(a.demandId) ? a : { ...a, reason: "本周暂缓" }),
      confirmations: p.confirmations.filter(c => contact && c.groupId === actor.groupId),
    })),
  };
}
