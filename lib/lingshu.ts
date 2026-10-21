import type { Group, LingshuStatus, Resource } from "./types";
export const PLATFORM_GROUP_ID = "g11";
export const lingshuStatusLabels: Record<LingshuStatus, string> = {
  platform: "通过灵枢平台使用",
  ticket: "通过工单占用",
  pool_platform: "通过统一资源池+灵枢平台使用",
};
export const platformGroup = (): Group => ({ id: PLATFORM_GROUP_ID, name: "灵枢平台", contactName: "", employeeId: "" });
export function resourceLingshuStatus(resource?: Pick<Resource, "accessMode" | "lingshuStatus">) {
  return resource?.accessMode === "lingshu" ? resource.lingshuStatus ?? "platform" : undefined;
}
export function resourceLingshuLabel(resource?: Pick<Resource, "accessMode" | "lingshuStatus">) {
  const status = resourceLingshuStatus(resource);
  return status ? lingshuStatusLabels[status] : "";
}
