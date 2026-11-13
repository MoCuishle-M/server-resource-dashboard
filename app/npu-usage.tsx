"use client";

import { useEffect, useRef, useState, type PointerEvent } from "react";
import { chinaDate } from "@/lib/domain";
import { analyzeUsage, dayMs, minuteMs, usageRange, type MinuteSample, type NpuAnalysis, type NpuDay } from "@/lib/npu-usage";
import { shiftDate } from "@/lib/schedule";
import type { Booking, State } from "@/lib/types";
import "./npu-usage.css";

type Metric = "occupied" | "compute";
type Cell = NpuAnalysis["fleet"];
const percent = (value: number | null) => value === null ? "—" : `${value.toFixed(1)}%`;
const hours = (minutes: number) => (minutes / 60).toFixed(1);
const valueOf = (item: Cell, metric: Metric) => metric === "occupied"
  ? item.observed ? 100 * item.occupied / item.observed : null
  : item.computeCount ? item.computeSum / item.computeCount : null;
const coverage = (item: Cell, metric: Metric) => item.expected
  ? 100 * (metric === "occupied" ? item.observed : item.computeCount) / item.expected : null;
const formatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
const time = (at: number) => formatter.format(at);
const states: Record<string, string> = {
  idle: "空闲", active: "计算中", occupied_low: "占用 · 低计算", occupied_unknown: "占用 · 指标缺失",
  fault: "故障", smi_fail: "采集异常", missing: "缺卡", no_data: "缺测",
};

function demoAnalysis(state: State, start: string, end: string, groupId: string, resourceId: string) {
  const range = usageRange(start, end, Date.now());
  const hosts = state.resources.slice(0, 3);
  const groups = state.groups.slice(0, 3);
  const bookings: Booking[] = [];
  const days: NpuDay[] = [];
  const latest = hosts.map((resource, host) => ({
    resourceId: resource.id, expected: 8, snapshot: {
      at: Date.now(), cards: Array.from({ length: 8 }, (_, i) => ({
        key: `${i}-0`, state: i < 3 + host ? "active" : "idle",
        util: i < 3 + host ? 48 + host * 12 : 0, hbm: i < 3 + host ? 68 : 0,
      })),
    },
  }));
  for (let day = start, dayStart = range.start; dayStart < range.end; day = shiftDate(day, 1), dayStart += dayMs) {
    hosts.forEach((resource, host) => {
      const samples: Record<string, MinuteSample> = {};
      for (let minute = 0; minute < 1440 && dayStart + minute * minuteMs < range.end; minute++) {
        if (host === 2 && minute >= 660 && minute < 720) continue;
        const used = (Math.floor(minute / 90) + host * 2) % 9;
        samples[minute] = [8, used, 8, used * (44 + host * 12)];
      }
      days.push({ resourceId: resource.id, day, expected: 8, samples });
      const assign = (i: number, from: number, to: number) => {
        if (!groups[i]) return;
        bookings.push({
          id: `${day}-${host}-${i}`, resourceId: resource.id, groupId: groups[i].id, requestId: "demo",
          startAt: new Date(dayStart + from * 3600000).toISOString(),
          endAt: new Date(dayStart + to * 3600000).toISOString(),
          purpose: "演示排期", priority: "normal", status: "scheduled", parentId: "",
          createdAt: new Date(dayStart).toISOString(), updatedAt: new Date(dayStart).toISOString(),
        });
      };
      assign(host, 8, 18);
      if (host === 0) assign(1, 10, 14);
    });
  }
  return analyzeUsage({ resources: hosts, groups, bookings }, days, latest, range, groupId, resourceId);
}

function Ranking({ rows, metric, descending, groups = false, selected, onSelect }: {
  rows: (Cell & { id: string; name: string })[];
  metric: Metric;
  descending: boolean;
  groups?: boolean;
  selected: string;
  onSelect: (id: string) => void;
}) {
  const ranked = (item: Cell) => (coverage(item, metric) ?? 0) >= 80 && valueOf(item, metric) !== null;
  const sorted = [...rows].filter(row => !groups || row.expected > 0).sort((a, b) =>
    Number(ranked(b)) - Number(ranked(a)) ||
    ((valueOf(a, metric) ?? 0) - (valueOf(b, metric) ?? 0)) * (descending ? -1 : 1) ||
    a.name.localeCompare(b.name, "zh-CN"));
  if (!sorted.length) return <p className="npu-empty">该时段暂无{groups ? "有效排期" : "已同步的机器"}。</p>;
  return <div className="npu-table-wrap"><table className="npu-table">
    <thead><tr><th>名次</th><th>{groups ? "组别" : "服务器"}</th><th>卡占用率</th><th>计算利用率</th>
      <th>覆盖率</th><th>{groups ? "排期卡时" : "观测卡时"}</th>
      {groups && <><th>共用卡时</th><th>共用卡占用率</th></>}</tr></thead>
    <tbody>{sorted.map((row, index) => <tr key={row.id} className={selected === row.id ? "npu-selected" : undefined}>
      <td>{ranked(row) ? index + 1 : "—"}</td>
      <th scope="row"><button className="text-button" onClick={() => onSelect(row.id)}>{row.name}</button></th>
      <td>{percent(valueOf(row, "occupied"))}</td><td>{percent(valueOf(row, "compute"))}</td>
      <td>{percent(coverage(row, metric))}</td><td>{hours(groups ? row.expected : row.observed)}</td>
      {groups && <><td>{hours(row.shared)}</td>
        <td>{percent(row.sharedObserved ? 100 * row.sharedOccupied / row.sharedObserved : null)}</td></>}
    </tr>)}</tbody>
  </table></div>;
}

