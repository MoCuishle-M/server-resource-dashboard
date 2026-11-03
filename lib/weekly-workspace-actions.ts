import type { Action, Actor, State, WeeklyPlan, WeeklySectionName, WeeklyServerRow, WorkspaceAllocation, WorkspaceDemand, WorkspaceSection } from "./types";
import { calendarRange, shiftDate } from "./schedule";
import { inheritedTableRows } from "./weekly-table";
import { PLATFORM_GROUP_ID } from "./lingshu";
import { blueA5, makeWeeklySlots, recommendSection, rebuildWorkspaceBookings, resourceUnavailable, sectionGroups, sectionIssues, workspaceRange } from "./weekly-workspace";

type Helpers = { fail: (message: string, status?: number) => never; audit: (kind: string, entityType: string, entityId: string, summary: string, before?: unknown, after?: unknown) => void };
export function applyWorkspaceAction(s: State, actor: Actor, a: Action, now: string, { fail, audit }: Helpers) {
  const admin = actor.role === "admin";
  if (!actor.userId || (!admin && actor.role !== "contact")) fail("请先登录并通过组接口人认证", 403);
  const needAdmin = () => { if (!admin) fail("仅管理员可调整协商数量、服务器与发布", 403); };
  const text = (v: unknown, label: string, required = true, max = 1000) => { if (typeof v !== "string" || v.length > max || (required && !v.trim())) fail(`请填写有效的${label}`); return (v as string).trim(); };
  const ids = (v: unknown, label = "清单") => { if (!Array.isArray(v) || v.length > 200 || v.some(x => typeof x !== "string") || new Set(v).size !== v.length) fail(`${label}格式不正确`); return v as string[]; };
  const num = (v: unknown, label: string, min = 0) => { if (!Number.isInteger(v) || Number(v) < min || Number(v) > 200) fail(`${label}应为${min}至200的整数`); return Number(v); };
  const checkPool = (v: unknown) => { const list = ids(v); if (!list.length || list.some(id => !s.resources.some(r => r.id === id && blueA5(r)))) fail("请选择可见、未删除的蓝区 A5 裸机"); return list; };
  const groups = (v: unknown) => { const list = ids(v); if (!list.length || list.some(id => !s.groups.some(g => g.id === id))) fail("请选择有效的参与组"); return list; };
  const fresh = (): WorkspaceSection => ({ status: "collecting", demands: [], allocations: [], rows: [], confirmations: [] });
  if (a.type === "weekly.v2.create") {
    needAdmin(); const week = text(a.weekStart, "周一日期", true, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(week) || calendarRange(week, "week").startAt !== new Date(`${week}T00:00:00+08:00`).toISOString()) fail("请选择北京时间周一");
    const startAt = new Date(`${week}T09:00:00+08:00`).toISOString(), endAt = new Date(`${shiftDate(week, 7)}T09:00:00+08:00`).toISOString();
    if (endAt <= now) fail("该周已经结束");
    if (s.weeklyPlans.some(p => p.weekStart === week)) fail("该周已有计划，请使用已有计划；旧计划不会自动转换", 409);
    const previous = [...s.weeklyPlans].filter(p => p.weekStart < week).sort((a, b) => b.weekStart.localeCompare(a.weekStart))[0];
    const inheritedPool = (previous?.resourceIds ?? s.settings.weeklyPoolIds ?? []).filter(id => s.resources.some(r => r.id === id && blueA5(r)));
    const pool = checkPool(a.resourceIds ?? (inheritedPool.length ? inheritedPool : s.resources.filter(blueA5).map(r => r.id)));
    const inherited = previous?.v2 ? previous.v2.sections.day.published?.rows ?? previous.v2.sections.day.rows : inheritedTableRows(s, previous, now);
    const rows: WeeklyServerRow[] = pool.map(id => ({ resourceId: id, assignments: (inherited.find(r => r.resourceId === id)?.assignments ?? []).map(x => ({ groupId: x.groupId, purpose: x.purpose })), specialNote: inherited.find(r => r.resourceId === id)?.specialNote ?? "" }));
    const participantGroupIds = groups(a.groupIds ?? previous?.v2?.participantGroupIds ?? s.groups.filter(g => g.id !== PLATFORM_GROUP_ID).map(g => g.id));
    const p: WeeklyPlan = { id: crypto.randomUUID(), weekStart: week, endAt, layout: "table", resourceIds: pool, rows: structuredClone(rows), status: "collecting", allocations: [], deferred: [], confirmations: [], createdAt: now, updatedAt: now, publishedAt: "",
      v2: { version: 2, startAt, slots: makeWeeklySlots(week), participantGroupIds, priorityNote: "deepseek、qwen、glm、kimi 系列模型优先；具体数量由会议协商。", previousRows: structuredClone(rows), suppressions: [], sections: { day: { ...fresh(), rows }, multi: fresh() } } };
    s.weeklyPlans.push(p); audit("创建双流程周计划", "weekly", p.id, `${week}周，${pool.length}台蓝区A5`, null, p); return;
  }
  const p = s.weeklyPlans.find(p => p.id === a.planId);
  if (!p?.v2) fail("双流程周计划不存在", 404);
  const plan = p!, w = plan.v2!;
  if (plan.endAt! <= now) fail("该周已经结束");
  const before = structuredClone(plan);
  const part = a.section as WeeklySectionName;
  if (part !== "day" && part !== "multi") fail("请选择白天或多机流程");
  let sec = w.sections[part];
  const touch = () => { sec.confirmations = []; if (sec.status !== "collecting") sec.status = "draft"; plan.updatedAt = now; };
  const editing = () => { if (sec.status === "published") fail("请先重新编排该流程", 409); };
  switch (a.type) {
    case "weekly.v2.settings": {
      needAdmin(); editing();
      if (a.before !== undefined && JSON.stringify(a.before) !== JSON.stringify({ resourceIds: plan.resourceIds, groupIds: w.participantGroupIds, priorityNote: w.priorityNote, saturdayEnabled: w.slots.some(x => x.saturdayDay && x.enabled) })) fail("参与范围或规则已被修改，输入已保留，请核对最新数据", 409);
      if (a.resourceIds !== undefined) {
        const pool = checkPool(a.resourceIds);
        if (w.sections.day.published || w.sections.multi.published) fail("已有发布结果，资源池在本周保持不变；请在新周调整", 409);
        const used = [...w.sections.day.rows.filter(r => r.assignments.length).map(r => r.resourceId), ...Object.values(w.sections).flatMap(x => x.allocations.flatMap(a => a.resourceIds))];
        if (used.some(id => !pool.includes(id))) fail("请先移除待退出服务器的草稿分配", 409);
        plan.resourceIds = pool;
        w.sections.day.rows = pool.map(id => w.sections.day.rows.find(r => r.resourceId === id) ?? { resourceId: id, assignments: [], specialNote: "" });
      }
      if (a.groupIds !== undefined) {
        const chosen = groups(a.groupIds);
        if (w.sections.day.demands.some(d => !chosen.includes(d.groupId))) fail("请先撤回退出组的白天需求");
        w.participantGroupIds = chosen;
      }
      if (a.priorityNote !== undefined) w.priorityNote = text(a.priorityNote, "优先级说明", false, 2000);
      if (a.saturdayEnabled !== undefined) {
        if (part !== "multi" || typeof a.saturdayEnabled !== "boolean") fail("周六开关应在多机流程设置");
        const affected = sec.demands.filter(d => d.slotIds.some(id => w.slots.some(x => x.id === id && x.saturdayDay)));
        if (!a.saturdayEnabled && affected.length) fail(`请先调整周六白天任务：${affected.map(d => d.title).join("、")}`, 409);
        for (const slot of w.slots) if (slot.saturdayDay) slot.enabled = a.saturdayEnabled as boolean;
      }
      touch(); break;
    }
    case "weekly.v2.reopen": needAdmin(); sec.status = "collecting"; touch(); break;
    case "weekly.v2.demand": {
      editing(); if (sec.status !== "collecting") fail("请先重新开放需求收集", 409);
      const v = a.demand as WorkspaceDemand;
      if (!v || typeof v !== "object") fail("需求格式不正确");
      const old = sec.demands.find(d => d.id === v.id);
      if (v.id && !old) fail("需求不存在", 404);
      if (a.before !== undefined && JSON.stringify(a.before) !== JSON.stringify(old ?? null)) fail("该需求已被其他人修改，输入已保留，请载入最新数据后重试", 409);
      if (old && !admin && old.groupId !== actor.groupId) fail("只能修改本组需求", 403);
      const groupId = admin ? text(v.groupId, "使用组") : actor.groupId;
      if (!s.groups.some(g => g.id === groupId) || (old && old.groupId !== groupId)) fail("使用组不正确");
      if (part === "day" && !w.participantGroupIds.includes(groupId)) fail("该组尚未加入白天参与组");
      const desired = num(v.desired, "申请数量", 1), negotiated = admin ? v.negotiated === undefined ? undefined : num(v.negotiated, "协商数量") : old?.negotiated;
      if (negotiated !== undefined && negotiated > desired) fail("协商数量不能高于申请数量");
      const slotIds = part === "day" ? [] : ids(v.slotIds, "时段");
      if (part === "multi" && (!slotIds.length || slotIds.some(id => !w.slots.some(x => x.id === id && x.enabled)))) fail("请选择已开放的多机时段");
      const continuous = part === "multi" && v.continuous === true;
      const chosen = w.slots.filter(x => slotIds.includes(x.id)).sort((a, b) => a.startAt.localeCompare(b.startAt));
      if (continuous && chosen.some((x, i) => i > 0 && chosen[i - 1].endAt !== x.startAt)) fail("同一批服务器连续使用需选择相邻时段");
      const sameRackCount = num(v.sameRackCount ?? 0, "同柜数量"), shareCount = part === "day" ? num(v.shareCount ?? 0, "可共用数量") : 0;
      if (sameRackCount > desired || shareCount > desired) fail("同柜数量和共用数量不能超过申请数量");
      const d: WorkspaceDemand = { id: old?.id ?? crypto.randomUUID(), groupId, title: text(v.title, "使用事项"), desired, negotiated, slotIds, continuous, sameRackCount, shareCount, model: text(v.model ?? "", "模型标记", false, 100), requirements: text(v.requirements ?? "", "要求", false, 2000), applicantName: old?.applicantName ?? actor.displayName };
      if (old) sec.demands[sec.demands.indexOf(old)] = d; else sec.demands.push(d);
      sec.allocations = sec.allocations.filter(x => x.demandId !== d.id);
      for (const row of sec.rows) row.assignments = row.assignments.map(x => x.demandId === d.id ? { groupId: x.groupId, purpose: d.title } : x);
      touch(); break;
    }
    case "weekly.v2.withdraw": {
      editing(); if (sec.status !== "collecting") fail("请先重新开放收集");
      const d = sec.demands.find(d => d.id === a.demandId); if (!d) fail("需求不存在", 404);
      if (!admin && d!.groupId !== actor.groupId) fail("只能撤回本组需求", 403);
      sec.demands = sec.demands.filter(x => x.id !== d!.id); sec.allocations = sec.allocations.filter(x => x.demandId !== d!.id);
      for (const row of sec.rows) row.assignments = row.assignments.filter(x => x.demandId !== d!.id);
      touch(); break;
    }
    case "weekly.v2.negotiate": {
      needAdmin(); editing(); const d = sec.demands.find(x => x.id === a.demandId); if (!d) fail("需求不存在");
      const quantity = a.quantity === null ? undefined : num(a.quantity, "协商数量");
      if (quantity !== undefined && quantity > d!.desired) fail("协商数量不能超过申请数量");
      d!.negotiated = quantity; touch(); break;
    }
    case "weekly.v2.negotiateMany": {
      needAdmin(); editing();
      if (!Array.isArray(a.values) || a.values.length > 200) fail("协商数量格式不正确");
      for (const value of a.values as { demandId: string; quantity: number | null; before?: number | null }[]) {
        const d = sec.demands.find(x => x.id === value.demandId); if (!d) fail("需求不存在");
        if (Object.hasOwn(value, "before") && value.before !== (d!.negotiated ?? null)) fail("协商数量已被其他人修改，输入已保留，请核对最新数据", 409);
        const quantity = value.quantity === null ? undefined : num(value.quantity, "协商数量");
        if (quantity !== undefined && quantity > d!.desired) fail("协商数量不能超过申请数量");
        d!.negotiated = quantity;
      }
      touch(); break;
    }
    case "weekly.v2.rows": {
      needAdmin(); editing(); if (part !== "day") fail("白天归属仅适用于白天流程");
      if (!Array.isArray(a.rows) || a.rows.length !== plan.resourceIds!.length) fail("请提交完整白天分配表");
      if (a.before !== undefined && JSON.stringify(a.before) !== JSON.stringify(sec.rows)) fail("白天分配已被修改，请保留输入并载入最新数据", 409);
      const rows = a.rows as WeeklyServerRow[];
      if (new Set(rows.map(x => x.resourceId)).size !== rows.length || rows.some(x => !plan.resourceIds!.includes(x.resourceId))) fail("服务器范围不正确");
      sec.rows = rows.map(row => ({ resourceId: row.resourceId, specialNote: text(row.specialNote ?? "", "特殊用途", false, 2000), assignments: ids(row.assignments?.map(x => x.groupId), "使用组").map(groupId => {
        if (!s.groups.some(g => g.id === groupId)) fail("使用组不存在");
        return { groupId, purpose: text(row.assignments.find(x => x.groupId === groupId)?.purpose ?? "", "使用用途", false) };
      }) }));
      // Resolve group rows against quantities without counting one physical server twice within a group.
      sec.allocations = []; const used = new Set<string>();
      for (const d of sec.demands) { const chosen = sec.rows.filter(row => row.assignments.some(x => x.groupId === d.groupId) && !used.has(`${d.groupId}/${row.resourceId}`)).slice(0, d.negotiated ?? 0); for (const row of chosen) { used.add(`${d.groupId}/${row.resourceId}`); const x = row.assignments.find(x => x.groupId === d.groupId)!; x.demandId = d.id; x.purpose = d.title; } sec.allocations.push({ demandId: d.id, slotId: "day", resourceIds: chosen.map(x => x.resourceId), locked: false }); }
      touch(); break;
    }
    case "weekly.v2.assign": {
      needAdmin(); editing(); const d = sec.demands.find(x => x.id === a.demandId); if (!d) fail("需求不存在");
      if (part !== "multi") fail("请在白天分配表调整白天归属");
      const slotId = text(a.slotId, "时段"), slots = d!.continuous ? d!.slotIds : [slotId];
      if (!d!.slotIds.includes(slotId)) fail("时段不属于该任务");
      const resourceIds = ids(a.resourceIds);
      if (a.before !== undefined && JSON.stringify(a.before) !== JSON.stringify(sec.allocations.filter(x => x.demandId === d!.id && slots.includes(x.slotId)))) fail("服务器分配已被其他人修改，输入已保留，请载入最新数据", 409);
      if (resourceIds.some(id => !plan.resourceIds!.includes(id))) fail("服务器不在资源池");
      for (const slotId of slots) {
        const slot = w.slots.find(x => x.id === slotId)!;
        if (!slot.enabled) fail("该时段未开放");
        if (resourceIds.some(id => resourceUnavailable(s, plan, s.resources.find(r => r.id === id)!, slot, now))) fail("所选服务器在任务时段内不可用", 409);
        if (sec.allocations.some(x => x.demandId !== d!.id && x.slotId === slotId && x.resourceIds.some(id => resourceIds.includes(id)))) fail("所选服务器在该时段已分给其他任务", 409);
      }
      sec.allocations = sec.allocations.filter(x => x.demandId !== d!.id || !slots.includes(x.slotId));
      sec.allocations.push(...slots.map(slotId => ({ demandId: d!.id, slotId, resourceIds: resourceIds.slice(), locked: a.locked === true })));
      touch(); break;
    }
    case "weekly.v2.recommend": {
      needAdmin(); editing(); if (sec.demands.some(d => d.negotiated === undefined)) fail("请先完成协商数量");
      sec = w.sections[part] = recommendSection(s, plan, part, now); touch(); break;
    }
    case "weekly.v2.stage": {
      needAdmin(); editing(); if (!["collecting", "draft", "confirming"].includes(String(a.status))) fail("阶段不正确");
      if (a.status === "confirming") { const issues = sectionIssues(s, plan, part, sec, now); if (issues.length) fail(issues[0], 409); if (!sectionGroups(plan, part).length) fail("尚无参与组"); }
      touch(); sec.status = a.status as WorkspaceSection["status"]; break;
    }
    case "weekly.v2.confirm": {
      if (sec.status !== "confirming") fail("当前不在确认阶段");
      const groupId = admin ? text(a.groupId, "确认组") : actor.groupId;
      if (!sectionGroups(plan, part).includes(groupId)) fail("该组没有参与本流程");
      if (!["confirmed", "changes"].includes(String(a.status))) fail("确认结果不正确");
      const note = text(a.note ?? "", "反馈或代确认原因", admin || a.status === "changes");
      sec.confirmations = sec.confirmations.filter(c => c.groupId !== groupId); sec.confirmations.push({ groupId, status: a.status as "confirmed" | "changes", note, at: now, by: actor.displayName }); plan.updatedAt = now; break;
    }
    case "weekly.v2.publish": {
      needAdmin(); if (sec.status !== "confirming") fail("请先提交各组确认");
      const required = sectionGroups(plan, part);
      if (!required.length || required.some(g => !sec.confirmations.some(c => c.groupId === g && c.status === "confirmed"))) fail("仍有组未确认或要求调整", 409);
      const issues = sectionIssues(s, plan, part, sec, now); if (issues.length) fail(`发布校验：${issues[0]}`, 409);
      // Revalidate the other published snapshot, never its unfinished draft.
      const other = part === "day" ? "multi" : "day", published = w.sections[other].published;
      if (published) {
        const savedSlots = w.slots; if (other === "multi") w.slots = published.slots;
        const errors = sectionIssues(s, plan, other, { ...w.sections[other], ...published }, now); w.slots = savedSlots;
        if (errors.length) fail(`另一流程已发布结果需先协调：${errors[0]}`, 409);
      }
      sec.published = { demands: structuredClone(sec.demands), allocations: structuredClone(sec.allocations), rows: structuredClone(sec.rows), slots: structuredClone(w.slots), publishedAt: now };
      sec.status = "published"; plan.status = "published"; plan.publishedAt = now; plan.updatedAt = now;
      if (part === "day") { plan.rows = structuredClone(sec.rows); for (const row of sec.rows) if (row.assignments.length > 1) { const r = s.resources.find(x => x.id === row.resourceId)!; r.sharingMode = "shared"; r.updatedAt = now; } }
      rebuildWorkspaceBookings(s, plan, now, actor); break;
    }
    default: fail("未知双流程排期操作");
  }
  audit("更新双流程排期", "weekly", plan.id, `${plan.weekStart}周 ${part === "day" ? "白天" : "多机"}：${a.type}`, before, plan);
}

/** Persist exclusions when ordinary cancellation/clearing affects generated bookings. */
export function suppressWorkspaceRanges(s: State, changes: { resourceId: string; startAt: string; endAt: string; planId: string; groupId?: string }[]) {
  for (const x of changes) { const p = s.weeklyPlans.find(p => p.id === x.planId); if (!p?.v2) continue; p.v2.suppressions.push({ resourceId: x.resourceId, startAt: x.startAt, endAt: x.endAt, groupId: x.groupId }); }
}
