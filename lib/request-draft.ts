import type { Actor, Resource, UsageRequest } from "./types";

export function copyRequestDraft(source: UsageRequest, resources: Resource[], actor: Actor, now: string) {
  const resourceIds = source.resourceIds.filter(id => resources.some(r =>
    r.id === id && !r.deleted && r.status === "available" && (!r.hidden || actor.role === "admin")));
  const originalStart = Date.parse(source.startAt);
  const minStart = Date.parse(now) + 60000;
  // Beijing has no daylight-saving shift; retain the original time of day and duration.
  const days = Math.max(0, Math.ceil((minStart - originalStart) / 86400000));
  return {
    resourceIds,
    groupId: actor.role === "admin" ? source.groupId : actor.groupId,
    purpose: source.purpose,
    priority: source.priority,
    startAt: new Date(originalStart + days * 86400000).toISOString(),
    endAt: new Date(Date.parse(source.endAt) + days * 86400000).toISOString(),
    shifted: days > 0,
    skipped: source.resourceIds.length - resourceIds.length,
  };
}
