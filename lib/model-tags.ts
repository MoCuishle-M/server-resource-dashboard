import type { DemandModelTag, WorkspaceDemand, WorkspaceModelTag } from "./types";

export const modelPriorityLabels = { 0: "P0 · 最高", 1: "P1 · 高", 2: "P2 · 普通", 3: "P3 · 低" } as const;
export const splitModelNames = (value: string) => [...new Map(value.split(/[、,，;；\n]+/).map(x => x.trim()).filter(Boolean).map(x => [x.toLowerCase(), x])).values()];
/** Existing text-only labels remain visible without assigning an invented priority. */
export function demandModelTags(d: Pick<WorkspaceDemand, "model" | "modelTags">, rules: WorkspaceModelTag[] = []): DemandModelTag[] {
  if (d.modelTags !== undefined) return d.modelTags.map(tag => rules.find(x => x.id === tag.id) ?? tag);
  return splitModelNames(d.model).map(name => rules.find(x => x.name.toLowerCase() === name.toLowerCase()) ?? { id: `legacy:${name.toLowerCase()}`, name });
}
export function demandModelPriority(d: Pick<WorkspaceDemand, "model" | "modelTags">, rules: WorkspaceModelTag[] = []) {
  const values = demandModelTags(d, rules).flatMap(t => t.priority === undefined ? [] : [t.priority]);
  return values.length ? Math.min(...values) as 0 | 1 | 2 | 3 : undefined;
}
export const formatModelPriority = (priority: number | undefined) => priority === undefined ? "未配置" : modelPriorityLabels[priority as 0 | 1 | 2 | 3];