const trendLines = [
  { key: "compute", label: "计算利用率", color: "#16856b" },
  { key: "occupied", label: "卡占用率", color: "#c77a27" },
] as const;

function UsageTrend({ data, values }: { data: NpuAnalysis; values: Cell[] }) {
  const plot = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(700);
  const [active, setActive] = useState<number | null>(null);
  const [visible, setVisible] = useState({ compute: true, occupied: true });
  useEffect(() => {
    if (!plot.current) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(240, Math.floor(entry.contentRect.width))));
    observer.observe(plot.current);
    return () => observer.disconnect();
  }, []);

  const height = 240, left = 43, right = width - 14, top = 12, bottom = height - 32;
  const step = (right - left) / Math.max(1, values.length);
  const x = (i: number) => left + (i + 0.5) * step;
  const y = (value: number) => bottom - value / 100 * (bottom - top);
  const ticks = Math.min(values.length, Math.max(2, Math.floor((right - left) / 100)));
  const tickIndices = Array.from({ length: ticks }, (_, i) => Math.round(i * (values.length - 1) / Math.max(1, ticks - 1)));
  const selected = active === null ? undefined : values[active];
  const hasSamples = values.some(cell => cell.observed > 0);
  function inspect(event: PointerEvent<SVGSVGElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    const index = Math.floor(((event.clientX - bounds.left) * width / bounds.width - left) / step);
    setActive(index >= 0 && index < values.length ? index : null);
  }
  return <>
    <div className="npu-trend-controls">
      {trendLines.map(line => <label key={line.key} style={{ color: line.color }}>
        <input type="checkbox" checked={visible[line.key]}
          onChange={event => setVisible(previous => ({ ...previous, [line.key]: event.target.checked }))} />
        {line.label}
      </label>)}
      {values.some(cell => cell.shared > 0) && <span className="npu-trend-shared-key">含共用时段</span>}
    </div>
    <p className="npu-legend">每点 {data.bucketMinutes} 分钟 · 缺测及排期外保留断点</p>
    <div ref={plot} className="npu-trend-plot">
      {hasSamples ? <svg viewBox={`0 0 ${width} ${height}`} role="img" tabIndex={0}
        aria-label="计算利用率与卡占用率折线图，使用左右方向键查看数据点"
        onPointerMove={inspect} onPointerDown={inspect}
        onPointerLeave={() => setActive(null)}
        onKeyDown={event => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          const delta = event.key === "ArrowLeft" ? -1 : 1;
          setActive(previous => Math.max(0, Math.min(values.length - 1, previous === null ? 0 : previous + delta)));
        }}>
        {values.map((cell, i) => cell.shared > 0 && <rect key={i} className="npu-trend-shared"
          x={left + i * step} y={top} width={step} height={bottom - top} />)}
        {[0, 25, 50, 75, 100].map(mark => <g key={mark}>
          <line x1={left} x2={right} y1={y(mark)} y2={y(mark)} stroke="#e2eaee" />
          <text x={left - 7} y={y(mark) + 4} textAnchor="end">{mark}%</text>
        </g>)}
        {tickIndices.map((i, index) => <text key={i}
          x={index === 0 ? left : index === tickIndices.length - 1 ? right : x(i)} y={height - 10}
          textAnchor={index === 0 ? "start" : index === tickIndices.length - 1 ? "end" : "middle"}>{time(data.buckets[i])}</text>)}
        {trendLines.filter(line => visible[line.key]).map(line => {
          const points = values.map(cell => valueOf(cell, line.key));
          const path = points.map((value, i) => value === null ? "" :
            `${i === 0 || points[i - 1] === null ? "M" : "L"}${x(i)},${y(value)}`).join(" ");
          return <g key={line.key}>
            <path className={`npu-trend-line npu-trend-${line.key}`} d={path} fill="none" stroke={line.color} strokeWidth={2} />
            {points.map((value, i) => value !== null && (points[i - 1] ?? null) === null &&
              (points[i + 1] ?? null) === null && <circle key={i} cx={x(i)} cy={y(value)} r={2.5} fill={line.color} />)}
          </g>;
        })}
        {selected && active !== null && <line x1={x(active)} x2={x(active)} y1={top} y2={bottom}
          stroke="#526a7c" strokeDasharray="4 4" />}
        <rect x={left} y={top} width={right - left} height={bottom - top} fill="transparent" />
      </svg> : <p className="npu-empty">该范围内暂无有效观测。</p>}
    </div>
    {selected && active !== null && <p className="npu-trend-detail">
      {time(data.buckets[active])} · {selected.expected === 0 ? "排期外" : selected.observed === 0 ? "缺测" :
        `计算 ${percent(valueOf(selected, "compute"))} · 占用 ${percent(valueOf(selected, "occupied"))}`}
      {selected.shared > 0 && " · 含共用时段"}
    </p>}
  </>;
}

