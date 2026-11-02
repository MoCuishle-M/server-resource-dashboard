import type { Resource, State, WeeklyAllocation, WeeklyDemand, WeeklyLine, WeeklyPlan, WeeklyServerRow } from "./types";
import { weeklyPlanRange } from "./schedule";
import { overlappingTimeBlocks, timeBlockTitle } from "./resource-time-blocks";

export const SMOKE_NOTE = "每天北京时间 06:00–08:00 运行冒烟；如果失败，问题定位具有最高优先级。";
export const CANADA_NOTE = "每天北京时间 23:00–次日09:00，加拿大研究所仅使用空闲卡；不占卡、不 kill 程序、不动已有进程与容器。";
export const tableDemands = (s: State, p: WeeklyPlan) => s.weeklyDemands.filter(d => d.planId === p.id && d.status === "active");
export const rackKey = (r?: Resource) => r?.rack ? `${r.zone || ""}/${r.location}/${r.rack}` : "";
export function matchesTableLine(r: Resource, l: WeeklyLine) {
  return !r.deleted && !r.hidden && r.status === "available" && (l.resourceType ? r.type === l.resourceType && r.accessMode === l.accessMode : r.zone === l.zone && r.family === l.family && r.accessMode === l.accessMode);
}
export function tableRows(s: State, p: WeeklyPlan): WeeklyServerRow[] {
  if (p.layout === "table") return p.rows ?? [];
  const result = new Map<string, WeeklyServerRow>();
  for (const a of p.allocations) {
    const d = s.weeklyDemands.find(d => d.id === a.demandId && d.status === "active");
    if (!d || p.deferred.some(x => x.demandId === d.id)) continue;
    for (const id of a.resourceIds) {
      const row = result.get(id) ?? { resourceId: id, assignments: [], specialNote: "" };
      if (!row.assignments.some(x => x.groupId === d.groupId)) row.assignments.push({ groupId: d.groupId, purpose: d.title, demandId: d.id, lineId: a.lineId });
      result.set(id, row);
    }
  }
  return [...result.values()];
}
export function tableGroups(s: State, p: WeeklyPlan) {
  return [...new Set([...tableDemands(s, p).map(d => d.groupId), ...tableRows(s, p).flatMap(r => r.assignments.map(a => a.groupId))])];
}
// Constant group assignments can satisfy one matching demand line for that group.
// A shared physical server counts once for each group, never twice within a group.
export function tableAllocations(s: State, p: WeeklyPlan): WeeklyAllocation[] {
  const rows = tableRows(s, p), used = new Set<string>();
  const result: WeeklyAllocation[] = [];
  for (const d of tableDemands(s, p)) for (const l of d.lines) {
    const eligible = rows.filter(row => {
      const r = s.resources.find(r => r.id === row.resourceId);
      return r && matchesTableLine(r, l) && row.assignments.some(a => a.groupId === d.groupId && a.demandId === d.id && a.lineId === l.id);
    });
    const target = l.negotiated ?? (d.table ? 0 : l.minimum);
    for (const row of rows) {
      if (eligible.length >= target) break;
      const r = s.resources.find(r => r.id === row.resourceId);
      if (r && matchesTableLine(r, l) && !used.has(`${d.groupId}/${r.id}`) && !eligible.includes(row)
        && row.assignments.some(a => a.groupId === d.groupId && !a.demandId)) eligible.push(row);
    }
    const ids = eligible.map(r => r.resourceId);
    ids.forEach(id => used.add(`${d.groupId}/${id}`));
    result.push({ demandId: d.id, lineId: l.id, resourceIds: ids, sharedResourceIds: eligible.filter(r => r.assignments.length > 1).map(r => r.resourceId), locked: false, note: "" });
  }
  return result;
}
export type TableIssue = { severity: "error" | "warning"; message: string };
export function checkTablePlan(s: State, p: WeeklyPlan, now = new Date().toISOString()): TableIssue[] {
  const issues: TableIssue[] = [], rows = tableRows(s, p), allocations = tableAllocations(s, p);
  const range = weeklyPlanRange(p);
  const add = (message: string, severity: TableIssue["severity"] = "error") => issues.push({ severity, message });
  for (const row of rows) {
    const r = s.resources.find(r => r.id === row.resourceId);
    if (!r || r.deleted || r.hidden || !(p.resourceIds ?? []).includes(row.resourceId)) { add("排期包含不在参与范围内或不可见的服务器"); continue; }
    if (!row.assignments.length) continue;
    if (r.status !== "available") add(`${r.ip} 当前故障、维护中或不可用`);
    const blocks = overlappingTimeBlocks(r, { startAt: range.startAt < now ? now : range.startAt, endAt: range.endAt });
    if (blocks.length) add(`${r.ip} 存在${blocks.map(timeBlockTitle).join("、")}，请先协调时段标记`);
    if (s.bookings.some(b => b.resourceId === r.id && b.status === "scheduled" && b.endAt > now && b.startAt < range.endAt && b.endAt > range.startAt
      && s.requests.find(q => q.id === b.requestId)?.weeklyPlanId !== p.id)) add(`${r.ip} 已有正式预约，请先协调或清空该服务器排期`);
    for (const a of row.assignments) {
      if (!s.groups.some(g => g.id === a.groupId)) add(`${r.ip} 的使用组已不存在`);
      if (a.demandId && !tableDemands(s, p).some(d => d.id === a.demandId && d.groupId === a.groupId && d.lines.some(l => l.id === a.lineId && matchesTableLine(r, l)))) add(`${r.ip} 的需求关联无效或类型不匹配`);
    }
  }
  for (const d of tableDemands(s, p)) for (const l of d.lines) {
    const a = allocations.find(a => a.demandId === d.id && a.lineId === l.id)!;
    const target = l.negotiated ?? (d.table ? undefined : l.minimum);
    if (target === undefined) { add(`${d.title}：请管理员填写协商后数量`); continue; }
    if (a.resourceIds.length !== target) add(`${d.title}：协商后需${target}台，已分配${a.resourceIds.length}台${a.resourceIds.length < target ? `，缺${target - a.resourceIds.length}台` : "，请调整多分配的机器"}`);
    if (a.sharedResourceIds.length > l.shareCount) add(`${d.title}：共用${a.sharedResourceIds.length}台，超过允许共用的${l.shareCount}台`);
    const rs = a.resourceIds.map(id => s.resources.find(r => r.id === id)!);
    const rackCounts = new Map<string, number>();
    for (const r of rs) if (rackKey(r)) rackCounts.set(rackKey(r), (rackCounts.get(rackKey(r)) ?? 0) + 1);
    const need = target === 0 ? 0 : l.sameRackCount ?? (l.rackPolicy === "required" ? target : 0);
    if (need > 0 && Math.max(0, ...rackCounts.values()) < need) add(`${d.title}：未满足至少${need}台在同一柜的要求`);
    for (const groupId of l.sameRackGroupIds ?? []) {
      const peers = rows.filter(row => row.assignments.some(x => x.groupId === groupId)).map(row => rackKey(s.resources.find(r => r.id === row.resourceId))).filter(Boolean);
      if (target > 0 && (!rs.length || rs.some(r => !rackKey(r) || !peers.includes(rackKey(r))))) add(`${d.title}：未满足与${s.groups.find(g => g.id === groupId)?.name ?? groupId}同柜的要求`);
    }
    if (l.requirements) add(`${d.title}：请核对文字要求：${l.requirements}`, "warning");
  }
  return issues;
}

