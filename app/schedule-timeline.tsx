"use client";
import { useState } from "react";
import { CalendarClock, ChevronLeft, ChevronRight, Plus, Search, Server, ListFilter } from "lucide-react";
import { chinaDate, resourceSharingMode } from "@/lib/domain";
import { resourceStatusLabels } from "@/lib/resource-policy";
import { resourceSearch } from "@/lib/resource-search";
import ResourceTypeFilter from "./resource-type-filter";
import ListPagination, { useListPagination } from "./list-pagination";
import { calendarRange, customRange, layoutBookings, layoutTimeBlocks, shiftDate, timelineTicks, type TimelineRange } from "@/lib/schedule";
import type { Booking, Group, Resource, ResourceTimeBlock, WeeklyPlan } from "@/lib/types";
import { timeBlockTitle } from "@/lib/resource-time-blocks";
import { scheduleNoteDisplay, scheduleNotes } from "@/lib/schedule-notes";
import { bookingAvailability, priorityLabel } from "@/lib/priority";

const localInput = (iso: string) => new Date(Date.parse(iso) + 8 * 3600000).toISOString().slice(0, 16);
const fullTime = (iso: string) => new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hour12: false,
}).format(new Date(iso));
const groupOrder = new Intl.Collator("zh-CN", { numeric: true });

function rackKey(r: Resource) {
  const rack = r.rack?.trim();
  // A cabinet number can be reused in another room, and an empty value does not identify a cabinet.
  return rack ? JSON.stringify([r.family, r.zone, r.location.trim(), rack]) : JSON.stringify([r.id]);
}

function groupByRack<T>(items: T[], getResource: (item: T) => Resource) {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = rackKey(getResource(item));
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return groups;
}

