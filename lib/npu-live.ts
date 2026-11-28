import { DomainError } from "./domain";
import { dedicatedBooking, layoutGroupAvailability, shiftDate } from "./schedule";
import { minuteMs, type NpuCard, type NpuDay, type NpuLatest, type NpuSnapshot } from "./npu-usage";
import type { Actor, Booking, Resource, State } from "./types";

const date = (at: number) => new Date(at + 8 * 60 * minuteMs).toISOString().slice(0, 10);
const dayStart = (day: string) => Date.parse(`${day}T00:00:00+08:00`);
const rackPattern = /^(?:计算柜|机柜|柜|A|B)?\s*0*([1-9]\d?)$/i;
const monitoredRacks = new Set([1, 2, 9, 11, 12]);
const busy = new Set(["active", "occupied_low", "occupied_unknown"]);
const at = (value: string) => Date.parse(value);
const iso = (value: number) => new Date(value).toISOString();
export const allLiveGroups = "all";

export function liveLocation(resource: Pick<Resource, "name" | "rack" | "zone">, monitoredOnly = true) {
  const rack = Number(resource.rack?.trim().match(rackPattern)?.[1]);
  if (!rack || resource.zone !== "blue" || monitoredOnly && !monitoredRacks.has(rack)) return null;
  const slot = Number(resource.name.match(/(?:CPU|节点)\s*[-_]?\s*(\d+)\s*$/i)?.[1]) || null;
  return {rack, slot};
}

type Window = { start: number; end: number };
type LiveGroup = Pick<State["groups"][number], "id" | "name">;

function liveScope(state: Pick<State, "groups">, actor: Actor, groupId: string) {
  const groups = state.groups.map(({id, name}) => ({id, name}));
  const group = groupId || (actor.role === "admin" ? allLiveGroups : actor.groupId);
  if (group === allLiveGroups) {
    if (actor.role !== "admin") throw new DomainError(403, "请选择单个使用组");
    return {groups, group, selected: groups};
  }
  const selected = groups.filter(g => g.id === group);
  if (!selected.length) throw new DomainError(400, "请选择有效的使用组");
  return {groups, group, selected};
}

function unionWindows(windows: Window[]) {
  const merged: Window[] = [];
  for (const window of windows.sort((a, b) => a.start - b.start)) {
    const previous = merged.at(-1);
    if (previous && window.start <= previous.end) previous.end = Math.max(previous.end, window.end);
    else merged.push({...window});
  }
  return merged;
}

function liveCandidates(state: Pick<State, "resources" | "bookings" | "requests">, actor: Actor, groups: LiveGroup[], now: number, since: number) {
  const isDedicated = dedicatedBooking(state.requests);
  const byResource = new Map<string, Booking[]>();
  for (const booking of state.bookings) {
    if ((booking.status !== "scheduled" && booking.status !== "released") || at(booking.endAt) <= since) continue;
    const rows = byResource.get(booking.resourceId) ?? [];
    rows.push(booking);
    byResource.set(booking.resourceId, rows);
  }
  return state.resources.flatMap(resource => {
    const location = liveLocation(resource);
    if (!location || resource.deleted || resource.hidden && actor.role !== "admin") return [];
    const bookings = byResource.get(resource.id) ?? [];
    const ordinary = bookings.filter(b => !isDedicated(b));
    const currentGroups = new Set(ordinary.filter(b => at(b.startAt) <= now && now < at(b.endAt)).map(b => b.groupId));
    const allocations = groups.filter(g => currentGroups.has(g.id)).flatMap(group => {
      const latestEnd = Math.max(...ordinary.filter(b => b.groupId === group.id).map(b => at(b.endAt)));
      const windows = layoutGroupAvailability(resource, bookings, group.id, {startAt: iso(since), endAt: iso(latestEnd)}, isDedicated)
        .filter(part => part.available).map(part => ({start: at(part.startAt), end: at(part.endAt)}));
      const active = windows.find(w => w.start <= now && now < w.end);
      return active ? [{name: group.name, until: active.end, windows}] : [];
    });
    if (!allocations.length) return [];
    return [{resource, ...location, until: Math.min(...allocations.map(a => a.until)),
      groupNames: allocations.map(a => a.name), shared: currentGroups.size > 1,
      windows: unionWindows(allocations.flatMap(a => a.windows))}];
  }).sort((a, b) => a.rack - b.rack || (a.slot ?? Infinity) - (b.slot ?? Infinity) ||
    a.resource.ip.localeCompare(b.resource.ip, undefined, {numeric: true}));
}

