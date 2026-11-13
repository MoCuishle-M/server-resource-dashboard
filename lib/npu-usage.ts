import { bookingAvailability } from "./priority";
import { shiftDate } from "./schedule";
import type { State } from "./types";

export const minuteMs = 60_000;
export const dayMs = 1440 * minuteMs;
export type MinuteSample = [observed: number, occupied: number, computeCount: number, computeSum: number];
export type NpuCard = { key: string; state: string; util: number | null; hbm: number | null };
export type NpuSnapshot = { at: number; cards: NpuCard[] };
export type NpuDay = { resourceId: string; day: string; expected: number; samples: Record<string, MinuteSample> };
export type NpuLatest = { resourceId: string; expected: number; snapshot: NpuSnapshot };
export type UsageRange = { start: number; end: number; startDay: string; endDay: string };

export function usageRange(startDay: string, endDay: string, now: number): UsageRange {
  const parse = (day: string) => {
    const start = Date.parse(`${day}T00:00:00+08:00`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(start) ||
        new Date(start + 8 * 3600000).toISOString().slice(0, 10) !== day) {
      throw new RangeError("日期无效");
    }
    return start;
  };
  const start = parse(startDay);
  const stop = parse(endDay) + dayMs;
  if (stop <= start || stop - start > 7 * dayMs || start >= now) {
    throw new RangeError("请选择已经开始、最长七天的日期范围");
  }
  return { start, end: Math.min(stop, now), startDay, endDay };
}

function totals() {
  return { expected: 0, observed: 0, occupied: 0, computeCount: 0, computeSum: 0, shared: 0, sharedObserved: 0, sharedOccupied: 0 };
}
type Totals = ReturnType<typeof totals>;
type Span = { start: number; end: number; groups: string[] };

function add(out: Totals, expected: number, minutes: number, sample?: MinuteSample, shared = false) {
  out.expected += expected * minutes;
  if (shared) out.shared += expected * minutes;
  if (sample) {
    out.observed += sample[0] * minutes;
    out.occupied += sample[1] * minutes;
    out.computeCount += sample[2] * minutes;
    out.computeSum += sample[3] * minutes;
    if (shared) {
      out.sharedObserved += sample[0] * minutes;
      out.sharedOccupied += sample[1] * minutes;
    }
  }
}

function effectiveSpans(state: Pick<State, "bookings">, resource: State["resources"][number], range: UsageRange): Span[] {
  const bookings = state.bookings.filter(b => b.resourceId === resource.id &&
    (b.status === "scheduled" || b.status === "released") &&
    Date.parse(b.startAt) < range.end && Date.parse(b.endAt) > range.start);
  const changes = new Map<number, [string, number][]>();
  for (const booking of bookings) {
    // Exclusive approvals split conflicts in the stored records. Preserved overlaps
    // keep their original priority and sharing after a later resource-mode change.
    for (const part of bookingAvailability(booking, bookings, true, resource.timeBlocks)) {
      if (part.blockedBy.length || part.blockedByTimeBlocks.length) continue;
      const start = Math.max(range.start, Date.parse(part.startAt));
      const end = Math.min(range.end, Date.parse(part.endAt));
      if (end <= start) continue;
      for (const [at, delta] of [[start, 1], [end, -1]]) {
        const events = changes.get(at) ?? [];
        events.push([booking.groupId, delta]);
        changes.set(at, events);
      }
    }
  }
  const boundaries = [...changes.keys()].sort((a, b) => a - b);
  const active = new Map<string, number>();
  const spans: Span[] = [];
  boundaries.forEach((start, i) => {
    for (const [groupId, delta] of changes.get(start)!) {
      const count = (active.get(groupId) ?? 0) + delta;
      if (count) active.set(groupId, count);
      else active.delete(groupId);
    }
    const end = boundaries[i + 1];
    if (end && active.size) {
      spans.push({ start, end, groups: [...active.keys()] });
    }
  });
  return spans;
}

export function analyzeUsage(
  state: Pick<State, "resources" | "groups" | "bookings">,
  days: NpuDay[],
  latest: NpuLatest[],
  range: UsageRange,
  selectedGroup = "",
  selectedResource = "",
) {
  const resources = new Map(state.resources.map(resource => [resource.id, resource]));
  const dayData = new Map(days.map(day => [`${day.resourceId}/${day.day}`, day]));
  const hosts = new Map<string, { expected: number; snapshot: NpuSnapshot | null }>();
  for (const day of days) {
    hosts.set(day.resourceId, { expected: Math.max(hosts.get(day.resourceId)?.expected ?? 0, day.expected), snapshot: null });
  }
  for (const host of latest) hosts.set(host.resourceId, host);
  const groups = new Map(state.groups.map(group => [group.id, { id: group.id, name: group.name, ...totals() }]));
  const machineRows = [];
  const fleet = totals();
  const bucketMinutes = range.startDay === range.endDay ? 15 : 60;
  const bucketMs = bucketMinutes * minuteMs;
  const buckets = Array.from({ length: Math.ceil((range.end - range.start) / bucketMs) }, (_, i) => range.start + i * bucketMs);
  const groupHeatmap = [];
  const groupTrend = selectedGroup ? buckets.map(totals) : [];
  let machineTrend: Totals[] = [];

  for (const [resourceId, host] of hosts) {
    const resource = resources.get(resourceId);
    if (!resource) continue;
    const machine = totals();
    const spans = effectiveSpans(state, resource, range);
    const heatmap = selectedGroup && spans.some(span => span.groups.includes(selectedGroup))
      ? buckets.map(totals) : null;
    const trend = selectedResource === resource.id ? buckets.map(totals) : null;
    let spanIndex = 0;
    for (let day = range.startDay, dayStart = range.start; dayStart < range.end; day = shiftDate(day, 1), dayStart += dayMs) {
      const data = dayData.get(`${resource.id}/${day}`);
      const expected = data?.expected ?? host.expected;
      const limit = Math.min(dayStart + dayMs, range.end);
      for (let start = dayStart, minute = 0; start < limit; start += minuteMs, minute++) {
        const end = Math.min(start + minuteMs, limit);
        const sample = data?.samples[minute];
        const duration = (end - start) / minuteMs;
        const bucket = Math.floor((start - range.start) / bucketMs);
        add(machine, expected, duration, sample);
        if (trend) add(trend[bucket], expected, duration, sample);
        while (spanIndex < spans.length && spans[spanIndex].end <= start) spanIndex++;
        for (let i = spanIndex; i < spans.length && spans[i].start < end; i++) {
          const span = spans[i];
          const overlap = (Math.min(span.end, end) - Math.max(span.start, start)) / minuteMs;
          const shared = span.groups.length > 1;
          for (const id of span.groups) {
            const group = groups.get(id);
            if (group) add(group, expected, overlap, sample, shared);
            if (heatmap && id === selectedGroup) {
              add(heatmap[bucket], expected, overlap, sample, shared);
              add(groupTrend[bucket], expected, overlap, sample, shared);
            }
          }
        }
      }
    }
    for (const key of Object.keys(fleet) as (keyof Totals)[]) fleet[key] += machine[key];
    machineRows.push({ id: resource.id, name: resource.name, ...machine, snapshot: host.snapshot });
    if (heatmap) groupHeatmap.push({ id: resource.id, name: resource.name, values: heatmap });
    if (trend) machineTrend = trend;
  }

  return { fleet, machines: machineRows, groups: [...groups.values()], buckets, bucketMinutes, groupHeatmap, groupTrend, machineTrend };
}

export type NpuAnalysis = ReturnType<typeof analyzeUsage>;
