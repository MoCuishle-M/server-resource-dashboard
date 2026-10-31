"use client";
import { useEffect, useState } from "react";
import { Popover } from "radix-ui";
import { ChevronLeft, ChevronRight, Plus, Search, Server, SlidersHorizontal, ListFilter } from "lucide-react";
import { chinaDate, resourceSharingMode } from "@/lib/domain";
import { resourceStatusLabels } from "@/lib/resource-policy";
import { resourceSearch } from "@/lib/resource-search";
import ResourceTypeFilter from "./resource-type-filter";
import ListPagination, { useListPagination } from "./list-pagination";
import { calendarRange, customRange, layoutBookings, layoutTimeBlocks, shiftDate, timelineTicks, type TimelineRange } from "@/lib/schedule";
import type { Booking, Group, Resource, ResourceTimeBlock, WeeklyPlan } from "@/lib/types";
import { timeBlockTitle } from "@/lib/resource-time-blocks";
import { scheduleNotes } from "@/lib/schedule-notes";
import { bookingAvailability, priorityLabel } from "@/lib/priority";

const localInput = (iso: string) => new Date(Date.parse(iso) + 8 * 3600000).toISOString().slice(0, 16);
const fullTime = (iso: string) => new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hour12: false,
}).format(new Date(iso));
const resourceFields = [
  ["family", "类型"], ["zone", "区域"], ["ip", "IP"], ["name", "服务器名称"],
  ["type", "硬件规格"], ["access", "使用方式"], ["sharing", "共享方式"],
  ["rack", "机柜"], ["location", "位置"], ["note", "备注"], ["status", "资源状态"],
] as const;
type ResourceField = typeof resourceFields[number][0];
const defaultFields: ResourceField[] = ["family", "zone", "ip"];
const fieldStorageKey = "schedule-resource-fields-v1";

