import { ipValid } from "./domain";
import type { Resource } from "./types";

export function resourceSearch(query: string) {
  const terms = query.trim().split(/[\s,]+/).filter(Boolean);
  const ips = terms.length && terms.every(ipValid)
    ? new Set(terms.map(ip => ip.toLowerCase()))
    : null;
  const text = query.trim().toLowerCase();
  return (resource: Pick<Resource, "name" | "ip" | "type" | "note"> & { location?: string }) =>
    !terms.length || (ips
      ? ips.has(resource.ip.toLowerCase())
      : `${resource.name} ${resource.ip} ${resource.type} ${resource.note} ${resource.location ?? ""}`.toLowerCase().includes(text));
}