export function liveHistory(days: NpuDay[], windows: Window[], now: number, hours: number) {
  const start = now - hours * 60 * minuteMs, step = (hours === 5 ? 10 : 5) * minuteMs;
  // The uploader publishes completed minutes, so allow the current interval and
  // the preceding two minutes to arrive before labelling a gap as missing.
  const due = Math.floor(now / minuteMs) * minuteMs - 2 * minuteMs;
  const bins = Array.from({length: (now-start)/step}, () => ({observed: 0, occupied: 0}));
  for (const day of days) {
    const base = dayStart(day.day);
    for (const [minute, sample] of Object.entries(day.samples)) {
      const stamp = base + Number(minute) * minuteMs;
      if (!sample[0] || stamp + minuteMs <= start || stamp >= now) continue;
      for (const w of windows) {
        const left = Math.max(stamp, w.start, start), right = Math.min(stamp + minuteMs, w.end, now);
        if (left >= right) continue;
        for (let i = Math.floor((left-start)/step); i < bins.length && start + i*step < right; i++) {
          const weight = (Math.min(right, start+(i+1)*step) - Math.max(left, start+i*step))/minuteMs;
          bins[i].observed += weight*sample[0];
          bins[i].occupied += weight*sample[1];
        }
      }
    }
  }
  const total = bins.reduce((p, b) => ({observed: p.observed+b.observed, occupied: p.occupied+b.occupied}), {observed: 0, occupied: 0});
  const gaps = bins.map((bin, i) => {
    if (bin.observed) return null;
    const begin = start + i * step;
    const end = begin + step;
    if (windows.some(w => Math.max(begin, w.start) < Math.min(end, w.end, due))) return "missing" as const;
    return windows.some(w => Math.max(begin, w.start) < Math.min(end, w.end)) ? "pending" as const : "outside" as const;
  });
  return {values: bins.map(b => b.observed ? 100*b.occupied/b.observed : null),
    mean: total.observed ? 100*total.occupied/total.observed : null, gaps};
}

export type CardState = "idle" | "busy" | "fault" | "unknown";

export function readLiveCards(snapshot: NpuSnapshot | undefined, expected: number, now: number) {
  const sampledAt = snapshot?.at ?? null;
  const fresh = !!snapshot && snapshot.at <= now && now - snapshot.at <= 3 * minuteMs;
  const cards: CardState[] = fresh ? snapshot.cards.map(c =>
    c.state === "idle" ? "idle" : busy.has(c.state) ? "busy" : c.state === "fault" ? "fault" : "unknown") : [];
  const idle = fresh ? cards.filter(s => s === "idle").length : null;
  const faults = cards.filter(s => s === "fault").length;
  const incomplete = !expected || cards.length !== expected || cards.includes("unknown");
  const status: "idle" | "busy" | "uncertain" = !fresh || incomplete || faults ? "uncertain" : idle === expected ? "idle" : "busy";
  return { sampledAt, fresh, cards, idle, faults, incomplete, status };
}

export function liveView(state: State, actor: Actor, groupId: string, now: number, hours: number, days: NpuDay[], latest: NpuLatest[]) {
  const {groups, group, selected} = liveScope(state, actor, groupId);
  const candidates = liveCandidates(state, actor, selected, now, now-hours*60*minuteMs);
  return buildLiveView(candidates, groups, group, now, hours, days, latest);
}

function buildLiveView(candidates: ReturnType<typeof liveCandidates>, groups: LiveGroup[], group: string,
                       now: number, hours: number, days: NpuDay[], latest: NpuLatest[]) {
  const latestById = new Map(latest.map(row => [row.resourceId, row]));
  const machines = candidates.map(({resource, rack, slot, until, groupNames, shared, windows}) => {
    const snap = latestById.get(resource.id);
    const history = days.filter(d => d.resourceId === resource.id);
    const expected = Math.max(snap?.expected ?? 0, ...history.map(d => d.expected));
    const { sampledAt, fresh, cards, idle, faults, status } = readLiveCards(snap?.snapshot, expected, now);
    const reason = !fresh ? sampledAt === null ? "暂无线上样本" : "样本已过期" : status === "uncertain" ? "有卡异常或缺测" : "";
    return {id: resource.id, ip: resource.ip, rack, slot, until, groupNames, shared, sampledAt, expected,
      cards, idle, faults, status, reason, ...liveHistory(history, windows, now, hours)};
  });
  return {groups, group, now, hours, machines};
}

export async function readLive(db: D1Database, state: State, actor: Actor, url: URL, now: number) {
  const {groups, group, selected} = liveScope(state, actor, url.searchParams.get("group") ?? "");
  const hours = Number(url.searchParams.get("hours") ?? 1);
  if (![1,3,5].includes(hours)) throw new DomainError(400, "请选择近 1、3 或 5 小时");
  const since = now-hours*60*minuteMs;
  const candidates = liveCandidates(state, actor, selected, now, since);
  const ids = candidates.map(row => row.resource.id);
  if (!ids.length) return buildLiveView(candidates, groups, group, now, hours, [], []);
  const params = ids.map(() => "?").join(",");
  const [days, latest] = await Promise.all([
    db.prepare(`SELECT resource_id, day, expected, samples FROM npu_days WHERE id >= ? AND id < ? AND resource_id IN (${params})`)
      .bind(date(since)+"/", shiftDate(date(now),1)+"/", ...ids)
      .all<{resource_id: string; day: string; expected: number; samples: string}>(),
    db.prepare(`SELECT resource_id, expected, sampled_at, cards FROM npu_latest WHERE resource_id IN (${params})`)
      .bind(...ids).all<{resource_id: string; expected: number; sampled_at: number; cards: string}>(),
  ]);
  return buildLiveView(candidates, groups, group, now, hours, days.results.map(r => ({resourceId: r.resource_id, day: r.day, expected: r.expected, samples: JSON.parse(r.samples)})),
    latest.results.map(r => ({resourceId: r.resource_id, expected: r.expected, snapshot: {at: r.sampled_at, cards: JSON.parse(r.cards) as NpuCard[]}})));
}

export type LiveView = ReturnType<typeof liveView>;
