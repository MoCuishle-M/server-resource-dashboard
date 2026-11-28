"use client";

import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import { chinaDate } from "@/lib/domain";
import { canViewNpuLive, liveLocation, liveView, readLiveCards, type CardState, type LiveView } from "@/lib/npu-live";
import { minuteMs, type NpuAnalysis, type NpuDay, type NpuLatest } from "@/lib/npu-usage";
import { resourceStatusLabels } from "@/lib/resource-policy";
import type { PublicState, Resource } from "@/lib/types";
import "./npu-live.css";

const fmt = new Intl.DateTimeFormat("zh-CN", {timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23"});
const slotTime = new Intl.DateTimeFormat("zh-CN", {timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hourCycle: "h23"});
const timestamp = (at: number) => fmt.format(at);
const stateText = {idle: "整机空闲", busy: "有卡占用", uncertain: "状态待确认"};
const locationNumber = (n: number) => String(n).padStart(2, "0");

function CardStrip({cards}: {cards: CardState[]}) {
  const labels = {idle: "空闲", busy: "占用", fault: "故障", unknown: "未知"};
  return <span className="npu-live-cards" role="img"
    aria-label={Object.keys(labels).map(key => {
      const state = key as CardState;
      return `${labels[state]} ${cards.filter(card => card === state).length} 张`;
    }).join("，")}>
    {cards.map((card, i) => <i className={`npu-live-card-${card}`} key={i}/>)}
  </span>;
}

const gapLabels = { missing: "排期内缺样", outside: "无本组排期", pending: "待同步" };

function History({values, mean, gaps, sampledThrough}: Pick<LiveView["machines"][number], "values" | "mean" | "gaps"> & {
  sampledThrough: number;
}) {
  const missing = gaps.filter(gap => gap === "missing").length;
  const outside = gaps.filter(gap => gap === "outside").length;
  const pending = gaps.filter(gap => gap === "pending").length;
  const unit = 240 / values.length, width = Math.min(4.25, unit*.52);
  const bands = ["low", "mid", "high", "peak", "gap"];
  const paths = bands.map(() => "");
  values.forEach((value, i) => {
    if (value === null && gaps[i] !== "missing") return;
    const x = unit*i+(unit-width)/2, height = value === null ? 42 : Math.max(3, value*.42);
    const band = value === null ? 4 : Math.min(3, Math.floor(value/25));
    paths[band] += value === null
      ? `M${(x+width/2).toFixed(2)},2v42`
      : `M${x.toFixed(2)},${(44-height).toFixed(2)}h${width.toFixed(2)}v${height.toFixed(2)}h-${width.toFixed(2)}Z`;
  });
  const description = ["近 1 小时卡占用，从过去到现在", mean !== null ? `平均 ${Math.round(mean)}%` : "",
    missing ? `${missing} 段排期内缺样` : "",
    outside ? `${outside} 段无本组排期` : "",
    pending ? `${pending} 段待同步` : ""].filter(Boolean).join("，");
  return <div className="npu-live-plot">
    <svg viewBox="0 0 240 46" preserveAspectRatio="none" role="img" aria-label={description}>
      <title>{description}</title><path className="npu-live-grid" d="M0 2H240 M0 23H240 M0 44H240"/>
      {paths.map((p,i) => p && <path key={bands[i]} className={`npu-live-${bands[i]}`} d={p}/>)}
      {gaps.map((gap, i) => {
        if (!gap) return null;
        const left = unit * i;
        const center = left + unit / 2;
        const start = sampledThrough - 60 * minuteMs + i * 5 * minuteMs;
        return <g key={i} className={`npu-live-slot-${gap}`}>
          {gap === "outside" && <path d={`M${center - 4},42h8`}/>}
          {gap === "pending" && <circle cx={center} cy="41" r="3"/>}
          <rect x={left} y="0" width={unit} height="46" fill="transparent" stroke="none">
            <title>{slotTime.format(start)}–{slotTime.format(start + 5 * minuteMs)} {gapLabels[gap]}</title>
          </rect>
        </g>;
      })}
    </svg>
    <div><strong>{mean === null ? "—" : `${Math.round(mean)}%`}</strong><small>{mean === null
      ? missing ? "排期内暂无有效采样" : "等待排期内样本"
      : missing ? "平均使用率 · 排期内部分缺样" : "最近平均使用率"}</small></div>
  </div>;
}

function demoResources(state: PublicState) {
  return state.resources.filter(r => r.zone === "blue").slice(0, 4)
    .map((r, i) => ({...r, name: `${r.name} 节点 ${i+1}`}));
}

function demoSamples(state: PublicState, now: number) {
  const primary = state.actor.groupId || state.groups[0]?.id;
  const secondary = state.groups.find(g => g.id !== primary)?.id ?? primary;
  const resources = demoResources(state);
  const bookings = resources.flatMap((r, i) => {
    const groupIds = i === 1 ? [primary, secondary] : [i === 3 ? secondary : primary];
    return [...new Set(groupIds)].filter(Boolean).map((groupId, j) => ({
      id: `npu-demo-${i}-${j}`, requestId: "", resourceId: r.id, groupId, startAt: new Date(now - 4*3600000).toISOString(),
      endAt: new Date(now + (30+i*18+j*20)*minuteMs).toISOString(), purpose: "", priority: "normal" as const,
      status: "scheduled" as const, parentId: "", createdAt: "", updatedAt: "",
    }));
  });
  const days: NpuDay[] = [], latest: NpuLatest[] = [];
  resources.forEach((r,i) => {
    if (i === 2) return;
    const grouped = new Map<string,NpuDay>();
    const latestAt = now-(i===3?12:1)*minuteMs;
    for (let t = Math.floor((now-3600000)/minuteMs)*minuteMs; t<=latestAt; t+=minuteMs) {
      if (i === 1 && t > now-35*minuteMs && t < now-16*minuteMs) continue;
      const day = new Date(t+8*3600000).toISOString().slice(0,10);
      const minute = Math.round((t-Date.parse(day+"T00:00:00+08:00"))/minuteMs);
      const batch = grouped.get(day) ?? {resourceId:r.id,day,expected:8,samples:{}};
      batch.samples[minute] = [8, i === 0 ? 0 : (Math.floor(minute/12)+i*3)%9, 8, 0];
      grouped.set(day,batch);
    }
    days.push(...grouped.values());
    latest.push({resourceId:r.id,expected:8,snapshot:{at:latestAt,cards:Array.from({length:8},(_,j)=>({
      key:`${j}-0`,state:i===1&&j<3?"active":"idle",util:null,hbm:null,
    }))}});
  });
  return {resources, bookings, days, latest};
}

type CachedLiveView = { view: LiveView; receivedAt: number; serverTimeAtReceipt: number };

export default function NpuLiveOverview({state, demo, groupId, onDetail}: {
  state: PublicState; demo: boolean; groupId: string; onDetail: (id: string)=>void;
}) {
  const [results, setResults] = useState(() => new Map<string, CachedLiveView>());
  const [, updateClock] = useState(0);
  const [failure, setFailure] = useState<{group: string; message: string} | null>(null);
  const allowed = canViewNpuLive(state.actor);
  const demoState = demo ? state : null;
  useEffect(()=>{
    if (!allowed || !groupId) return;
    const controller=new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function refresh(){
      try{
        const requestedAt = performance.now();
        let view: LiveView;
        if (demoState) {
          const now = Date.now();
          const {resources, bookings, days, latest} = demoSamples(demoState, now);
          view = liveView({...demoState,resources,bookings}, demoState.actor, groupId, now, 1, days, latest);
        }else{
          const query=new URLSearchParams({group:groupId});
          const response=await fetch(`/api/npu-live?${query}`,{signal:controller.signal,cache:"no-store"});
          const json=await response.json() as LiveView & {error?: string};
          if(!response.ok)throw new Error(typeof json.error==="string"?json.error:"载入机器状态失败");
          if (json.group !== groupId) throw new Error("未收到所选使用组的机器状态");
          view = json;
        }
        if (!controller.signal.aborted) {
          const receivedAt = performance.now();
          // The server timestamps the view during the request. Use the full
          // round trip as an upper bound so a slow reply cannot extend a booking.
          const serverTimeAtReceipt = view.now + receivedAt - requestedAt;
          setResults(previous => new Map(previous).set(groupId, { view, receivedAt, serverTimeAtReceipt }));
          setFailure(null);
        }
      }catch(e){
        if (!controller.signal.aborted) {
          setFailure({group: groupId, message: e instanceof Error ? e.message : "载入机器状态失败"});
        }
      } finally{
        if(!controller.signal.aborted)timer=setTimeout(refresh,30_000);
      }
    }
    void refresh();
    return()=>{controller.abort();clearTimeout(timer);};
  },[allowed, groupId, demoState, state.revision]);
  const cached = allowed ? results.get(groupId) : undefined;
  const cacheAge = cached ? performance.now() - cached.receivedAt : 0;
  const view = cached && cacheAge < minuteMs ? cached.view : null;
  const now = cached ? cached.serverTimeAtReceipt + cacheAge : 0;
  const rows = view?.machines.filter(row => row.until > now) ?? [];
  const nextChange = Math.min(minuteMs - cacheAge, ...rows.map(row => (row.until - now) % minuteMs || minuteMs));
  useEffect(() => {
    if (!view) return;
    const timer = setTimeout(() => updateClock(tick => tick + 1), Math.ceil(nextChange));
    return () => clearTimeout(timer);
  }, [view, nextChange]);
  const error = failure?.group === groupId ? failure.message : "";
  const count = rows.filter(r=>r.status==="idle"&&!r.shared).length;
  const reportCounts = !rows.length || rows.some(r => r.cards.some(card => card !== "unknown"));
  return <section className="panel npu-live-panel" aria-labelledby="npu-live-title">
    <div className="npu-live-header">
      <h2 id="npu-live-title">当前用机</h2>
    </div>
    {!allowed ? <p className="npu-live-prompt">{demo ? "登录后可查看所选使用组的机器状态。" :
      <><a href="/signin-with-chatgpt?return_to=/" target="_top">登录</a>后可查看所选使用组的机器状态。</>}</p> :
    !groupId ? <p className="npu-live-prompt">选择使用组后查看当前用机。</p> : <div>
      {error && <p role="alert">{error}</p>}
      {!error&&!view&&<p className="npu-live-prompt" role="status">正在读取机器状态…</p>}
      {view&&<>
        <dl className="npu-live-summary">
          <div><dt>当前分配</dt><dd>{rows.length}<small>台</small></dd></div>
          <div><dt>可用整机</dt><dd>{reportCounts ? <>{count}<small>台</small></> : "—"}</dd></div>
          <div><dt>空闲卡</dt><dd>{reportCounts ? <>{rows.reduce((n,r)=>n+(r.idle??0),0)}<small>张</small></> : "—"}</dd></div>
          <div><dt>异常卡</dt><dd>{reportCounts ? <>{rows.reduce((n,r)=>n+r.faults,0)}<small>张</small></> : "—"}</dd></div>
        </dl>
        {!rows.length?<p className="npu-live-muted">本组当前没有生效的日常排期。</p>:
          <div className="npu-live-scroll"><table>
            <thead><tr><th scope="col">机器</th><th scope="col">可用状态</th><th scope="col">空闲卡</th><th scope="col">本组可用至</th><th scope="col">近 1 小时卡占用</th><th scope="col">样本时间</th></tr></thead>
            <tbody>{rows.map(r=><tr key={r.id}>
              <th scope="row"><button type="button" className="text-button" onClick={()=>onDetail(r.id)}>{r.ip||"查看机器"}</button>
                <small>柜 {locationNumber(r.rack)} · {r.slot===null?"节点未登记":`节点 ${locationNumber(r.slot)}`}</small></th>
              <td><span className={`npu-live-state npu-live-state-${r.status}`}>{stateText[r.status]}</span>{(r.reason||r.shared)&&<small>{[r.reason,r.shared?"当前共用":""].filter(Boolean).join(" · ")}</small>}</td>
              <td>{r.idle==null?"未知":`${r.idle} / ${r.expected}`}{!!r.cards.length && <CardStrip cards={r.cards}/>}</td>
              <td>{timestamp(r.until)}<small>还有 {Math.ceil((r.until - now) / minuteMs)} 分钟</small></td>
              <td><History values={r.values} mean={r.mean} gaps={r.gaps} sampledThrough={view.now}/></td>
              <td>{r.sampledAt===null?<span className="npu-live-muted">未收到样本</span>:timestamp(r.sampledAt)}</td>
            </tr>)}</tbody>
          </table></div>}
      </>}
    </div>}
  </section>;
}

type FleetSnapshot = NonNullable<NpuAnalysis["machines"][number]["snapshot"]>;

function demoFleetLatest(state: PublicState, now: number) {
  const latest = new Map<string, FleetSnapshot>(demoSamples(state, now).latest.map(row =>
    [row.resourceId, { ...row.snapshot, expected: row.expected }]));
  state.resources.filter(resource => resource.id.startsWith("demo-fleet-")).forEach((resource, i) => {
    if (i % 7 === 5) return;
    const occupied = (i * 5) % 9;
    latest.set(resource.id, {
      expected: 8,
      at: now - (i % 7 === 6 ? 9 : 1) * minuteMs,
      cards: Array.from({length: 8}, (_, card) => ({
        key: `${card}-0`, state: i % 11 === 3 && card === 0 ? "fault" : card < occupied ? "active" : "idle",
        util: null, hbm: null,
      })),
    });
  });
  return latest;
}

function fleetReading(resource: Resource, snapshot: FleetSnapshot | undefined, now: number) {
  const expected = snapshot?.expected ?? 0;
  const reading = readLiveCards(snapshot, expected, now);
  const { cards, fresh, idle, incomplete, faults } = reading;
  const text = !snapshot ? "未收到样本" : !fresh ? "样本已过期" :
    !expected || cards.every(card => card === "unknown") ? "卡状态未知" :
    incomplete ? `空闲 ${idle} / ${expected} · 样本不全` : `空闲 ${idle} 张`;
  const status = resource.status === "available" ? "" : resourceStatusLabels[resource.status];
  return {cards, text, status, fresh, uncertain: !fresh || incomplete, at: snapshot?.at,
    free: resource.status === "available" && reading.status === "idle",
    fault: resource.status === "fault" || faults > 0};
}

export function NpuFleetOverview({state, demo, onDetail}: {
  state: PublicState; demo: boolean; onDetail: (id: string)=>void;
}) {
  const [data, setData] = useState<{now: number; latest: Map<string, FleetSnapshot>} | null>(null);
  const [error, setError] = useState(false);
  const [expandedRack, setExpandedRack] = useState<number | null>(null);
  const allowed = state.actor.role === "admin";
  useEffect(() => {
    if (!allowed) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const now = Date.now();
        if (demo) {
          setData({now, latest: demoFleetLatest(state, now)});
        } else {
          const day = chinaDate(new Date(now));
          const response = await fetch(`/api/npu-usage?start=${day}&end=${day}`, {signal: controller.signal, cache:"no-store"});
          if (!response.ok) throw new Error("无法读取 NPU 状态");
          const analysis: NpuAnalysis = await response.json();
          if (controller.signal.aborted) return;
          setData({now: Date.now(), latest: new Map(analysis.machines.flatMap(({id, snapshot}) => snapshot ? [[id, snapshot]] : []))});
        }
        setError(false);
      } catch {
        if (!controller.signal.aborted) { setData(null); setError(true); }
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(refresh, 30_000);
      }
    }
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [allowed, demo, state]);
  if (!allowed) return null;

  const demoNodes = demo ? new Map(demoResources(state).map(resource => [resource.id, resource])) : null;
  const racks = new Map<number, (Resource & {slot: number | null})[]>();
  for (const original of state.resources) {
    const resource = demoNodes?.get(original.id) ?? original;
    const location = liveLocation(resource, !demo);
    if (!location || resource.deleted || resource.hidden || !resource.ip.trim()) continue;
    const {rack, slot} = location;
    const items = racks.get(rack) ?? [];
    items.push({...resource, slot});
    racks.set(rack, items);
  }
  return <section className="panel npu-fleet-panel" aria-labelledby="npu-fleet-title">
    <div className="section-heading">
      <h2 id="npu-fleet-title">服务器与卡状态</h2>
      {racks.size > 0 && <p className="npu-fleet-total">{racks.size} 柜 · {[...racks.values()].reduce((total, items) => total + items.length, 0)} 台</p>}
    </div>
    <div className="npu-fleet-body">
      {error ? <p role="alert">暂时无法读取卡状态，稍后自动重试。</p>
        : !data ? <p role="status">正在读取卡状态…</p>
        : !racks.size ? <p>暂无监控机柜台账。</p>
        : [...racks].sort(([a], [b]) => a-b).map(([rack, items]) => {
          const expanded = expandedRack === rack;
          const panelId = `npu-fleet-rack-${rack}`;
          const machines = items.map(resource => ({
            resource, ...fleetReading(resource, data.latest.get(resource.id), data.now),
          }));
          const idle = machines.filter(machine => machine.free).length;
          const fault = machines.filter(machine => machine.fault).length;
          const uncertain = machines.filter(machine => machine.uncertain).length;
          return <section className="npu-fleet-rack" key={rack}>
            <h3>
              <button type="button" className="npu-fleet-toggle" aria-expanded={expanded} aria-controls={panelId}
                onClick={() => setExpandedRack(expanded ? null : rack)}>
                <span className="npu-fleet-rack-name"><strong>柜 {locationNumber(rack)}</strong><small>{items.length} 台</small></span>
                <span className="npu-fleet-rack-counts">
                  <span className={idle ? "npu-fleet-count-idle" : undefined}>整机空闲 {idle}</span>
                  <span className={fault ? "npu-fleet-count-alert" : undefined}>故障 {fault}</span>
                  <span className={uncertain ? "npu-fleet-count-alert" : undefined}>待确认 {uncertain}</span>
                </span>
                <ChevronDown size={16} aria-hidden="true"/>
              </button>
            </h3>
            <div id={panelId} className="npu-fleet-rack-detail" hidden={!expanded}>
              {expanded && <>
                <div className="npu-fleet-legend" aria-label="卡状态图例">
                  <span><i className="npu-live-card-idle"/>空闲</span>
                  <span><i className="npu-live-card-busy"/>占用</span>
                  <span><i className="npu-live-card-fault"/>故障</span>
                  <span><i className="npu-live-card-unknown"/>未知</span>
                </div>
                <ul className="npu-fleet-grid">
                  {machines.sort((a,b) => (a.resource.slot ?? Infinity)-(b.resource.slot ?? Infinity)||
                    a.resource.ip.localeCompare(b.resource.ip, undefined, {numeric:true})).map(({resource, cards, text, status, fresh, at}) =>
                    <li className={`npu-fleet-machine${!fresh ? " npu-fleet-machine-unobserved" : ""}`} key={resource.id}>
                      <button type="button" className="text-button" onClick={() => onDetail(resource.id)}>{resource.ip}</button>
                      <span className="npu-fleet-slot">{resource.slot === null ? "节点未登记" : `节点 ${locationNumber(resource.slot)}`}</span>
                      <div className="npu-fleet-card-row">{cards.length ? <CardStrip cards={cards}/> : <span className="npu-fleet-blank-cards"/>}</div>
                      <div className="npu-fleet-reading"><span>{status ? `${status} · ` : ""}{text}</span>
                        {at !== undefined && <time dateTime={new Date(at).toISOString()}>{timestamp(at)}</time>}</div>
                    </li>)}
                </ul>
              </>}
            </div>
          </section>;
        })}
    </div>
  </section>;
}
