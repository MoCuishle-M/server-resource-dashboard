import type { Booking, Priority, Resource, ResourceTimeBlock } from "./types";
import { overlappingTimeBlocks, timeBlockLabels } from "./resource-time-blocks";

export const priorityRank = { normal: 0, high: 1, urgent: 2 };
export const priorityLabel = { normal: "普通", high: "高优", urgent: "紧急" };
type Range = { startAt: string; endAt: string };
export type AvailabilitySegment = Range & { blockedBy: Booking[]; blockedByTimeBlocks: ResourceTimeBlock[]; sharedWith: Booking[] };
const intersects = (a: Range, b: Range) => Date.parse(a.startAt) < Date.parse(b.endAt) && Date.parse(b.startAt) < Date.parse(a.endAt);

/** Keep legacy preempted gaps visible without drawing their retained child intervals twice. */
export function displayBookings(bookings: Booking[]) {
  return bookings.flatMap(b => {
    if (b.status === "scheduled" || b.status === "released") return [b];
    if (b.status !== "preempted") return [];
    let ranges: Range[] = [b];
    const descendants = new Set([b.id]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const child of bookings) if (descendants.has(child.parentId) && !descendants.has(child.id)) {
        descendants.add(child.id); changed = true;
      }
    }
    for (const child of bookings.filter(c => c.id !== b.id && descendants.has(c.id))) {
      ranges = ranges.flatMap(r => !intersects(r, child) ? [r] : [
        ...(r.startAt < child.startAt ? [{ startAt: r.startAt, endAt: child.startAt }] : []),
        ...(r.endAt > child.endAt ? [{ startAt: child.endAt, endAt: r.endAt }] : []),
      ]);
    }
    return ranges.map((r, i) => ({ ...b, ...r, id: `${b.id}:gap${i}` }));
  });
}

/** Each half-open interval independently selects the highest priority; equal ranks share. */
export function bookingAvailability(booking: Booking, bookings: Booking[], shared = true, timeBlocks: ResourceTimeBlock[] = []): AvailabilitySegment[] {
  const peers = shared ? bookings.filter(b => b.id !== booking.id && b.resourceId === booking.resourceId
    && (b.status === "scheduled" || b.status === "released") && intersects(b, booking)) : [];
  const start = Date.parse(booking.startAt), end = Date.parse(booking.endAt);
  const blocks = overlappingTimeBlocks({ timeBlocks }, booking);
  const boundaries = [...new Set([start, end, ...[...peers, ...blocks].flatMap(b => [
    Math.max(start, Date.parse(b.startAt)), Math.min(end, Date.parse(b.endAt)),
  ])])].sort((a, b) => a - b);
  return boundaries.slice(0, -1).map((time, i) => {
    const active = peers.filter(b => Date.parse(b.startAt) <= time && Date.parse(b.endAt) > time);
    return { startAt: new Date(time).toISOString(), endAt: new Date(boundaries[i + 1]).toISOString(),
      blockedBy: active.filter(b => priorityRank[b.priority] > priorityRank[booking.priority]),
      blockedByTimeBlocks: blocks.filter(b => Date.parse(b.startAt) <= time && Date.parse(b.endAt) > time),
      sharedWith: active.filter(b => b.priority === booking.priority) };
  });
}

export function requestPriorityPreview(resource: Resource, bookings: Booking[], range: Range, priority: Priority) {
  if (!Number.isFinite(Date.parse(range.startAt)) || !Number.isFinite(Date.parse(range.endAt)) || range.endAt <= range.startAt) return null;
  const shared = resource.sharingMode === "shared";
  const booking = { ...range, id: "preview", resourceId: resource.id, priority } as Booking;
  const existing = bookings.filter(b => b.resourceId === resource.id && b.status === "scheduled" && intersects(b, range));
  const segments = bookingAvailability(booking, existing, shared, resource.timeBlocks);
  const timeBlocks = overlappingTimeBlocks(resource, range);
  const affected = existing.filter(b => priorityRank[b.priority] < priorityRank[priority] &&
    (!shared || displacesBooking(b, bookings, range)));
  const blocking = existing.filter(b => shared ? priorityRank[b.priority] > priorityRank[priority] : priorityRank[b.priority] >= priorityRank[priority]);
  const equals = shared ? existing.filter(b => b.priority === priority) : [];
  return { segments, affected, blocking, equals, shared, timeBlocks,
    label: timeBlocks.length ? `${[...new Set(timeBlocks.map(b => timeBlockLabels[b.kind]))].join(" / ")} · 时段不可申请` : blocking.length ? (shared ? "已排期 · 重叠时段不可用" : "独占冲突 · 无法批准")
      : affected.length ? "可抢占低优 · 待审批" : equals.length ? "同级可共享" : "所选时段可用" };
}

/** A new peer needs no second preemption approval for a window already displaced. */
export function displacesBooking(booking: Booking, bookings: Booking[], range: Range) {
  return bookingAvailability(booking, bookings).some(segment => !segment.blockedBy.length && intersects(segment, range));
}
