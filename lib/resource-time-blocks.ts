import type { Resource, ResourceTimeBlock } from "./types";

export const timeBlockLabels = { emergency: "紧急占用", upgrade: "正在升级" };
export const timeBlockTitle = (block: Pick<ResourceTimeBlock, "kind" | "label">) =>
  `${block.label ? `${block.label} · ` : ""}${timeBlockLabels[block.kind]}`;
type Range = { startAt: string; endAt: string };
export function overlappingTimeBlocks(resource: Pick<Resource, "timeBlocks"> | undefined, range: Range) {
  if (!(Date.parse(range.startAt) < Date.parse(range.endAt))) return [];
  return (resource?.timeBlocks ?? []).filter(b => b.status === "active"
    && Date.parse(b.startAt) < Date.parse(range.endAt) && Date.parse(b.endAt) > Date.parse(range.startAt));
}
export function currentTimeBlock(resource: Pick<Resource, "timeBlocks"> | undefined, now: string) {
  return (resource?.timeBlocks ?? []).find(b => b.status === "active" && b.startAt <= now && b.endAt > now);
}
