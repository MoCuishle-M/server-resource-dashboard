import type { Resource, State, WeeklyAllocation, WeeklyDemand, WeeklyLine, WeeklyPlan } from "./types";
import { calendarRange } from "./schedule";
import { overlappingTimeBlocks, timeBlockTitle } from "./resource-time-blocks";

export const weeklyCategoryLabels = { version: "版本需求", model: "模型开箱", ticket: "问题单", customer: "客户面问题" };
export const weeklyStatusLabels = { collecting: "需求收集中", draft: "排期草稿", confirming: "待各组确认", published: "已发布" };
export const weeklyZoneLabels = { green: "绿区", blue: "蓝区" };
export const lineKey = (a: Pick<WeeklyAllocation, "demandId" | "lineId">) => `${a.demandId}/${a.lineId}`;
export const weeklyDemands = (s: State, p: WeeklyPlan) => s.weeklyDemands.filter(d => d.planId === p.id && d.status === "active");
export function demandRange(p: WeeklyPlan, d: WeeklyDemand) {
  return d.holdMode === "week" ? calendarRange(p.weekStart, "week") : { startAt: d.expectedStart, endAt: d.expectedEnd };
}
export function rangeOverlaps(a: { startAt: string; endAt: string }, b: { startAt: string; endAt: string }) {
  return a.startAt < b.endAt && b.startAt < a.endAt;
}
export function matchesWeeklyLine(r: Resource, l: WeeklyLine) {
  return !r.deleted && !r.hidden && r.status === "available" && r.zone === l.zone && r.family === l.family && r.accessMode === l.accessMode;
}
export function historicalResources(s: State, p: WeeklyPlan, d: WeeklyDemand) {
  const before = calendarRange(p.weekStart, "week").startAt;
  // Reservation history is a continuity hint, not measured device utilization.
  const previous = s.bookings.filter(b => b.groupId === d.groupId && ["scheduled", "released"].includes(b.status)
    && b.startAt < before && b.endAt > new Date(Date.parse(before) - 14 * 86400000).toISOString())
    .sort((a, b) => b.endAt.localeCompare(a.endAt));
  return [...new Set(previous.map(b => b.resourceId))];
}
function sharingAllowed(s: State, a: WeeklyAllocation, d: WeeklyDemand, b: WeeklyAllocation, other: WeeklyDemand, id: string) {
  return s.resources.find(r => r.id === id)?.sharingMode === "shared"
    && a.sharedResourceIds.includes(id) && b.sharedResourceIds.includes(id)
    && d.shareWithDemandIds.includes(other.id) && other.shareWithDemandIds.includes(d.id)
    && !!d.shareNote && !!other.shareNote;
}
export type WeeklyIssue = { severity: "error" | "warning"; demandId: string; message: string };
export function checkWeeklyPlan(s: State, p: WeeklyPlan): WeeklyIssue[] {
  const issues: WeeklyIssue[] = [];
  const ds = weeklyDemands(s, p);
  const add = (severity: WeeklyIssue["severity"], d: WeeklyDemand, message: string) => issues.push({ severity, demandId: d.id, message: `${d.title}：${message}` });
  for (const d of ds) {
    const deferred = p.deferred.find(x => x.demandId === d.id);
    if (deferred) { add("warning", d, `本周暂缓；${deferred.reason}`); continue; }
    const range = demandRange(p, d);
    if (d.expectedEnd > d.deadline) add("warning", d, "预计结束晚于DDL，请确认交付风险");
    for (const l of d.lines) {
      const a = p.allocations.find(x => x.demandId === d.id && x.lineId === l.id);
      const ids = a?.resourceIds ?? [];
      const label = `${weeklyZoneLabels[l.zone]}${l.family} ${l.accessMode === "bare" ? "裸机" : "灵枢"}`;
      if (ids.length < l.minimum) add("error", d, `${label}最低${l.minimum}台，已分配${ids.length}台，缺${l.minimum - ids.length}台`);
      else if (ids.length < l.desired) add("warning", d, `${label}理想${l.desired}台，已满足最低数量，少${l.desired - ids.length}台`);
      if (ids.length > l.desired || new Set(ids).size !== ids.length) add("error", d, "分配数量超过理想数量或存在重复服务器");
      const rs = ids.map(id => s.resources.find(r => r.id === id));
      if (rs.some(r => !r || !matchesWeeklyLine(r, l))) add("error", d, `${label}含类型不匹配、隐藏、故障或不可用服务器`);
      if (l.mode === "multi" && ids.length > 1) {
        const same = rs.every(r => !!r?.rack) && new Set(rs.map(r => `${r?.zone}/${r?.location}/${r?.rack}`)).size === 1;
        if (!same && l.rackPolicy !== "any") add(l.rackPolicy === "required" ? "error" : "warning", d, `${label}未满足同柜要求（含未登记机柜）`);
      }
      if (a && (a.sharedResourceIds.length > l.shareCount || a.sharedResourceIds.some(id => !ids.includes(id)))) add("error", d, "共享服务器超出允许数量或未分配");
      for (const id of ids) {
        const r = s.resources.find(x => x.id === id);
        const blocks = overlappingTimeBlocks(r, range);
        if (blocks.length) add("error", d, `${r?.name ?? id}存在${blocks.map(timeBlockTitle).join("、")}，请先协调`);
        if (s.bookings.some(b => b.resourceId === id && b.status === "scheduled" && rangeOverlaps(b, range)
          && s.requests.find(q => q.id === b.requestId)?.weeklyPlanId !== p.id))
          add("error", d, `${r?.name ?? id}已有正式预约，请先协调；本周排期不会自动抢占`);
      }
    }
  }
  const as = p.allocations.filter(a => ds.some(d => d.id === a.demandId) && !p.deferred.some(x => x.demandId === a.demandId));
  for (let i = 0; i < as.length; i++) for (let j = i + 1; j < as.length; j++) {
    const a = as[i], b = as[j];
    const d = ds.find(x => x.id === a.demandId)!, other = ds.find(x => x.id === b.demandId)!;
    if (!rangeOverlaps(demandRange(p, d), demandRange(p, other))) continue;
    for (const id of a.resourceIds.filter(id => b.resourceIds.includes(id)))
      if (!sharingAllowed(s, a, d, b, other, id)) add("error", d, `${s.resources.find(r => r.id === id)?.name ?? id}与“${other.title}”冲突；共享需双方指定任务、具体机器和数量`);
  }
  return issues;
}

