import { DomainError } from "./domain";
import { layoutGroupAvailability, shiftDate } from "./schedule";
import { minuteMs, type NpuCard, type NpuDay, type NpuLatest } from "./npu-usage";
import type { Actor, Booking, State } from "./types";

const date = (at: number) => new Date(at + 8 * 60 * minuteMs).toISOString().slice(0, 10);
const dayStart = (day: string) => Date.parse(`${day}T00:00:00+08:00`);
const rackPattern = /^(?:计算柜|机柜|柜|A|B)?\s*0*(1|2|9|11|12)$/i;
const busy = new Set(["active", "occupied_low", "occupied_unknown"]);
const at = (value: string) => Date.parse(value);
const iso = (value: number) => new Date(value).toISOString();

export function canViewNpuLive(actor: Actor) {
  return !!actor.userId && (actor.role === "admin" || actor.role !== "visitor" && !!actor.groupId);
}

export function liveGroups(state: Pick<State, "groups">, actor: Actor) {
  if (!canViewNpuLive(actor)) throw new DomainError(actor.userId ? 403 : 401, "请登录并加入使用组");
  return state.groups.filter(g => actor.role === "admin" || g.id === actor.groupId).map(({id, name}) => ({id, name}));
}

export function dedicatedBooking(requests: State["requests"]) {
  const byId = new Map(requests.map(req => [req.id, req]));
  return (booking: Booking) => {
    // The existing timeline reserves all elevated intervals for their task.
    if (booking.priority !== "normal") return true;
    let id: string | undefined = booking.requestId;
    const seen = new Set<string>();
    while (id && !seen.has(id)) {
      seen.add(id);
      const request = byId.get(id);
      if (request?.weeklySection) return request.weeklySection === "multi";
      id = request?.sourceRequestId;
    }
    return false;
  };
}

type Window = { start: number; end: number };
export function liveCandidates(state: Pick<State, "resources" | "bookings" | "requests">, actor: Actor, group: string, now: number, since: number) {
  const isDedicated = dedicatedBooking(state.requests);
  const byResource = new Map<string, Booking[]>();
  for (const booking of state.bookings) {
    if ((booking.status !== "scheduled" && booking.status !== "released") || at(booking.endAt) <= since) continue;
    const rows = byResource.get(booking.resourceId) ?? [];
    rows.push(booking);
    byResource.set(booking.resourceId, rows);
  }
  return state.resources.flatMap(resource => {
    const match = resource.rack?.trim().match(rackPattern);
    if (!match || resource.zone !== "blue" || resource.deleted || resource.hidden && actor.role !== "admin") return [];
    const bookings = byResource.get(resource.id) ?? [];
    const latestEnd = Math.max(now, ...bookings.filter(b => b.groupId === group && !isDedicated(b)).map(b => at(b.endAt)));
    if (latestEnd <= now) return [];
    const windows: Window[] = layoutGroupAvailability(resource, bookings, group, {startAt: iso(since), endAt: iso(latestEnd)}, isDedicated)
      .filter(part => part.available).map(part => ({start: at(part.startAt), end: at(part.endAt)}));
    const active = windows.find(w => w.start <= now && now < w.end);
    if (!active) return [];
    const shared = bookings.some(b => b.groupId !== group && !isDedicated(b) && at(b.startAt) <= now && now < at(b.endAt));
    const slot = Number(resource.name.match(/(?:CPU|节点)\s*(\d+)\s*$/i)?.[1]) || null;
    return [{resource, rack: Number(match[1]), slot, until: active.end, shared, windows}];
  }).sort((a, b) => a.rack - b.rack || (a.slot ?? Infinity) - (b.slot ?? Infinity) ||
    a.resource.ip.localeCompare(b.resource.ip, undefined, {numeric: true}));
}

export function liveHistory(days: NpuDay[], windows: Window[], now: number, hours: number) {
  const start = now - hours * 60 * minuteMs, step = (hours === 5 ? 10 : 5) * minuteMs;
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
  return {values: bins.map(b => b.observed ? 100*b.occupied/b.observed : null),
    mean: total.observed ? 100*total.occupied/total.observed : null};
}