function resourceGroupLabel(r: Resource) {
  const zone = r.zone === "green" ? "绿区" : r.zone === "blue" ? "蓝区" : "未登记区域";
  const rack = r.rack?.trim();
  const cabinet = rack?.match(/^(?:计算柜|机柜|柜)?\s*(\d+)\s*柜?$/)?.[1];
  return `${r.family || "未登记类型"} ${r.family === "A5" && rack ? `${zone}${cabinet ? cabinet + "柜" : " " + rack}` : zone}`;
}

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
  const [mode, setMode] = useState<"week" | "day" | "range">("day");
  const [date, setDate] = useState(() => chinaDate());
  const [search, setSearch] = useState("");
  const [types, setTypes] = useState<string[] | null>(null);
  const [group, setGroup] = useState("");
  const [family, setFamily] = useState("");
  const [zone, setZone] = useState("");
  const [applied, setApplied] = useState(() => calendarRange(date, "day"));
  const [start, setStart] = useState(() => localInput(applied.startAt));
  const [end, setEnd] = useState(() => localInput(applied.endAt));
  const [error, setError] = useState("");
  const range = mode === "range" ? applied : calendarRange(date, mode);
  const ticks = timelineTicks(range);
  const span = Date.parse(range.endAt) - Date.parse(range.startAt);
  const groupName = (id: string) => groups.find(g => g.id === id)?.name ?? "历史团队";
  function bookingText(b: Booking, r: Resource) {
    const visibleStart = Math.max(Date.parse(b.startAt), Date.parse(range.startAt));
    const visibleEnd = Math.min(Date.parse(b.endAt), Date.parse(range.endAt));
    const segments = bookingAvailability(b, bookings, resourceSharingMode(r) === "shared", r.timeBlocks);
    const blocked = segments.filter(s => (b.status === "preempted" || s.blockedBy.length || s.blockedByTimeBlocks.length) && Date.parse(s.startAt) < visibleEnd && Date.parse(s.endAt) > visibleStart);
    const blockedDuration = blocked.reduce((sum, s) => sum + Math.min(visibleEnd, Date.parse(s.endAt)) - Math.max(visibleStart, Date.parse(s.startAt)), 0);
    const status = blockedDuration >= visibleEnd - visibleStart ? "已排期 · 暂不可用" : blocked.length ? blocked.some(s => s.blockedByTimeBlocks.length) ? "部分时段不可用" : "部分时段被抢占" : segments.some(s => s.sharedWith.length) ? "同级共享 · 可用" : "可用";
    const label = `${priorityLabel[b.priority]} · ${status} · ${groupName(b.groupId)} · ${b.purpose} · ${fullTime(b.startAt)} — ${fullTime(b.endAt)}${b.status === "released" ? " · 已提前释放" : ""}${blocked.map(s => `\n暂不可用：${fullTime(s.startAt)} — ${fullTime(s.endAt)}，${s.blockedByTimeBlocks.length ? s.blockedByTimeBlocks.map(timeBlockTitle).join("、") : s.blockedBy.length ? s.blockedBy.map(x => `${groupName(x.groupId)} · ${x.purpose}`).join("、") : "已被高优任务抢占"}`).join("")}`;
    return { label, status, isBlocked: blocked.length > 0 };
  }
  const matchesSearch = resourceSearch(search);
  const resourceTypes = [...new Set(resources.map(r => r.type))];
  const resourceRows = resources.filter(r => matchesSearch(r) && (types === null || types.includes(r.type))
    && (!family || (r.family || "unset") === family) && (!zone || (r.zone || "unset") === zone))
    .map(resource => {
      const { bars } = layoutBookings(bookings.filter(b => b.resourceId === resource.id && (!group || b.groupId === group)), range);
      const regular = new Map<string, Booking[]>();
      for (const { booking } of bars) {
        if (booking.priority !== "normal") continue;
        const entries = regular.get(booking.groupId);
        if (entries) entries.push(booking);
        else regular.set(booking.groupId, [booking]);
      }
      return {
        resource, regular,
        notes: scheduleNoteDisplay(scheduleNotes(weeklyPlans, resource.id, range)),
        blocks: layoutTimeBlocks(resource.timeBlocks ?? [], range),
        elevated: bars.filter(({ booking }) => booking.priority !== "normal"),
      };
    })
    .filter(row => !group || row.regular.size > 0 || row.elevated.length > 0);
  const byRack = groupByRack(resourceRows, row => row.resource);
  const allRacks = groupByRack(resources, resource => resource);
  const pagination = useListPagination([...byRack.values()].flat(), "schedule-page-size-v1",
    JSON.stringify([search, types, group, family, zone, range.startAt, range.endAt]));
  const pageRacks = groupByRack(pagination.rows, row => row.resource);
  const showTimeBlock = !!onTimeBlock && range.endAt > now;
  const showActions = !!onRequest || showTimeBlock;
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
        <p>「使用组」显示所选日期内的常态安排。右侧显示高优、紧急排期和时段标记，同级重叠时分行。未被临时占用或停用的时段按常态安排使用。点击 IP 或组名可查看详情。</p>
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
      <span className="muted text-small">{resourceRows.length} / {resources.length} 台</span>
      {(search || family || zone || group || types !== null) && <button className="text-button" onClick={() => { setSearch(""); setFamily(""); setZone(""); setGroup(""); setTypes(null); }}>清除筛选</button>}
    </div>
    <p id="schedule-search-help" className="resource-search-help">多个 IP 用空格、逗号或换行分隔；也可搜索名称、规格、位置或备注。悬停组名或排期色条查看事项和起止时间。</p>
    <ListPagination pagination={pagination} label="资源时间线" />
    <div className="table-scroll schedule-scroll" tabIndex={0} aria-label="连续时间排期表，可横向滚动">
      <table className="schedule-table" aria-label="服务器连续时间排期">
        <colgroup><col className="schedule-group-col" /><col className="schedule-ip-col" />{showActions && <col className="schedule-actions-col" />}<col className="schedule-usage-col" /><col /></colgroup>
        <thead><tr><th scope="col" className="schedule-group-cell">类型·区域·机柜</th><th scope="col" className="schedule-ip-cell">IP</th>{showActions && <th scope="col" className="schedule-actions-cell">操作</th>}<th scope="col" className="schedule-usage-cell">使用组</th><th scope="col" className="timeline-header">
          <div className="timeline-axis" aria-label="连续时间刻度">
            {ticks.map((tick, i) => <span key={tick.at} className={`timeline-tick ${i === ticks.length - 1 ? "last" : ""}`} style={{ left: `${tick.percent}%` }}>
              <strong>{new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit" }).format(new Date(tick.at))}</strong>
              <small>{span > 3 * 86400000 && i < ticks.length - 1
                ? new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", weekday: "short" }).format(new Date(tick.at))
                : localInput(tick.at).slice(11)}</small>
            </span>)}
          </div>
        </th></tr></thead>
        {[...pageRacks].map(([key, rows]) => {
          const merged = rows.length > 1 && rows.length === allRacks.get(key)?.length;
          return <tbody key={key}>{rows.map(({ resource: r, regular, elevated, notes, blocks }, i) => <tr key={r.id}>
          {(!merged || i === 0) && <th className="schedule-group-cell" scope={merged ? "rowgroup" : "row"} rowSpan={merged ? rows.length : undefined}>{resourceGroupLabel(r)}</th>}
          <td className={`schedule-ip-cell${notes.smoke.length ? " is-smoke" : ""}`}>
            <button className="schedule-resource-info" aria-label={`查看服务器 ${r.ip} 详情`} onClick={() => onDetail(r)}>{r.ip}</button>
            {!!notes.smoke.length && <div><span className="schedule-smoke-tag" title={notes.smoke.join("\n")}>冒烟</span></div>}
            {!!notes.other.length && <div className="schedule-ip-notes">
              {notes.other.map(({ weekStart, note }) => <div key={weekStart}>{notes.other.length > 1 && <strong>{weekStart} 周</strong>}{note}</div>)}
            </div>}
          </td>
          {showActions && <td className="schedule-actions-cell"><div className="schedule-row-actions">
            {onRequest && <button className="icon-button schedule-apply" aria-label="申请" title={r.status !== "available" ? resourceStatusLabels[r.status] : range.endAt <= now ? "历史排期" : "申请此服务器"} disabled={r.status !== "available" || range.endAt <= now} onClick={() => onRequest([r.id], range)}><Plus size={15} /></button>}
            {showTimeBlock && <button className="icon-button schedule-apply" title="标记时段" aria-label={`标记时段 ${r.ip}`} onClick={() => onTimeBlock(r, { startAt: range.startAt < now ? now : range.startAt, endAt: range.endAt })}><CalendarClock size={15} /></button>}
          </div></td>}
          <td className="schedule-usage-cell">
            {regular.size ? <div className="schedule-usage-list">{[...regular].sort(([a], [b]) => groupOrder.compare(groupName(a), groupName(b))).map(([groupId, entries]) =>
              <button key={groupId} className="schedule-usage-name" title={entries.map(b => bookingText(b, r).label).join("\n\n")} onClick={() => onDetail(r)}>{groupName(groupId)}</button>
            )}</div> : <span className="muted" aria-label="无常态使用组">—</span>}
          </td>
          <td className="timeline-cell">
            <div className="timeline-guides" aria-hidden="true">
            {ticks.map(tick => <i key={tick.at} className="timeline-gridline" style={{ left: `${tick.percent}%` }} aria-hidden="true" />)}
            {currentPercent >= 0 && currentPercent < 100 && <i className="timeline-now" style={{ left: `${currentPercent}%` }} title="当前时间" aria-hidden="true" />}
            </div>
            <div className="timeline-track" style={{ height: `calc(${Math.max(blocks.lanes, ...elevated.map(bar => bar.lane + 1))} * var(--timeline-lane-height) + 12px)` }}>
            {!elevated.length && !blocks.bars.length && (r.status !== "available" || !regular.size) && <span className="timeline-empty">{r.status !== "available" ? resourceStatusLabels[r.status] : "暂无排期"}</span>}
            {blocks.bars.map(({ booking: block, lane, left, width, continuesBefore, continuesAfter }) => {
              const label = `${timeBlockTitle(block)} · ${fullTime(block.startAt)} — ${fullTime(block.endAt)} · 预约使用权暂停，原排期保留`;
              return <button key={block.id} className={`booking-chip timeline-booking timeline-time-block time-block-${block.kind}`} style={{ left: `${left}%`, width: `${width}%`, top: `calc(${lane} * var(--timeline-lane-height) + 6px)` }} aria-label={label} title={`${label}${onTimeBlock && block.endAt > now ? "\n点击编辑时段标记" : ""}`} onClick={() => onTimeBlock && block.endAt > now ? onTimeBlock(r, undefined, block) : onDetail(r)}><span className="timeline-summary">{continuesBefore ? "‹ " : ""}<strong>{timeBlockTitle(block)}</strong>{continuesAfter ? " ›" : ""}</span></button>;
            })}
            {elevated.map(({ booking: b, lane, left, width, continuesBefore, continuesAfter }) => {
              const { label, status, isBlocked } = bookingText(b, r);
              const editable = !!onPriority && b.status === "scheduled" && b.endAt > now;
              return <button key={b.id} className={`booking-chip timeline-booking priority-${b.priority}`} style={{ left: `${left}%`, width: `${width}%`, top: `calc(${lane} * var(--timeline-lane-height) + 6px)` }} title={`${label}${editable ? "\n点击调整优先级" : ""}`} aria-label={label} onClick={() => editable ? onPriority!(b) : onDetail(r)} data-booking-id={b.id}>
                <span className="timeline-summary">{continuesBefore ? "‹ " : ""}<strong>{groupName(b.groupId)}</strong><span> · {b.purpose}</span>{continuesAfter ? " ›" : ""}</span>
                {(isBlocked || b.status === "released") && <small className="timeline-availability">{b.status === "released" ? "已提前释放" : status}</small>}
              </button>;
            })}
          </div>
          </td>
        </tr>)}</tbody>;
        })}
      </table>
      {!resourceRows.length && <div className="empty"><Server size={28} /><h3>{resources.length ? "没有符合条件的排期资源" : "添加资源后即可查看排期"}</h3></div>}
    </div>
    <ListPagination pagination={pagination} label="资源时间线" bottom />
    <div className="schedule-legend priority-legend"><span><i className="priority-swatch high" />高优</span><span><i className="priority-swatch urgent" />紧急</span><span><i className="priority-swatch time-block-emergency" />紧急占用标记</span><span><i className="priority-swatch time-block-upgrade" />正在升级</span><span>同级共用仅适用于共享服务器</span></div>
  </section>;
}
