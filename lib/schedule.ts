import type { Booking, ResourceTimeBlock, WeeklyPlan } from "./types";
import { displayBookings } from "./priority";

export type TimelineRange = { startAt: string; endAt: string };
const hour = 3600000;
const day = 24 * hour;
const offset = 8 * hour;

export function shiftDate(date: string, days: number) {
  return new Date(Date.parse(`${date}T00:00:00+08:00`) + offset + days * day)
    .toISOString().slice(0, 10);
}

export function calendarRange(date: string, mode: "week" | "day"): TimelineRange {
  const weekday = new Date(`${date}T12:00:00+08:00`).getUTCDay();
  const mondayOffset = (weekday + 6) % 7;
  const startDate = mode === "week" ? shiftDate(date, -mondayOffset) : date;
  return {
    startAt: new Date(`${startDate}T00:00:00+08:00`).toISOString(),
    endAt: new Date(`${shiftDate(startDate, mode === "week" ? 7 : 1)}T00:00:00+08:00`).toISOString(),
  };
}

export function customRange(start: string, end: string): TimelineRange {
  const startMs = Date.parse(`${start}+08:00`);
  const endMs = Date.parse(`${end}+08:00`);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs))
    throw new Error("请填写完整的开始和结束日期时间");
  if (endMs <= startMs) throw new Error("结束时间必须晚于开始时间");
  return { startAt: new Date(startMs).toISOString(), endAt: new Date(endMs).toISOString() };
}

export function weeklyPlanRange(plan: Pick<WeeklyPlan, "weekStart" | "endAt">): TimelineRange {
  const range = calendarRange(plan.weekStart, "week");
  return { ...range, endAt: plan.endAt ?? range.endAt };
}

export function timelineTicks(range: TimelineRange) {
  const start = Date.parse(range.startAt), end = Date.parse(range.endAt);
  const span = end - start;
  const step = span <= 3 * hour ? hour / 2 : span <= 12 * hour ? hour
    : span <= day ? 3 * hour : span <= 3 * day ? 12 * hour
      : span <= 10 * day ? day : Math.ceil(span / day / 8) * day;
  const times = [start];
  for (let t = Math.floor((start + offset) / step) * step - offset + step; t < end; t += step)
    times.push(t);
  times.push(end);
  return times.map((time) => ({ at: new Date(time).toISOString(), percent: (time - start) / span * 100 }));
}

export function layoutBookings(bookings: Booking[], range: TimelineRange) {
  return layoutRanges(displayBookings(bookings), range);
}

export function layoutTimeBlocks(blocks: ResourceTimeBlock[], range: TimelineRange) {
  return layoutRanges(blocks.filter(b => b.status === "active").map(b => ({ ...b, startAt: b.displayStartAt ?? b.startAt })), range);
}

function layoutRanges<T extends { id: string; startAt: string; endAt: string }>(items: T[], range: TimelineRange) {
  const start = Date.parse(range.startAt), end = Date.parse(range.endAt);
  const visible = items.filter(b =>
    Date.parse(b.startAt) < end && Date.parse(b.endAt) > start,
  ).sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt) ||
    Date.parse(a.endAt) - Date.parse(b.endAt) || a.id.localeCompare(b.id));
  const laneEnds: number[] = [];
  const bars = visible.map(booking => {
    const clippedStart = Math.max(start, Date.parse(booking.startAt));
    const clippedEnd = Math.min(end, Date.parse(booking.endAt));
    let lane = laneEnds.findIndex(t => t <= clippedStart);
    if (lane < 0) lane = laneEnds.length;
    laneEnds[lane] = clippedEnd;
    return { booking, lane, left: (clippedStart - start) / (end - start) * 100,
      width: (clippedEnd - clippedStart) / (end - start) * 100,
      continuesBefore: Date.parse(booking.startAt) < start,
      continuesAfter: Date.parse(booking.endAt) > end };
  });
  return { bars, lanes: Math.max(1, laneEnds.length) };
}