export default function ScheduleTimeline({ resources, bookings, groups, weeklyPlans = [], now, onDetail, onRequest, onPriority, onTimeBlock }: {
  resources: Resource[];
  bookings: Booking[];
  groups: Group[];
  weeklyPlans?: WeeklyPlan[];
  now: string;
  onDetail: (resource: Resource) => void;
  onRequest?: (ids: string[], range: TimelineRange) => void;
  onPriority?: (booking: Booking) => void;
  onTimeBlock?: (resource: Resource, range?: TimelineRange, block?: ResourceTimeBlock) => void;
}) {
  const [mode, setMode] = useState<"week" | "day" | "range">("week");
  const [date, setDate] = useState(chinaDate());
  const [search, setSearch] = useState("");
  const [types, setTypes] = useState<string[] | null>(null);
  const [group, setGroup] = useState("");
  const [family, setFamily] = useState("");
  const [zone, setZone] = useState("");
  const [fields, setFields] = useState<ResourceField[]>(defaultFields);
  useEffect(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(fieldStorageKey) ?? "null");
      if (Array.isArray(stored)) {
        const valid = resourceFields.map(([key]) => key).filter(key => stored.includes(key));
        if (valid.length) setFields(valid);
      }
    } catch { /* Storage may be unavailable in private browsing. */ }
  }, []);
  function updateFields(next: ResourceField[]) {
    setFields(next);
    try { localStorage.setItem(fieldStorageKey, JSON.stringify(next)); } catch { /* Keep the current view usable. */ }
  }
  const [applied, setApplied] = useState(() => calendarRange(chinaDate(), "week"));
  const [start, setStart] = useState(() => localInput(applied.startAt));
  const [end, setEnd] = useState(() => localInput(applied.endAt));
  const [error, setError] = useState("");
  const range = mode === "range" ? applied : calendarRange(date, mode);
  const ticks = timelineTicks(range);
  const span = Date.parse(range.endAt) - Date.parse(range.startAt);
  const groupName = (id: string) => groups.find(g => g.id === id)?.name ?? "历史团队";
  const matchesSearch = resourceSearch(search);
  const resourceTypes = [...new Set(resources.map(r => r.type))];
  const resourceRows = resources.filter(r => matchesSearch(r) && (types === null || types.includes(r.type))
    && (!family || (r.family || "unset") === family) && (!zone || (r.zone || "unset") === zone))
    .map(resource => ({ resource, notes: scheduleNotes(weeklyPlans, resource.id, range), blocks: layoutTimeBlocks(resource.timeBlocks ?? [], range), layout: layoutBookings(bookings.filter(b => b.resourceId === resource.id && (!group || b.groupId === group)), range) }))
    .filter(row => !group || row.layout.bars.length > 0);
  const pagination = useListPagination(resourceRows, "schedule-page-size-v1",
    JSON.stringify([search, types, group, family, zone, range.startAt, range.endAt]));
  const fieldValue = (r: Resource, field: ResourceField) => {
    switch (field) {
      case "family": return r.family || "未登记类型";
      case "zone": return r.zone === "green" ? "绿区" : r.zone === "blue" ? "蓝区" : "未登记区域";
      case "access": return r.accessMode === "bare" ? "裸机" : "灵枢平台";
      case "sharing": return resourceSharingMode(r) === "shared" ? "共享" : "独占";
      case "status": return resourceStatusLabels[r.status];
      default: return r[field] || "未登记";
    }
  };
  const currentPercent = (Date.parse(now) - Date.parse(range.startAt)) / span * 100;
  function switchMode(next: typeof mode) {
    if (next === "range" && mode !== "range") {
      setApplied(range); setStart(localInput(range.startAt)); setEnd(localInput(range.endAt));
    }
    setError(""); setMode(next);
  }
  return <section className="panel schedule-panel">
    <div className="section-heading schedule-heading">
      <div>
        <h2>资源时间线</h2>
        <p>同级任务在共享服务器上共用；高优抢占重叠时段，低优保留排期。紧急占用与升级时段暂停预约使用权，结束后自动恢复。{onPriority ? "管理员点击未结束的排期色条可调整优先级。" : "点击查看详情。"}</p>
      </div>
      <div className="schedule-modes" aria-label="排期查看方式">
        {([ ["week", "一周"], ["day", "单日"], ["range", "自定义范围"] ] as const).map(([key, label]) =>
          <button key={key} className={mode === key ? "active" : ""} aria-pressed={mode === key} onClick={() => switchMode(key)}>{label}</button>)}
      </div>
    </div>
    <div className="schedule-controls">
      {mode === "range" ? <form className="schedule-range-form" onSubmit={e => {
        e.preventDefault();
        try { setApplied(customRange(start, end)); setError(""); } catch (e) { setError((e as Error).message); }
      }}>
        <label>开始时间<input aria-label="排期开始时间" type="datetime-local" required value={start} onChange={e => setStart(e.target.value)} /></label>
        <label>结束时间<input aria-label="排期结束时间" type="datetime-local" required value={end} onChange={e => setEnd(e.target.value)} /></label>
        <button className="button primary" type="submit">查看范围</button>
      </form> : <div className="section-tools">
        <button className="icon-button border" aria-label={mode === "week" ? "上一周" : "前一天"} onClick={() => setDate(shiftDate(date, mode === "week" ? -7 : -1))}><ChevronLeft size={17} /></button>
        <input className="date-input" aria-label="排期日期" type="date" value={date} onChange={e => e.target.value && setDate(e.target.value)} />
        <button className="icon-button border" aria-label={mode === "week" ? "下一周" : "后一天"} onClick={() => setDate(shiftDate(date, mode === "week" ? 7 : 1))}><ChevronRight size={17} /></button>
        <button className="button" onClick={() => setDate(chinaDate())}>{mode === "week" ? "本周" : "今天"}</button>
        {mode === "week" && <span className="muted text-small">周一至周日</span>}
      </div>}
      {error && <p className="schedule-error" role="alert">{error}</p>}
      <p className="schedule-range-label" data-start={range.startAt} data-end={range.endAt}>{fullTime(range.startAt)} — {fullTime(range.endAt)} · 北京时间（结束时刻不含在范围内）</p>
    </div>
    <div className="filters schedule-filters">
      <label className={`schedule-group-filter ${group ? "is-filtered" : ""}`}>
        <span><ListFilter size={16} />使用组</span>
        <select aria-label="排期组筛选" value={group} onChange={e => setGroup(e.target.value)}>
          <option value="">全部团队</option>{groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select>
      </label>
      <select aria-label="排期型号筛选" value={family} onChange={e => setFamily(e.target.value)}>
        <option value="">全部类型</option><option value="A3">A3</option><option value="A5">A5</option><option value="unset">未登记类型</option>
      </select>
      <select aria-label="排期区域筛选" value={zone} onChange={e => setZone(e.target.value)}>
        <option value="">全部区域</option><option value="blue">蓝区</option><option value="green">绿区</option><option value="unset">未登记区域</option>
      </select>
      <ResourceTypeFilter types={resourceTypes} selected={types} onChange={setTypes} label="排期类型筛选" allLabel="全部硬件规格" />
      <div className="search"><Search size={16} /><textarea aria-label="搜索排期资源" aria-describedby="schedule-search-help" placeholder="输入 IP，支持多个 IP" rows={1} value={search} onChange={e => setSearch(e.target.value)} /></div>
      <Popover.Root><Popover.Trigger asChild><button className="button"><SlidersHorizontal size={14} />显示信息</button></Popover.Trigger>
        <Popover.Portal><Popover.Content className="schedule-options-popup" align="end" sideOffset={7} collisionPadding={12} aria-label="排期显示信息">
          <h3>服务器显示信息</h3><p>至少保留一项，选择会在此浏览器中记住。</p>
          <div className="schedule-field-options">{resourceFields.map(([key, label]) => <label key={key}><input type="checkbox" checked={fields.includes(key)} disabled={fields.length === 1 && fields.includes(key)} onChange={e => updateFields(e.target.checked ? resourceFields.map(([id]) => id).filter(id => id === key || fields.includes(id)) : fields.filter(id => id !== key))} />{label}</label>)}</div>
          <button className="text-button" onClick={() => updateFields(defaultFields)}>恢复默认</button>
        </Popover.Content></Popover.Portal>
      </Popover.Root>
      <span className="muted text-small">{resourceRows.length} / {resources.length} 台</span>
      {(search || family || zone || group || types !== null) && <button className="text-button" onClick={() => { setSearch(""); setFamily(""); setZone(""); setGroup(""); setTypes(null); }}>清除筛选</button>}
    </div>
    <p id="schedule-search-help" className="resource-search-help">多个 IP 用空格、逗号或换行分隔；也可搜索名称、规格、位置或备注。悬停排期查看完整理由和起止时间。</p>
    <ListPagination pagination={pagination} label="资源时间线" />
    <div className="table-scroll schedule-scroll" tabIndex={0} aria-label="连续时间排期表，可横向滚动">
      <table className="schedule-table" aria-label="服务器连续时间排期">
        <colgroup><col className="schedule-server-col" /><col /></colgroup>
        <thead><tr><th scope="col">{resourceFields.filter(([key]) => fields.includes(key)).map(([, label]) => label).join(" · ")}</th><th scope="col" className="timeline-header">
          <div className="timeline-axis" aria-label="连续时间刻度">
            {ticks.map((tick, i) => <span key={tick.at} className={`timeline-tick ${i === ticks.length - 1 ? "last" : ""}`} style={{ left: `${tick.percent}%` }}>
              <strong>{new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit" }).format(new Date(tick.at))}</strong>
              <small>{span > 3 * 86400000 && i < ticks.length - 1
                ? new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", weekday: "short" }).format(new Date(tick.at))
                : localInput(tick.at).slice(11)}</small>
            </span>)}
          </div>
        </th></tr></thead>
        <tbody>{pagination.rows.map(({ resource: r, layout, notes, blocks }) => <tr key={r.id}>
          <td className="schedule-server">
            <div className="schedule-resource-line"><button className="schedule-resource-info" aria-label={`查看服务器 ${r.ip} 详情`} onClick={() => onDetail(r)}>{fields.map(field => <span key={field} className={`schedule-field schedule-field-${field}`} title={`${resourceFields.find(([key]) => key === field)![1]}：${fieldValue(r, field)}`}>{fieldValue(r, field)}</span>)}</button>
            {onRequest && <button className="icon-button schedule-apply" aria-label="申请" title={r.status !== "available" ? resourceStatusLabels[r.status] : range.endAt <= now ? "历史排期" : "申请此服务器"} disabled={r.status !== "available" || range.endAt <= now} onClick={() => onRequest([r.id], range)}><Plus size={14} /></button>}</div>
            {onTimeBlock && range.endAt > now && <button className="text-button" aria-label={`标记时段 ${r.ip}`} onClick={() => onTimeBlock(r, { startAt: range.startAt < now ? now : range.startAt, endAt: range.endAt })}>标记时段</button>}
          </td>
          <td className="timeline-cell"><div className="timeline-track" style={{ height: `calc(${layout.lanes + (blocks.bars.length ? blocks.lanes : 0)} * var(--timeline-lane-height) + 12px)` }}>
            {ticks.map(tick => <i key={tick.at} className="timeline-gridline" style={{ left: `${tick.percent}%` }} aria-hidden="true" />)}
            {currentPercent >= 0 && currentPercent < 100 && <i className="timeline-now" style={{ left: `${currentPercent}%` }} title="当前时间" aria-hidden="true" />}
            {!layout.bars.length && !blocks.bars.length && <span className="timeline-empty">{r.status !== "available" ? resourceStatusLabels[r.status] : "暂无排期"}</span>}
            {blocks.bars.map(({ booking: block, lane, left, width, continuesBefore, continuesAfter }) => {
              const label = `${timeBlockTitle(block)} · ${fullTime(block.startAt)} — ${fullTime(block.endAt)} · 预约使用权暂停，原排期保留`;
              return <button key={block.id} className={`booking-chip timeline-booking timeline-time-block time-block-${block.kind}`} style={{ left: `${left}%`, width: `${width}%`, top: `calc(${lane} * var(--timeline-lane-height) + 6px)` }} aria-label={label} title={`${label}${onTimeBlock && block.endAt > now ? "\n点击编辑时段标记" : ""}`} onClick={() => onTimeBlock && block.endAt > now ? onTimeBlock(r, undefined, block) : onDetail(r)}><span className="timeline-summary">{continuesBefore ? "‹ " : ""}<strong>{timeBlockTitle(block)}</strong>{continuesAfter ? " ›" : ""}</span></button>;
            })}
            {layout.bars.map(({ booking: b, lane, left, width, continuesBefore, continuesAfter }) => {
              const visibleStart = Math.max(Date.parse(b.startAt), Date.parse(range.startAt));
              const visibleEnd = Math.min(Date.parse(b.endAt), Date.parse(range.endAt));
              const segments = bookingAvailability(b, bookings, resourceSharingMode(r) === "shared", r.timeBlocks);
              const blocked = segments.filter(s => (b.status === "preempted" || s.blockedBy.length || s.blockedByTimeBlocks.length) && Date.parse(s.startAt) < visibleEnd && Date.parse(s.endAt) > visibleStart);
              const blockedDuration = blocked.reduce((sum, s) => sum + Math.min(visibleEnd, Date.parse(s.endAt)) - Math.max(visibleStart, Date.parse(s.startAt)), 0);
              const status = blockedDuration >= visibleEnd - visibleStart ? "已排期 · 暂不可用" : blocked.length ? blocked.some(s => s.blockedByTimeBlocks.length) ? "部分时段不可用" : "部分时段被抢占" : segments.some(s => s.sharedWith.length) ? "同级共享 · 可用" : "可用";
              const label = `${priorityLabel[b.priority]} · ${status} · ${groupName(b.groupId)} · ${b.purpose} · ${fullTime(b.startAt)} — ${fullTime(b.endAt)}${b.status === "released" ? " · 已提前释放" : ""}${blocked.map(s => `\n暂不可用：${fullTime(s.startAt)} — ${fullTime(s.endAt)}，${s.blockedByTimeBlocks.length ? s.blockedByTimeBlocks.map(timeBlockTitle).join("、") : s.blockedBy.length ? s.blockedBy.map(x => `${groupName(x.groupId)} · ${x.purpose}`).join("、") : "已被高优任务抢占"}`).join("")}`;
              const editable = !!onPriority && b.status === "scheduled" && b.endAt > now;
              return <button key={b.id} className={`booking-chip timeline-booking priority-${b.priority} ${blocked.length ? "has-blocked-time" : ""}`} style={{ left: `${left}%`, width: `${width}%`, top: `calc(${lane + (blocks.bars.length ? blocks.lanes : 0)} * var(--timeline-lane-height) + 6px)` }} title={`${label}${editable ? "\n点击调整优先级" : ""}`} aria-label={label} onClick={() => editable ? onPriority!(b) : onDetail(r)} data-booking-id={b.id}>
                {blocked.map(s => <i key={s.startAt} className="timeline-blocked-overlay" aria-hidden="true" style={{ left: `${(Math.max(visibleStart, Date.parse(s.startAt)) - visibleStart) / (visibleEnd - visibleStart) * 100}%`, width: `${(Math.min(visibleEnd, Date.parse(s.endAt)) - Math.max(visibleStart, Date.parse(s.startAt))) / (visibleEnd - visibleStart) * 100}%` }} />)}
                <span className="timeline-summary">{continuesBefore ? "‹ " : ""}<strong>{groupName(b.groupId)}</strong><span> · {b.purpose}</span>{continuesAfter ? " ›" : ""}</span>
                {(blocked.length > 0 || b.status === "released") && <small className="timeline-availability">{b.status === "released" ? "已提前释放" : status}</small>}
              </button>;
            })}
          </div>
          {!!notes.length && <div className="schedule-special-notes" aria-label={`${r.ip}特殊用途`}>
            {notes.map(({ weekStart, note }) => <div key={weekStart}><strong>特殊用途{notes.length > 1 ? `（${weekStart}周）` : ""}</strong><span>{note}</span></div>)}
          </div>}
          </td>
        </tr>)}</tbody>
      </table>
      {!resourceRows.length && <div className="empty"><Server size={28} /><h3>{resources.length ? "没有符合条件的排期资源" : "添加资源后即可查看排期"}</h3></div>}
    </div>
    <ListPagination pagination={pagination} label="资源时间线" bottom />
    <div className="schedule-legend priority-legend"><span><i className="priority-swatch normal" />普通</span><span><i className="priority-swatch high" />高优</span><span><i className="priority-swatch urgent" />紧急</span><span><i className="priority-swatch blocked" />斜纹：暂不可用，排期保留</span><span><i className="priority-swatch time-block-emergency" />紧急占用标记</span><span><i className="priority-swatch time-block-upgrade" />正在升级</span><span>同级共用仅适用于共享服务器</span></div>
  </section>;
}
