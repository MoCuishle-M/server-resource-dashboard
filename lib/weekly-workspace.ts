import type { Resource, State, WeeklyPlan, WeeklySectionName, WeeklySlot, WorkspaceAllocation, WorkspaceDemand, WorkspaceSection, WorkspaceSnapshot } from "./types";
import { shiftDate, weeklyPlanRange } from "./schedule";
import { overlappingTimeBlocks } from "./resource-time-blocks";

export const workspaceRange = (p: WeeklyPlan) => ({ startAt: p.v2!.startAt, endAt: weeklyPlanRange(p).endAt });
export const overlaps = (a: { startAt: string; endAt: string }, b: { startAt: string; endAt: string }) => a.startAt < b.endAt && b.startAt < a.endAt;
export const blueA5 = (r: Resource) => !r.deleted && !r.hidden && r.zone === "blue" && r.family === "A5" && r.accessMode === "bare";
export const chinaStamp = (v: string) => new Date(Date.parse(v) + 28800000).toISOString().slice(0, 16).replace("T", " ");
export function makeWeeklySlots(week: string): WeeklySlot[] {
  const result: WeeklySlot[] = [], days = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
  const at = (day: number, h: number) => new Date(`${shiftDate(week, day)}T${String(h).padStart(2, "0")}:00:00+08:00`).toISOString();
  for (let day = 0; day < 7; day++) {
    if (day >= 5) for (const [part, from, to] of [["上午", 9, 14], ["下午", 14, 19]] as const)
      result.push({ id: `${day}-${part}`, label: `${days[day]} ${shiftDate(week, day)} ${part} ${from}:00–${to}:00`, startAt: at(day, from), endAt: at(day, to), enabled: day !== 5, saturdayDay: day === 5 });
    const h = [21, 21, 19, 21, 19, 19, 19][day];
    result.push({ id: `${day}-晚上`, label: `${days[day]} ${shiftDate(week, day)} ${h}:00–24:00`, startAt: at(day, h), endAt: at(day + 1, 0), enabled: true, saturdayDay: false });
    result.push({ id: `${day}-凌晨`, label: `${days[day]}夜间后 ${shiftDate(week, day + 1)} 00:00–09:00`, startAt: at(day + 1, 0), endAt: at(day + 1, 9), enabled: true, saturdayDay: false });
  }
  return result;
}
export function resourceUnavailable(s: State, p: WeeklyPlan, r: Resource, range: { startAt: string; endAt: string }, now?: string) {
  const future = now && range.startAt < now ? { ...range, startAt: now } : range;
  if (future.startAt >= future.endAt) return false;
  return !blueA5(r) || r.status !== "available" || overlappingTimeBlocks(r, future).length > 0
    || s.bookings.some(b => b.resourceId === r.id && b.status === "scheduled" && overlaps(b, future) && s.requests.find(q => q.id === b.requestId)?.weeklyPlanId !== p.id)
    ;
}
export function workspaceCapacity(s: State, p: WeeklyPlan, slot: WeeklySlot, section = p.v2!.sections.multi) {
  const pool = s.resources.filter(r => p.resourceIds?.includes(r.id) && !r.hidden && !r.deleted);
  const available = pool.filter(r => !resourceUnavailable(s, p, r, slot, (s as State & { now?: string }).now));
  const demands = section.demands.filter(d => d.slotIds.includes(slot.id));
  const assigned = new Set(section.allocations.filter(a => a.slotId === slot.id).flatMap(a => a.resourceIds));
  const requested = demands.reduce((n, d) => n + d.desired, 0), negotiated = demands.reduce((n, d) => n + (d.negotiated ?? 0), 0);
  return { total: pool.length, unavailable: pool.length - available.length, available: available.length, requested, negotiated, pending: demands.filter(d => d.negotiated === undefined).length,
    assigned: assigned.size, remaining: Math.max(0, available.length - assigned.size), requestExcess: Math.max(0, requested - available.length), excess: Math.max(0, negotiated - available.length), negotiatedRemaining: Math.max(0, available.length - negotiated) };
}
export function sectionGroups(p: WeeklyPlan, part: WeeklySectionName, sec = p.v2!.sections[part]) {
  return [...new Set(part === "day" ? [...p.v2!.participantGroupIds, ...sec.demands.map(d => d.groupId), ...sec.rows.flatMap(r => r.assignments.map(a => a.groupId))] : sec.demands.map(d => d.groupId))];
}
export function demandAssigned(sec: WorkspaceSection | WorkspaceSnapshot, d: WorkspaceDemand, slotId = "day") {
  return sec.allocations.find(a => a.demandId === d.id && a.slotId === slotId)?.resourceIds ?? [];
}
export function sectionIssues(s: State, p: WeeklyPlan, part: WeeklySectionName, sec = p.v2!.sections[part], now = "") {
  const issues: string[] = [], w = p.v2!, slots = part === "day" ? [{ id: "day", ...workspaceRange(p), enabled: true }] : w.slots;
  const pool = new Map(s.resources.filter(r => p.resourceIds?.includes(r.id)).map(r => [r.id, r]));
  if (!pool.size) issues.push("请选择参与排期的蓝区 A5 服务器");
  for (const d of sec.demands) {
    if (d.negotiated === undefined) issues.push(`${d.title}：待填写协商数量`);
    for (const slotId of part === "day" ? ["day"] : d.slotIds) {
      const slot = slots.find(x => x.id === slotId), ids = demandAssigned(sec, d, slotId);
      if (!slot?.enabled) issues.push(`${d.title}：选择了未开放时段`);
      if (ids.length !== (d.negotiated ?? 0)) issues.push(`${d.title}：${slotId} 协商${d.negotiated ?? "待定"}台，已分配${ids.length}台`);
      const racks = new Map<string, number>();
      for (const id of ids) { const r = pool.get(id); if (r?.rack) { const k = `${r.zone}/${r.location}/${r.rack}`; racks.set(k, (racks.get(k) ?? 0) + 1); } }
      if ((d.negotiated ?? 0) > 0 && Math.max(0, ...racks.values()) < Math.min(d.sameRackCount, d.negotiated ?? 0)) issues.push(`${d.title}：未满足同柜要求`);
    }
    if (part === "multi" && d.continuous) {
      const chosen = d.slotIds.map(id => w.slots.find(x => x.id === id)!).filter(Boolean).sort((a, b) => a.startAt.localeCompare(b.startAt));
      if (chosen.some((x, i) => i > 0 && chosen[i - 1].endAt !== x.startAt)) issues.push(`${d.title}：必须选择连续时段`);
      const batches = d.slotIds.map(id => [...demandAssigned(sec, d, id)].sort().join(","));
      if (new Set(batches).size > 1) issues.push(`${d.title}：连续任务必须使用同一批服务器`);
    }
  }
  for (const a of sec.allocations) {
    const d = sec.demands.find(d => d.id === a.demandId);
    if (!d || !(part === "day" ? a.slotId === "day" : d.slotIds.includes(a.slotId))) issues.push("存在失效的需求分配");
    if (new Set(a.resourceIds).size !== a.resourceIds.length) issues.push("分配中存在重复服务器");
  }
  for (const slot of slots) {
    const assignments = new Map<string, Set<string>>();
    if (part === "day") for (const row of sec.rows) {
      if (row.assignments.length && (!pool.get(row.resourceId) || resourceUnavailable(s, p, pool.get(row.resourceId)!, slot, now))) issues.push(`${pool.get(row.resourceId)?.ip ?? row.resourceId}：不在资源池或该时段不可用`);
      assignments.set(row.resourceId, new Set(row.assignments.map(x => x.groupId)));
    }
    for (const a of sec.allocations.filter(x => x.slotId === slot.id)) for (const id of a.resourceIds) {
      const r = pool.get(id), group = sec.demands.find(d => d.id === a.demandId)?.groupId;
      if (!r || resourceUnavailable(s, p, r, slot, now)) issues.push(`${r?.ip ?? id}：不在资源池或该时段不可用`);
      if (part === "multi") { if (assignments.has(id)) issues.push(`${r?.ip}：同一时段分配给多个任务`); assignments.set(id, new Set([group ?? ""])); }
      else if (!assignments.get(id)?.has(group ?? "")) issues.push(`${r?.ip}：需求分配与白天归属不一致`);
    }
    if (part === "day") {
      for (const g of w.participantGroupIds) if (![...assignments.values()].some(x => x.has(g))) issues.push(`${s.groups.find(x => x.id === g)?.name ?? g}：常态分配至少一台（可共用）`);
      for (const d of sec.demands) {
        const ids = demandAssigned(sec, d), shared = ids.filter(id => (assignments.get(id)?.size ?? 0) > 1).length;
        if (shared > d.shareCount) issues.push(`${d.title}：共用${shared}台，超过允许的${d.shareCount}台`);
      }
      for (const g of new Set(sec.demands.map(d => d.groupId))) {
        const all = sec.demands.filter(d => d.groupId === g).flatMap(d => demandAssigned(sec, d));
        if (new Set(all).size !== all.length) issues.push("同组的不同白天需求不能重复计入同一台服务器");
      }
    }
  }
  return [...new Set(issues)];
}
export function recommendSection(s: State, p: WeeklyPlan, part: WeeklySectionName, now?: string) {
  const sec = structuredClone(p.v2!.sections[part]), w = p.v2!;
  const old = structuredClone(sec.allocations);
  sec.allocations = sec.allocations.filter(a => a.locked);
  const dayRows = structuredClone(part === "day" ? sec.rows : w.sections.day.published?.rows ?? w.sections.day.rows);
  if (part === "day") for (const row of sec.rows) row.assignments = row.assignments.filter(x => !sec.demands.some(d => d.groupId === x.groupId) || sec.allocations.some(a => sec.demands.find(d => d.id === a.demandId)?.groupId === x.groupId && a.resourceIds.includes(row.resourceId)));
  for (const d of sec.demands) {
    const batches = part === "day" ? [["day"]] : d.continuous ? [d.slotIds] : d.slotIds.map(id => [id]);
    for (const batch of batches) {
      const ranges = batch.map(id => id === "day" ? { id, ...workspaceRange(p) } : w.slots.find(x => x.id === id)!);
      const locked = sec.allocations.filter(a => a.demandId === d.id && batch.includes(a.slotId) && a.locked);
      let ids = locked[0]?.resourceIds.slice() ?? [];
      const free = (r: Resource) => !ranges.some(range => resourceUnavailable(s, p, r, range, now) || w.suppressions.some(x => x.resourceId === r.id && (!x.groupId || x.groupId === d.groupId) && overlaps(x, range))) && !sec.allocations.some(a => a.demandId !== d.id && a.resourceIds.includes(r.id) && (part === "day" ? sec.demands.find(x => x.id === a.demandId)?.groupId === d.groupId : batch.includes(a.slotId)))
        && (part !== "day" || !sec.rows.find(row => row.resourceId === r.id)?.assignments.some(a => a.groupId !== d.groupId));
      const candidates = s.resources.filter(r => p.resourceIds?.includes(r.id) && free(r));
      const prior = new Set(old.filter(a => a.demandId === d.id && batch.includes(a.slotId)).flatMap(a => a.resourceIds));
      const own = new Set(dayRows.filter(row => row.assignments.some(a => a.groupId === d.groupId)).map(r => r.resourceId));
      const adjacent = new Set(old.filter(a => sec.demands.find(x => x.id === a.demandId)?.groupId === d.groupId && w.slots.some(slot => slot.id === a.slotId && ranges.some(range => slot.endAt === range.startAt || slot.startAt === range.endAt))).flatMap(a => a.resourceIds));
      const rackScore = (r: Resource) => candidates.filter(x => x.rack && x.rack === r.rack && x.location === r.location).length;
      candidates.sort((a, b) => Number(prior.has(b.id)) - Number(prior.has(a.id)) || Number(own.has(b.id)) - Number(own.has(a.id)) || Number(adjacent.has(b.id)) - Number(adjacent.has(a.id)) || rackScore(b) - rackScore(a) || a.ip.localeCompare(b.ip));
      if (!locked.length) {
        // When a hard same-rack minimum is requested, select that cluster first.
        const need = Math.min(d.sameRackCount, d.negotiated ?? 0);
        if (need > 0) { const anchor = candidates.find(r => r.rack && candidates.filter(x => x.rack === r.rack && x.location === r.location).length >= need); if (anchor) ids = candidates.filter(x => x.rack === anchor.rack && x.location === anchor.location).slice(0, need).map(r => r.id); }
        for (const r of candidates) if (ids.length < (d.negotiated ?? 0) && !ids.includes(r.id)) ids.push(r.id);
        // Explicitly permitted shared day assignments are a fallback, with peer limits checked.
        if (part === "day" && ids.length < (d.negotiated ?? 0)) for (const row of sec.rows) {
          const r = s.resources.find(r => r.id === row.resourceId)!;
          if (ids.includes(row.resourceId) || !r || !p.resourceIds?.includes(r.id) || resourceUnavailable(s, p, r, workspaceRange(p), now) || w.suppressions.some(x => x.resourceId === r.id && (!x.groupId || x.groupId === d.groupId))) continue;
          const sharedSoFar = ids.filter(id => sec.rows.find(row => row.resourceId === id)?.assignments.some(a => a.groupId !== d.groupId)).length;
          if (sharedSoFar >= d.shareCount || row.assignments.some(a => a.groupId === d.groupId)) continue;
          const peerOk = row.assignments.every(a => { const peer = sec.demands.find(x => x.id === a.demandId); return !peer || demandAssigned(sec, peer).filter(id => (sec.rows.find(row => row.resourceId === id)?.assignments.length ?? 0) > 1).length < peer.shareCount; });
          if (peerOk) ids.push(row.resourceId);
          if (ids.length >= (d.negotiated ?? 0)) break;
        }
      }
      for (const slotId of batch) if (!sec.allocations.some(a => a.demandId === d.id && a.slotId === slotId)) sec.allocations.push({ demandId: d.id, slotId, resourceIds: ids.slice(), locked: locked.length > 0 });
      if (part === "day") for (const id of ids) {
        const row = sec.rows.find(r => r.resourceId === id)!;
        const ownAssignment = row.assignments.find(x => x.groupId === d.groupId);
        if (ownAssignment) { ownAssignment.demandId = d.id; ownAssignment.purpose = d.title; }
        else row.assignments.push({ groupId: d.groupId, demandId: d.id, purpose: d.title });
      }
    }
  }
  return sec;
}