export function liveView(state: State, actor: Actor, groupId: string, now: number, hours: number, days: NpuDay[], latest: NpuLatest[]) {
  const groups = liveGroups(state, actor);
  if (groupId && !groups.some(g => g.id === groupId)) throw new DomainError(403, "无权查看该分组");
  const group = groupId || groups.find(g => g.id === actor.groupId)?.id || groups[0]?.id || "";
  const candidates = liveCandidates(state, actor, group, now, now-hours*60*minuteMs);
  const latestById = new Map(latest.map(row => [row.resourceId, row]));
  const machines = candidates.map(({resource, rack, slot, until, shared, windows}) => {
    const snap = latestById.get(resource.id);
    const sampledAt = snap?.snapshot.at ?? null;
    const fresh = sampledAt !== null && sampledAt <= now && now-sampledAt <= 3*minuteMs;
    const history = days.filter(d => d.resourceId === resource.id);
    const expected = Math.max(snap?.expected ?? 0, ...history.map(d => d.expected));
    const cards = fresh && snap ? snap.snapshot.cards.map(c => c.state === "idle" ? "idle" : busy.has(c.state) ? "busy" : c.state === "fault" ? "fault" : "unknown") : [];
    const idle = fresh ? cards.filter(s => s === "idle").length : null;
    const faults = cards.filter(s => s === "fault").length;
    const occupied = cards.filter(s => s === "busy").length;
    const status: "uncertain" | "busy" | "idle" = !fresh || !expected || (idle ?? 0)+occupied !== expected ? "uncertain" : occupied ? "busy" : "idle";
    const reason = !fresh ? sampledAt === null ? "暂无线上样本" : "样本已过期" : status === "uncertain" ? "有卡异常或缺测" : "";
    return {id: resource.id, ip: resource.ip, rack, slot, until, shared, sampledAt, expected,
      cards, idle, faults, status, reason, ...liveHistory(history, windows, now, hours)};
  });
  return {groups, group, now, hours, machines};
}

export async function readLive(db: D1Database, state: State, actor: Actor, url: URL, now: number) {
  const groups = liveGroups(state, actor);
  const group = url.searchParams.get("group") || groups.find(g => g.id === actor.groupId)?.id || groups[0]?.id || "";
  if (group && !groups.some(g => g.id === group)) throw new DomainError(403, "无权查看该分组");
  const hours = Number(url.searchParams.get("hours") ?? 1);
  if (![1,3,5].includes(hours)) throw new DomainError(400, "请选择近 1、3 或 5 小时");
  const since = now-hours*60*minuteMs;
  const ids = liveCandidates(state, actor, group, now, since).map(row => row.resource.id);
  if (!ids.length) return liveView(state, actor, group, now, hours, [], []);
  const params = ids.map(() => "?").join(",");
  const [days, latest] = await Promise.all([
    db.prepare(`SELECT resource_id, day, expected, samples FROM npu_days WHERE id >= ? AND id < ? AND resource_id IN (${params})`)
      .bind(date(since)+"/", shiftDate(date(now),1)+"/", ...ids)
      .all<{resource_id: string; day: string; expected: number; samples: string}>(),
    db.prepare(`SELECT resource_id, expected, sampled_at, cards FROM npu_latest WHERE resource_id IN (${params})`)
      .bind(...ids).all<{resource_id: string; expected: number; sampled_at: number; cards: string}>(),
  ]);
  return liveView(state, actor, group, now, hours, days.results.map(r => ({resourceId: r.resource_id, day: r.day, expected: r.expected, samples: JSON.parse(r.samples)})),
    latest.results.map(r => ({resourceId: r.resource_id, expected: r.expected, snapshot: {at: r.sampled_at, cards: JSON.parse(r.cards) as NpuCard[]}})));
}

export type LiveView = ReturnType<typeof liveView>;