export function inheritedTableRows(s: State, previous?: WeeklyPlan, now = new Date().toISOString()): WeeklyServerRow[] {
  const rows = new Map<string, WeeklyServerRow>();
  if (previous) for (const row of tableRows(s, previous)) rows.set(row.resourceId, {
    resourceId: row.resourceId, specialNote: row.specialNote,
    assignments: previous.clearedResourceIds?.includes(row.resourceId) ? [] : row.assignments.map(a => ({ groupId: a.groupId, purpose: a.purpose })),
  });
  if (!previous) for (const b of s.bookings.filter(b => b.status === "scheduled" && b.startAt <= now && b.endAt > now)) {
    const row = rows.get(b.resourceId) ?? { resourceId: b.resourceId, assignments: [], specialNote: "" };
    if (!row.assignments.some(a => a.groupId === b.groupId)) row.assignments.push({ groupId: b.groupId, purpose: b.purpose });
    rows.set(b.resourceId, row);
  }
  for (const row of s.settings.weeklyDefaults ?? []) if (!previous || !rows.has(row.resourceId)) rows.set(row.resourceId, structuredClone(row));
  return [...rows.values()];
}

/** Scheduling baseline, explicitly separate from an AI model. */
export function recommendTableRows(s: State, p: WeeklyPlan): WeeklyServerRow[] {
  const rows = structuredClone(tableRows(s, p));
  const range = weeklyPlanRange(p);
  // Keep prior/default assignments; place only the unfilled part of each demand.
  const byId = new Map(rows.map(r => [r.resourceId, r]));
  for (const d of tableDemands(s, p)) for (const l of d.lines) {
    const target = l.negotiated ?? 0;
    let assigned = tableAllocations(s, { ...p, rows }).find(a => a.demandId === d.id && a.lineId === l.id)!.resourceIds;
    if (assigned.length >= target) continue;
    const peers = new Set((l.sameRackGroupIds ?? []).flatMap(g => rows.filter(row => row.assignments.some(a => a.groupId === g)).map(row => rackKey(s.resources.find(r => r.id === row.resourceId)))).filter(Boolean));
    let candidates = s.resources.filter(r => (p.resourceIds ?? []).includes(r.id) && matchesTableLine(r, l) && !assigned.includes(r.id)
      && !overlappingTimeBlocks(r, range).length
      && !byId.get(r.id)?.assignments.some(a => a.groupId === d.groupId)
      && !s.bookings.some(b => b.resourceId === r.id && b.status === "scheduled" && b.startAt < range.endAt && b.endAt > range.startAt && s.requests.find(q => q.id === b.requestId)?.weeklyPlanId !== p.id)
      && (!peers.size || peers.has(rackKey(r))));
    const rank = (r: Resource) => Number((s.settings.weeklyDefaults ?? []).some(row => row.resourceId === r.id && row.assignments.some(a => a.groupId === d.groupId))) * 100
      + Number(s.bookings.some(b => b.groupId === d.groupId && b.resourceId === r.id)) * 10;
    const bucketScores = new Map<string, number>();
    for (const r of candidates) if (rackKey(r)) bucketScores.set(rackKey(r), (bucketScores.get(rackKey(r)) ?? 0) + 1 + rank(r));
    for (const id of assigned) { const key = rackKey(s.resources.find(r => r.id === id)); if (key) bucketScores.set(key, (bucketScores.get(key) ?? 0) + 1000); }
    candidates = candidates.sort((a, b) => rank(b) - rank(a) || (bucketScores.get(rackKey(b)) ?? 0) - (bucketScores.get(rackKey(a)) ?? 0) || a.ip.localeCompare(b.ip));
    for (const r of candidates) {
      const row = byId.get(r.id)!;
      if (row.assignments.length) {
        const current = tableAllocations(s, { ...p, rows });
        const ownShare = current.find(a => a.demandId === d.id && a.lineId === l.id)!.sharedResourceIds.length;
        if (ownShare >= l.shareCount) continue;
        const wouldBreakPeer = row.assignments.some(peer => {
          const other = current.find(a => a.resourceIds.includes(r.id) && tableDemands(s, p).some(d => d.id === a.demandId && d.groupId === peer.groupId));
          if (!other) return false;
          const otherLine = tableDemands(s, p).find(d => d.id === other.demandId)!.lines.find(l => l.id === other.lineId)!;
          return !other.sharedResourceIds.includes(r.id) && other.sharedResourceIds.length >= otherLine.shareCount;
        });
        if (wouldBreakPeer) continue;
      }
      row.assignments.push({ groupId: d.groupId, demandId: d.id, lineId: l.id, purpose: d.title });
      assigned = tableAllocations(s, { ...p, rows }).find(a => a.demandId === d.id && a.lineId === l.id)!.resourceIds;
      if (assigned.length >= target) break;
    }
  }
  return rows;
}