/** Subtract all overlay intervals; half-open boundaries preserve adjacent bookings. */
export function subtractRanges(range: { startAt: string; endAt: string }, cuts: { startAt: string; endAt: string }[]) {
  let pieces = [range];
  for (const cut of cuts) pieces = pieces.flatMap(x => !overlaps(x, cut) ? [x] : [x.startAt < cut.startAt ? { startAt: x.startAt, endAt: cut.startAt } : null, cut.endAt < x.endAt ? { startAt: cut.endAt, endAt: x.endAt } : null].filter((x): x is typeof range => !!x));
  return pieces;
}
export function rebuildWorkspaceBookings(s: State, p: WeeklyPlan, now: string, actor: { userId: string; displayName: string }) {
  for (const b of s.bookings) if (b.endAt > now && ["scheduled", "preempted"].includes(b.status) && s.requests.find(q => q.id === b.requestId)?.weeklyPlanId === p.id) {
    if (b.startAt < now) { b.endAt = now; b.status = "released"; } else b.status = "cancelled"; b.updatedAt = now;
  }
  for (const q of s.requests) if (q.weeklyPlanId === p.id) { delete q.pendingExtension; if (q.status === "approved" && !s.bookings.some(b => b.requestId === q.id && b.status === "scheduled" && b.endAt > now)) q.status = "cancelled"; }
  const w = p.v2!, day = w.sections.day.published, multi = w.sections.multi.published;
  const overlays = (multi?.allocations ?? []).flatMap(a => { const slot = multi!.slots.find(x => x.id === a.slotId), d = multi!.demands.find(x => x.id === a.demandId); return slot && d ? a.resourceIds.map(resourceId => ({ resourceId, groupId: d.groupId, purpose: d.title, demandId: d.id, startAt: slot.startAt, endAt: slot.endAt })) : []; });
  const add = (id: string, groupId: string, purpose: string, demandId: string | undefined, range: { startAt: string; endAt: string }, weeklySection: WeeklySectionName) => {
    const startAt = range.startAt < now ? now : range.startAt;
    if (startAt >= range.endAt) return;
    for (const piece of subtractRanges({ startAt, endAt: range.endAt }, w.suppressions.filter(x => x.resourceId === id && (!x.groupId || x.groupId === groupId)))) {
      const requestId = crypto.randomUUID();
      s.requests.push({ id: requestId, weeklyPlanId: p.id, weeklyDemandId: demandId, weeklySection, groupId, resourceIds: [id], ...piece, purpose, priority: "normal", status: "approved", applicantId: actor.userId, applicantName: actor.displayName, createdAt: now, reviewedAt: now, reviewer: actor.displayName, reviewNote: `${p.weekStart}周双流程排期；已确认发布` });
      s.bookings.push({ id: crypto.randomUUID(), requestId, resourceId: id, groupId, ...piece, purpose, priority: "normal", status: "scheduled", parentId: "", createdAt: now, updatedAt: now });
    }
  };
  for (const row of day?.rows ?? []) for (const a of row.assignments) for (const piece of subtractRanges(workspaceRange(p), overlays.filter(x => x.resourceId === row.resourceId))) add(row.resourceId, a.groupId, a.purpose || "常态分配", a.demandId, piece, "day");
  for (const x of overlays) add(x.resourceId, x.groupId, x.purpose, x.demandId, x, "multi");
}

