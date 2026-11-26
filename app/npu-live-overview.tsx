"use client";

import { useEffect, useState } from "react";
import { allLiveGroups, canViewNpuLive, liveGroups, liveView, type LiveView } from "@/lib/npu-live";
import { minuteMs, type NpuDay, type NpuLatest } from "@/lib/npu-usage";
import type { PublicState } from "@/lib/types";
import "./npu-live.css";

const fmt = new Intl.DateTimeFormat("zh-CN", {timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23"});
const timestamp = (at: number) => fmt.format(at);
const stateText = {idle: "整机空闲", busy: "有卡占用", uncertain: "状态待确认"};

function History({values, mean}: {values: (number|null)[]; mean: number|null}) {
  if (mean == null) return <span className="npu-live-muted">暂无观测</span>;
  const unit = 240 / values.length, width = Math.min(4.25, unit*.52);
  const bands = ["low", "mid", "high", "peak", "gap"];
  const paths = bands.map(() => "");
  values.forEach((value, i) => {
    const x = unit*i+(unit-width)/2, height = value === null ? 42 : Math.max(2, value*.42);
    const band = value === null ? 4 : Math.min(3, Math.floor(value/25));
    paths[band] += `M${x.toFixed(2)},${(44-height).toFixed(2)}h${width.toFixed(2)}v${height.toFixed(2)}h-${width.toFixed(2)}Z`;
  });
  const description = `近 1 小时卡占用，平均 ${Math.round(mean)}%，从过去到现在`;
  return <div className="npu-live-plot">
    <svg viewBox="0 0 240 46" preserveAspectRatio="none" role="img" aria-label={description}>
      <title>{description}</title><path className="npu-live-grid" d="M0 2H240 M0 23H240 M0 44H240"/>
      {paths.map((p,i) => p && <path key={bands[i]} className={`npu-live-${bands[i]}`} d={p}/>)}
    </svg>
    <div><strong>{Math.round(mean)}%</strong><small>最近平均使用率</small></div>
  </div>;
}

function demoView(state: PublicState, group: string, now: number) {
  const primary = state.actor.groupId || state.groups[0]?.id;
  const secondary = state.groups.find(g => g.id !== primary)?.id ?? primary;
  const resources = state.resources.filter(r => r.zone === "blue").slice(0, 4)
    .map((r, i) => ({...r, name: `${r.name} 节点 ${i+1}`}));
  const bookings = resources.flatMap((r, i) => {
    const groupIds = i === 1 ? [primary, secondary] : [i === 0 ? primary : secondary];
    return [...new Set(groupIds)].filter(Boolean).map((groupId, j) => ({
      id: `npu-demo-${i}-${j}`, requestId: "", resourceId: r.id, groupId, startAt: new Date(now - 4*3600000).toISOString(),
      endAt: new Date(now + (30+i*18+j*20)*minuteMs).toISOString(), purpose: "", priority: "normal" as const,
      status: "scheduled" as const, parentId: "", createdAt: "", updatedAt: "",
    }));
  });
  const days: NpuDay[] = [], latest: NpuLatest[] = [];
  resources.forEach((r,i) => {
    const grouped = new Map<string,NpuDay>();
    const latestAt = now-(i===2?12:1)*minuteMs;
    for (let t = Math.floor((now-3600000)/minuteMs)*minuteMs; t<=latestAt; t+=minuteMs) {
      const day = new Date(t+8*3600000).toISOString().slice(0,10);
      const minute = Math.round((t-Date.parse(day+"T00:00:00+08:00"))/minuteMs);
      const batch = grouped.get(day) ?? {resourceId:r.id,day,expected:8,samples:{}};
      batch.samples[minute] = [8, (Math.floor(minute/12)+i*3)%9, 8, 0];
      grouped.set(day,batch);
    }
    days.push(...grouped.values());
    latest.push({resourceId:r.id,expected:8,snapshot:{at:latestAt,cards:Array.from({length:8},(_,j)=>({
      key:`${j}-0`,state:i===1&&j<3?"active":"idle",util:null,hbm:null,
    }))}});
  });
  return liveView({...state,resources,bookings}, state.actor, group, now, 1, days, latest);
}

export default function NpuLiveOverview({state, demo, onDetail}: {
  state: PublicState; demo: boolean; onDetail: (id: string)=>void;
}) {
  const [group,setGroup] = useState(allLiveGroups);
  const [result,setResult] = useState<LiveView|null>(null),[error,setError] = useState("");
  const allowed = canViewNpuLive(state.actor);
  const admin = state.actor.role === "admin";
  const selectedGroup = admin ? group : state.actor.groupId;
  useEffect(()=>{
    if(!allowed)return;
    const controller=new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function refresh(){
      try{
        if(demo) setResult(demoView(state, selectedGroup, Date.now()));
        else{
          const query=new URLSearchParams({group:selectedGroup});
          const response=await fetch(`/api/npu-live?${query}`,{signal:controller.signal,cache:"no-store"});
          const json=await response.json() as LiveView & {error?: string};
          if(!response.ok)throw new Error(typeof json.error==="string"?json.error:"载入机器状态失败");
          if(!controller.signal.aborted)setResult(json);
        }
        if(!controller.signal.aborted)setError("");
      }catch(e){
        if(!controller.signal.aborted){setResult(null);setError(e instanceof Error?e.message:"载入机器状态失败");}
      } finally{
        if(!controller.signal.aborted)timer=setTimeout(refresh,30_000);
      }
    }
    void refresh();
    return()=>{controller.abort();clearTimeout(timer);};
  },[allowed,selectedGroup,demo,state]);
  if(!allowed)return null;
  const groups = liveGroups(state, state.actor);
  const view = result?.group === selectedGroup ? result : null;
  const overall = admin && selectedGroup === allLiveGroups;
  const rows = view?.machines ?? [];
  const count = rows.filter(r=>r.status==="idle"&&!r.shared).length;
  return <section className="panel npu-live-panel" aria-labelledby="npu-live-title">
    <div className="npu-live-header">
      <h2 id="npu-live-title">当前用机</h2>
      {admin && <label>分组<select value={group} onChange={e=>{setResult(null);setError("");setGroup(e.target.value);}}>
        <option value={allLiveGroups}>全部分组</option>
        {groups.map(g=><option key={g.id} value={g.id}>{g.name}</option>)}
      </select></label>}
    </div>
    <div>
      {error && <p role="alert">{error}</p>}
      {!error&&!view&&<p role="status">正在读取机器状态…</p>}
      {view&&<>
        <dl className="npu-live-summary">
          <div><dt>当前分配</dt><dd>{rows.length}<small>台</small></dd></div>
          <div><dt>可用整机</dt><dd>{count}<small>台</small></dd></div>
          <div><dt>空闲卡</dt><dd>{rows.reduce((n,r)=>n+(r.idle??0),0)}<small>张</small></dd></div>
          <div><dt>异常卡</dt><dd>{rows.reduce((n,r)=>n+r.faults,0)}<small>张</small></dd></div>
        </dl>
        {!rows.length?<p className="npu-live-muted">{overall?"当前没有生效的日常排期。":"本组当前没有生效的日常排期。"}</p>:
          <div className="npu-live-scroll"><table>
            <thead><tr><th scope="col">机器</th>{overall&&<th scope="col">当前使用组</th>}<th scope="col">可用状态</th><th scope="col">空闲卡</th><th scope="col">{overall?"最早排期结束":"本组可用至"}</th><th scope="col">近 1 小时卡占用</th><th scope="col">样本时间</th></tr></thead>
            <tbody>{rows.map(r=><tr key={r.id}>
              <th scope="row"><button type="button" className="text-button" onClick={()=>onDetail(r.id)}>{r.ip||"查看机器"}</button>
                <small>柜 {String(r.rack).padStart(2,"0")} · {r.slot===null?"节点未登记":`节点 ${String(r.slot).padStart(2,"0")}`}</small></th>
              {overall&&<td>{r.groupNames.map(name=><div key={name}>{name}</div>)}</td>}
              <td><span className={`npu-live-state npu-live-state-${r.status}`}>{stateText[r.status]}</span>{(r.reason||r.shared)&&<small>{[r.reason,r.shared?"当前共用":""].filter(Boolean).join(" · ")}</small>}</td>
              <td>{r.idle==null?"未知":`${r.idle} / ${r.expected}`}{!!r.cards.length && <span className="npu-live-cards" aria-hidden="true">{r.cards.map((c,i)=><i className={`npu-live-card-${c}`} key={i}/>)}</span>}</td>
              <td>{timestamp(r.until)}<small>还有 {Math.max(1,Math.ceil((r.until-view.now)/minuteMs))} 分钟</small></td>
              <td><History values={r.values} mean={r.mean}/></td>
              <td>{r.sampledAt===null?"—":timestamp(r.sampledAt)}</td>
            </tr>)}</tbody>
          </table></div>}
      </>}
    </div>
  </section>;
}
