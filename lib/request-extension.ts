import type { Booking, Resource, UsageRequest } from "./types";

/** Released or preempted end segments must not be restored by extending a request. */
export function extensionResourceIds(request: UsageRequest, bookings: Booking[], now: string, allowExpired = false, resources?: Resource[]) {
  return request.resourceIds.filter(id => (!resources || resources.some(r => r.id === id && !r.deleted && r.status === "available"))
    && bookings.some(b => b.requestId === request.id && b.resourceId === id
    && b.status === "scheduled" && b.endAt === request.endAt && (allowExpired || b.endAt > now)));
}