export function clearFutureSchedules(s: State, resourceIds: string[], now: string) {
  const ids = new Set(resourceIds), clearedRequests = new Set<string>();
  for (const b of s.bookings) if (ids.has(b.resourceId) && ["scheduled", "preempted"].includes(b.status) && b.endAt > now) {
    clearedRequests.add(b.requestId);
    if (b.startAt < now) { b.endAt = now; if (b.status === "scheduled") b.status = "released"; }
    else b.status = "cancelled";
    b.updatedAt = now;
  }
  for (const q of s.requests) {
    if (q.status === "approved" && clearedRequests.has(q.id) && !s.bookings.some(b => b.requestId === q.id && ["scheduled", "preempted"].includes(b.status) && b.endAt > now)) q.status = "cancelled";
    if (q.status === "pending" && q.endAt > now) { q.resourceIds = q.resourceIds.filter(id => !ids.has(id)); if (!q.resourceIds.length) q.status = "cancelled"; }
    if (q.pendingExtension) {
      q.pendingExtension.resourceIds = q.pendingExtension.resourceIds.filter(id => !ids.has(id));
      if (!q.pendingExtension.resourceIds.length) delete q.pendingExtension;
    }
  }
  for (const p of s.weeklyPlans) {
    if (weeklyPlanRange(p).endAt <= now) continue;
    const affected = resourceIds.filter(id => tableRows(s, p).some(r => r.resourceId === id && r.assignments.length));
    if (!affected.length) continue;
    if (p.status === "published") { p.clearedResourceIds = [...new Set([...(p.clearedResourceIds ?? []), ...affected])]; p.updatedAt = now; continue; }
    if (p.layout === "table") for (const row of p.rows ?? []) if (ids.has(row.resourceId)) row.assignments = [];
    for (const a of p.allocations) { a.resourceIds = a.resourceIds.filter(id => !ids.has(id)); a.sharedResourceIds = a.sharedResourceIds.filter(id => !ids.has(id)); }
    p.confirmations = []; if (p.status === "confirming") p.status = "draft"; p.updatedAt = now;
  }
}
