import type { WeeklyPlan } from "./types";
import { calendarRange, type TimelineRange } from "./schedule";

/** Only published notes from weeks intersecting the displayed interval belong on the timeline. */
export function scheduleNotes(plans: WeeklyPlan[], resourceId: string, range: TimelineRange) {
  return plans.filter(p => {
    if (p.status !== "published" || p.layout !== "table") return false;
    const week = calendarRange(p.weekStart, "week");
    return week.startAt < range.endAt && week.endAt > range.startAt;
  }).sort((a, b) => a.weekStart.localeCompare(b.weekStart))
    .flatMap(p => {
      const note = p.rows?.find(r => r.resourceId === resourceId)?.specialNote.trim();
      return note ? [{ weekStart: p.weekStart, note }] : [];
    });
}