/** Deterministic greedy baseline: minimum quantities for whole tasks, then optional extras.
 * It reports unresolved conflicts; it does not claim global optimality or alter constraints. */
export function suggestWeeklyPlan(s: State, p: WeeklyPlan, historyOnly = false): WeeklyAllocation[] {
  const ds = weeklyDemands(s, p).filter(d => !p.deferred.some(x => x.demandId === d.id));
  const result = p.allocations.filter(a => a.locked && ds.some(d => d.id === a.demandId)).map(a => structuredClone(a));
  const ordered = [...ds].sort((a, b) => a.deadline.localeCompare(b.deadline)
    || Number(b.lines.some(l => l.rackPolicy === "required")) - Number(a.lines.some(l => l.rackPolicy === "required"))
    || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  function candidates(d: WeeklyDemand, l: WeeklyLine, current: WeeklyAllocation[]) {
    const history = historicalResources(s, p, d);
    const preferred = [...l.preferredResourceIds, ...(p.allocations.find(a => a.demandId === d.id && a.lineId === l.id)?.resourceIds ?? []), ...history];
    const range = demandRange(p, d);
    return s.resources.filter(r => matchesWeeklyLine(r, l) && (!historyOnly || preferred.includes(r.id))
      && !overlappingTimeBlocks(r, range).length
      && !s.bookings.some(b => b.resourceId === r.id && b.status === "scheduled" && rangeOverlaps(b, range))
      // Automatic allocation is conservative: simultaneous sharing is explicit manual coordination.
      && !current.some(a => a.resourceIds.includes(r.id) && rangeOverlaps(demandRange(p, ds.find(x => x.id === a.demandId)!), range)))
      .sort((a, b) => Number(preferred.includes(b.id)) - Number(preferred.includes(a.id))
        || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }
  function choose(d: WeeklyDemand, l: WeeklyLine, n: number, current: WeeklyAllocation[], existing: string[] = []) {
    let rs = candidates(d, l, current);
    if (l.mode === "multi" && l.rackPolicy !== "any") {
      const rackKey = (r: Resource) => r.rack ? `${r.zone}/${r.location}/${r.rack}` : "";
      const existingRack = existing.length ? rackKey(s.resources.find(r => r.id === existing[0])!) : "";
      const buckets = [...new Set(rs.map(rackKey).filter(Boolean))]
        .filter(key => !existing.length || key === existingRack)
        .map(key => rs.filter(r => rackKey(r) === key)).filter(bucket => bucket.length >= n)
        .sort((a, b) => Number(l.preferredResourceIds.includes(b[0].id)) - Number(l.preferredResourceIds.includes(a[0].id))
          || Number(historicalResources(s, p, d).includes(b[0].id)) - Number(historicalResources(s, p, d).includes(a[0].id))
          || b.length - a.length || a[0].name.localeCompare(b[0].name));
      if (buckets.length) rs = buckets[0];
      else if (l.rackPolicy === "required") return [];
    }
    return rs.length >= n ? rs.slice(0, n).map(r => r.id) : [];
  }
  for (const d of ordered) {
    const trial = structuredClone(result);
    let complete = true;
    for (const l of d.lines) {
      const locked = trial.find(a => a.demandId === d.id && a.lineId === l.id);
      if (locked) { if (locked.resourceIds.length < l.minimum) complete = false; continue; }
      const ids = choose(d, l, l.minimum, trial);
      if (ids.length < l.minimum) { complete = false; break; }
      trial.push({ demandId: d.id, lineId: l.id, resourceIds: ids, sharedResourceIds: [], locked: false,
        note: historyOnly ? "沿用已有分配候选；请检查本周条件" : "规则推荐：先满足最低数量，再补理想数量；优先沿用、优先同柜" });
    }
    if (complete) { result.splice(0, result.length, ...trial); }
  }
  if (!historyOnly) for (const d of ordered) for (const l of d.lines) {
    const a = result.find(x => x.demandId === d.id && x.lineId === l.id);
    if (!a || a.locked) continue;
    for (let n = l.desired - a.resourceIds.length; n > 0; n--) {
      const extra = choose(d, l, n, result, a.resourceIds);
      if (extra.length) { a.resourceIds.push(...extra); break; }
    }
  }
  return result;
}
