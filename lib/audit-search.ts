import type { Audit } from "./types";
export type AuditRange = { startAt?: number; endAt?: number };

export function auditRange(start: string, end: string): AuditRange {
  function parse(value: string) {
    if (!value) return undefined;
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value))
      throw new Error("请输入完整的日期时间");
    const time = Date.parse(`${value}+08:00`);
    if (!Number.isFinite(time)) throw new Error("日期时间格式不正确");
    return time;
  }
  const startAt = parse(start), endTime = parse(end);
  if (startAt !== undefined && endTime !== undefined && startAt > endTime)
    throw new Error("结束时间不能早于开始时间");
  // Include all events within the selected ending minute or second.
  const endAt = endTime === undefined ? undefined : endTime + (end.length === 16 ? 59999 : 999);
  return { startAt, endAt };
}

export function filterAudits(audits: Audit[], { types, search, startAt, endAt }: AuditRange & { types: string[] | null; search: string }) {
  const keyword = search.trim().toLowerCase();
  return audits.filter(a => {
    const time = Date.parse(a.at);
    return (types === null || types.includes(a.action)) &&
      (!keyword || `${a.summary} ${a.actorName} ${a.action}`.toLowerCase().includes(keyword)) &&
      (startAt === undefined || time >= startAt) && (endAt === undefined || time <= endAt);
  }).sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || b.id.localeCompare(a.id));
}

export const auditTime = (iso: string) => new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
}).format(new Date(iso));
