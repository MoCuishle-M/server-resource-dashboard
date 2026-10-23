import { bookingAvailability } from "./priority";
import type { Booking, Priority, Resource, UsageRequest } from "./types";

export function priorityAdjustmentPlan(bookings: Booking[], requestId: string, resourceIds: string[], priority: Priority, now: string) {
  return bookings.filter(b => b.requestId === requestId && resourceIds.includes(b.resourceId)
    && b.status === "scheduled" && b.endAt > now && b.priority !== priority)
    .map(booking => ({ booking, startAt: booking.startAt < now ? now : booking.startAt, endAt: booking.endAt }));
}

export function priorityAdjustmentPreview(bookings: Booking[], resources: Resource[], request: UsageRequest, resourceIds: string[], priority: Priority, now: string) {
  const plan = priorityAdjustmentPlan(bookings, request.id, resourceIds, priority, now);
  const simulated = bookings.flatMap(b => {
    const change = plan.find(p => p.booking.id === b.id);
    if (!change) return [b];
    return b.startAt < now ? [{ ...b, endAt: now }, { ...b, id: `${b.id}:priority-preview`, startAt: now, priority }]
      : [{ ...b, priority }];
  });
  const changes = plan.map(p => {
    const booking = simulated.find(b => b.id === `${p.booking.id}:priority-preview`) ?? simulated.find(b => b.id === p.booking.id)!;
    return { ...p, segments: bookingAvailability(booking, simulated, resources.find(r => r.id === booking.resourceId)?.sharingMode === "shared") };
  });
  const impacts = bookings.filter(b => b.requestId !== request.id && resourceIds.includes(b.resourceId)
    && b.status === "scheduled" && b.endAt > now && resources.find(r => r.id === b.resourceId)?.sharingMode === "shared")
    .flatMap(booking => {
      const before = bookingAvailability(booking, bookings), after = bookingAvailability(booking, simulated);
      const start = Math.max(Date.parse(booking.startAt), Date.parse(now));
      const boundaries = [...new Set([start, ...before.concat(after).flatMap(s => [Date.parse(s.startAt), Date.parse(s.endAt)])])]
        .filter(t => t >= start).sort((a, b) => a - b);
      return boundaries.slice(0, -1).flatMap((time, i) => {
        const wasBlocked = before.some(s => Date.parse(s.startAt) <= time && Date.parse(s.endAt) > time && s.blockedBy.length > 0);
        const isBlocked = after.some(s => Date.parse(s.startAt) <= time && Date.parse(s.endAt) > time && s.blockedBy.length > 0);
        return wasBlocked === isBlocked ? [] : [{ booking, startAt: new Date(time).toISOString(),
          endAt: new Date(boundaries[i + 1]).toISOString(), wasBlocked, isBlocked }];
      });
    });
  return { changes, impacts };
}