export default function NpuUsage({ state, demo }: { state: State; demo: boolean }) {
  const today = chinaDate();
  const [start, setStart] = useState(shiftDate(today, -1));
  const [end, setEnd] = useState(today);
  const [metric, setMetric] = useState<Metric>("occupied");
  const [descending, setDescending] = useState(true);
  const [group, setGroup] = useState("");
  const [groupMachine, setGroupMachine] = useState("");
  const [machine, setMachine] = useState("");
  const [data, setData] = useState<NpuAnalysis | null>(null);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const exampleState = demo ? state : null;

  useEffect(() => {
    const controller = new AbortController();
    setError("");
    setData(null);
    async function load() {
      try {
        if (exampleState) {
          setData(demoAnalysis(exampleState, start, end, group, machine));
          return;
        }
        const query = new URLSearchParams({ start, end, group, machine });
        const response = await fetch(`/api/npu-usage?${query}`, { signal: controller.signal });
        const result = await response.json() as NpuAnalysis & { error?: string };
        if (!response.ok) throw new Error(result.error ?? "读取使用分析失败");
        if (!controller.signal.aborted) setData(result);
      } catch (failure) {
        if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "读取使用分析失败");
      }
    }
    void load();
    return () => controller.abort();
  }, [exampleState, start, end, group, machine, refresh]);

  const selected = data?.machines.find(row => row.id === machine);
  const selectedGroupMachine = data?.groupHeatmap.find(row => row.id === groupMachine);
  return <div className="npu-usage">
    <div className="npu-filters">
      <label>开始日期<input type="date" value={start} onChange={e => setStart(e.target.value)} /></label>
      <label>结束日期<input type="date" value={end} onChange={e => setEnd(e.target.value)} /></label>
      <label>排行指标<select value={metric} onChange={e => setMetric(e.target.value as Metric)}>
        <option value="occupied">卡占用率</option><option value="compute">计算利用率</option>
      </select></label>
      <label>排序<select value={descending ? "desc" : "asc"} onChange={e => setDescending(e.target.value === "desc")}>
        <option value="desc">从高到低</option><option value="asc">从低到高</option>
      </select></label>
      <button className="button" onClick={() => setRefresh(value => value + 1)}>刷新数据</button>
    </div>
    {error && <p role="alert" className="npu-empty">{error}</p>}
    {!error && !data && <p className="npu-empty" role="status">正在计算使用率…</p>}
    {data && <>
      <div className="npu-kpis">
        <div><span>已接入服务器</span><strong>{data.machines.length}</strong></div>
        <div><span>集群卡占用率</span><strong>{percent(valueOf(data.fleet, "occupied"))}</strong></div>
        <div><span>集群计算利用率</span><strong>{percent(valueOf(data.fleet, "compute"))}</strong></div>
        <div><span>采样覆盖率</span><strong>{percent(coverage(data.fleet, metric))}</strong></div>
      </div>
      <p className="npu-legend">北京时间 · 最多选择 7 天 · 覆盖率达到 80% 参与所选指标排名</p>
      <section className="npu-panel">
        <h2>机器排行</h2>
        <Ranking rows={data.machines} metric={metric} descending={descending} selected={machine} onSelect={setMachine} />
        {selected && <div className="npu-detail">
          <h3>{selected.name} · 选定时段</h3>
          <UsageTrend key={selected.id} data={data} values={data.machineTrend} />
          <h3>最新卡状态 · {time(selected.snapshot.at)}</h3>
          <div className="npu-cards">{selected.snapshot.cards.map(card => <div key={card.key}>
            <strong>卡 {card.key}</strong><span>{states[card.state] ?? card.state}</span>
            <small>计算 {percent(card.util)} · HBM {percent(card.hbm)}</small>
          </div>)}</div>
        </div>}
      </section>
      <section className="npu-panel">
        <h2>组排行</h2>
        <p className="npu-legend">组内按有效观测卡时加权。共用时段的整机观测计入每个参与组，并在明细中标记。</p>
        <Ranking rows={data.groups} metric={metric} descending={descending} groups selected={group} onSelect={id => {
          setGroup(id);
          setGroupMachine("");
        }} />
        {group && <div className="npu-detail">
          <h3>{data.groups.find(row => row.id === group)?.name} · 有效排期使用率</h3>
          <div className="npu-filters"><label>组内服务器<select value={selectedGroupMachine?.id ?? ""} onChange={e => setGroupMachine(e.target.value)}>
            <option value="">组内汇总</option>
            {data.groupHeatmap.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}
          </select></label></div>
          <UsageTrend key={group} data={data} values={selectedGroupMachine?.values ?? data.groupTrend} />
        </div>}
      </section>
    </>}
  </div>;
}
