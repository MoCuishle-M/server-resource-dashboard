import type { Booking } from "./types";

/** Half-open intervals: cancelling 12–14 preserves both adjacent boundaries. */
export function partialCancellationPlan(
  bookings: Booking[],
  requestId: string,
  resourceIds: string[],
  range: { startAt: string; endAt: string },
) {
  const start = Date.parse(range.startAt), end = Date.parse(range.endAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
  return bookings.flatMap((booking) => {
    if (booking.requestId !== requestId || booking.status !== "scheduled" ||
        !resourceIds.includes(booking.resourceId)) return [];
    const cutStart = Math.max(start, Date.parse(booking.startAt));
    const cutEnd = Math.min(end, Date.parse(booking.endAt));
    if (cutEnd <= cutStart) return [];
    const cancelled = { startAt: new Date(cutStart).toISOString(), endAt: new Date(cutEnd).toISOString() };
    const retained: { startAt: string; endAt: string }[] = [];
    if (Date.parse(booking.startAt) < cutStart) retained.push({ startAt: booking.startAt, endAt: cancelled.startAt });
    if (Date.parse(booking.endAt) > cutEnd) retained.push({ startAt: cancelled.endAt, endAt: booking.endAt });
    return [{ booking, cancelled, retained }];
  });
}
