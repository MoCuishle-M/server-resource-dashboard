"use client";
import { useState } from "react";
import { ChevronLeft, ChevronRight, Plus, Search, Server, Zap } from "lucide-react";
import { chinaDate, resourceSharingMode } from "@/lib/domain";
import { resourceStatusLabels } from "@/lib/resource-policy";
import { calendarRange, customRange, layoutBookings, shiftDate, timelineTicks, type TimelineRange } from "@/lib/schedule";
import type { Booking, Group, Resource } from "@/lib/types";

const localInput = (iso: string) => new Date(Date.parse(iso) + 8 * 3600000).toISOString().slice(0, 16);
const fullTime = (iso: string) => new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hour12: false,
}).format(new Date(iso));

export default function ScheduleTimeline({ resources, bookings, groups, now, onDetail, onRequest }: {
  resources: Resource[];
  bookings: Booking[];
  groups: Group[];
  now: string;
  onDetail: (resource: Resource) => void;
  onRequest: (ids: string[], range: TimelineRange) => void;
}) {
  const [mode, setMode] = useState<"week" | "day" | "range">("week");
  const [date, setDate] = useState(chinaDate());
  const [search, setSearch] = useState("");
  const [group, setGroup] = useState("");
  const [applied, setApplied] = useState(() => calendarRange(chinaDate(), "week"));
  const [start, setStart] = useState(() => localInput(applied.startAt));
  const [end, setEnd] = useState(() => localInput(applied.endAt));
  const [error, setError] = useState("");
  const range = mode === "range" ? applied : calendarRange(date, mode);
  const ticks = timelineTicks(range);
  const span = Date.parse(range.endAt) - Date.parse(range.startAt);
  const groupName = (id: string) => groups.find(g => g.id === id)?.name ?? "历史团队";
  const resourceRows = resources.filter(r => !search || `${r.name} ${r.ip} ${r.type} ${r.location}`.toLowerCase().includes(search.toLowerCase()))
    .map(resource => ({ resource, layout: layoutBookings(bookings.filter(b => b.resourceId === resource.id && (!group || b.groupId === group)), range) }))
    .filter(row => !group || row.layout.bars.length > 0);
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
        <p>色条按实际起止时间连续显示；共享任务分行展示。点击色条或服务器查看详情。</p>
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
    <div className="filters">
      <div className="search"><Search size={16} /><input aria-label="搜索排期资源" placeholder="搜索名称、IP、类型或位置" value={search} onChange={e => setSearch(e.target.value)} /></div>
      <select aria-label="排期组筛选" value={group} onChange={e => setGroup(e.target.value)}>
        <option value="">全部团队</option>
        {groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
      </select>
      <span className="muted text-small">{resourceRows.length} 台服务器 · 申请时可选预设时段</span>
    </div>
    <div className="table-scroll schedule-scroll" tabIndex={0} aria-label="连续时间排期表，可横向滚动">
      <table className="schedule-table" aria-label="服务器连续时间排期">
        <colgroup><col className="schedule-server-col" /><col /></colgroup>
        <thead><tr><th scope="col">服务器 / 使用方式</th><th scope="col" className="timeline-header">
          <div className="timeline-axis" aria-label="连续时间刻度">
            {ticks.map((tick, i) => <span key={tick.at} className={`timeline-tick ${i === ticks.length - 1 ? "last" : ""}`} style={{ left: `${tick.percent}%` }}>
              <strong>{new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit" }).format(new Date(tick.at))}</strong>
              <small>{span > 3 * 86400000 && i < ticks.length - 1
                ? new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", weekday: "short" }).format(new Date(tick.at))
                : localInput(tick.at).slice(11)}</small>
            </span>)}
          </div>
        </th></tr></thead>
        <tbody>{resourceRows.map(({ resource: r, layout }) => <tr key={r.id}>
          <td className="schedule-server">
            <button className="resource-name" onClick={() => onDetail(r)}><span className="server-icon"><Server size={16} /></span><span><strong>{r.name}</strong><small>{r.accessMode === "bare" ? "裸机" : "灵枢平台"} · {resourceSharingMode(r) === "shared" ? "共享" : "独占"}</small><small>{r.ip}</small></span></button>
            <button className="text-button schedule-apply" disabled={r.status !== "available" || range.endAt <= now} onClick={() => onRequest([r.id], range)}><Plus size={12} />{r.status !== "available" ? resourceStatusLabels[r.status] : range.endAt <= now ? "历史排期" : "申请"}</button>
          </td>
          <td className="timeline-cell"><div className="timeline-track" style={{ height: `${layout.lanes * 70 + 12}px` }}>
            {ticks.map(tick => <i key={tick.at} className="timeline-gridline" style={{ left: `${tick.percent}%` }} aria-hidden="true" />)}
            {currentPercent >= 0 && currentPercent < 100 && <i className="timeline-now" style={{ left: `${currentPercent}%` }} title="当前时间" aria-hidden="true" />}
            {!layout.bars.length && <span className="timeline-empty">{r.status !== "available" ? resourceStatusLabels[r.status] : "暂无排期"}</span>}
            {layout.bars.map(({ booking: b, lane, left, width, continuesBefore, continuesAfter }) => {
              const label = `${groupName(b.groupId)} · ${b.purpose} · ${fullTime(b.startAt)} — ${fullTime(b.endAt)}${b.status === "released" ? " · 已提前释放" : ""}`;
              return <button key={b.id} className={`booking-chip timeline-booking color-${Number(b.groupId.slice(1)) % 5}`} style={{ left: `${left}%`, width: `${width}%`, top: `${lane * 70 + 6}px` }} title={label} aria-label={label} onClick={() => onDetail(r)} data-booking-id={b.id}>
                <strong>{continuesBefore ? "‹ " : ""}{b.priority !== "normal" && <Zap size={11} />}{groupName(b.groupId)}{continuesAfter ? " ›" : ""}</strong><span>{b.purpose}</span><small>{fullTime(b.startAt)} — {fullTime(b.endAt)}</small>
              </button>;
            })}
          </div>
          {layout.bars.length > 0 && <div className="timeline-caption-list">{layout.bars.map(({ booking: b }) =>
            <button key={b.id} className="timeline-caption" title={`${fullTime(b.startAt)} — ${fullTime(b.endAt)}`} onClick={() => onDetail(r)}>
              <i className={`dot group-${Number(b.groupId.slice(1)) % 5}`} />
              <span>{groupName(b.groupId)} · {b.purpose}</span>
            </button>)}
          </div>}
          </td>
        </tr>)}</tbody>
      </table>
      {!resourceRows.length && <div className="empty"><Server size={28} /><h3>{resources.length ? "没有符合条件的排期资源" : "添加资源后即可查看排期"}</h3></div>}
    </div>
    <div className="schedule-legend">{groups.map(g => <span key={g.id}><i className={`dot group-${Number(g.id.slice(1)) % 5}`} />{g.name}</span>)}</div>
  </section>;
}
