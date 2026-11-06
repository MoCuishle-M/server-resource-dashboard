import type { WeeklyPlan } from "./types";
import { weeklyPlanRange, type TimelineRange } from "./schedule";

/** Only published notes from weeks intersecting the displayed interval belong on the timeline. */
export function scheduleNotes(plans: WeeklyPlan[], resourceId: string, range: TimelineRange) {
  return plans.filter(p => {
    if (p.status !== "published" || p.layout !== "table") return false;
    const week = weeklyPlanRange(p);
    return week.startAt < range.endAt && week.endAt > range.startAt;
  }).sort((a, b) => a.weekStart.localeCompare(b.weekStart))
    .flatMap(p => {
      const note = p.rows?.find(r => r.resourceId === resourceId)?.specialNote.trim();
      return note ? [{ weekStart: p.weekStart, note }] : [];
    });
}

/** Classify the published notes for the schedule grid without rewriting the weekly plan. */
export function scheduleNoteDisplay(notes: ReturnType<typeof scheduleNotes>) {
  const smoke = new Set<string>();
  const other = notes.flatMap(({ weekStart, note }) => {
    // The imported Canada instruction is a single three-line block.
    const text = note.replace(/\r\n/g, "\n").replace(
      /^[ \t]*23:00\s*[~～–]\s*第二天\s*0?9:00[ \t]*\n[ \t]*加研同事使用空闲卡[ \t]*\n[ \t]*不占卡、不动已有进程与容器[ \t]*$/gm,
      "",
    ).split("\n").map(line => line.trim()).filter(line => {
      if (!line || /加研同事|加拿大研究(?:所|院)/.test(line)) return false;
      if (!line.includes("冒烟")) return true;
      smoke.add(line);
      return false;
    }).join("\n");
    return text ? [{ weekStart, note: text }] : [];
  });
  return { smoke: [...smoke], other };
}
