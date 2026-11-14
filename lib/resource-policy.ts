import type { Actor, Resource, State } from "./types";

export const resourceStatusLabels: Record<Resource["status"], string> = {
  available: "可申请", maintenance: "维护中", unavailable: "不可用", fault: "故障中",
};

export function canViewNpuUsage(actor: Pick<Actor, "role">) {
  return actor.role === "admin" || actor.role === "contact" || actor.role === "visitor";
}

/** Apply before serializing, including action responses and demo role changes. */
export function visibleResourceState(s: State, actor: Actor): State {
  if (actor.role === "admin") return s;
  const hidden = new Set(s.resources.filter(r => r.hidden).map(r => r.id));
  const privateRequests = new Set(s.requests.filter(r => r.resourceIds.some(id => hidden.has(id))).map(r => r.id));
  const privateBookings = new Set(s.bookings.filter(b => hidden.has(b.resourceId) || privateRequests.has(b.requestId)).map(b => b.id));
  return {
    ...s,
    resources: s.resources.filter(r => !hidden.has(r.id)),
    requests: s.requests.filter(r => !privateRequests.has(r.id)),
    // Visible servers still show their occupancy, even in a mixed-resource request.
    bookings: s.bookings.filter(b => !hidden.has(b.resourceId)).map(b => privateRequests.has(b.requestId)
      ? { ...b, purpose: "资源使用预约" } : b),
    audits: s.audits.filter(a =>
      !a.entityId.split(",").some(id => hidden.has(id) || privateRequests.has(id) || privateBookings.has(id))),
  };
}
