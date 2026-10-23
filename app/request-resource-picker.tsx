"use client";
import { useEffect, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import type { Booking, Priority, Resource } from "@/lib/types";
import { requestPriorityPreview } from "@/lib/priority";
import { resourceSearch } from "@/lib/resource-search";
import { resourceSharingMode } from "@/lib/domain";
import ResourceTypeFilter from "./resource-type-filter";

export default function RequestResourcePicker({ resources, selected, used, onChange, bookings = [], range, priority = "normal" }: {
  resources: Resource[]; selected: string[]; used: Set<string>; onChange: (ids: string[]) => void;
  bookings?: Booking[]; range?: { startAt: string; endAt: string }; priority?: Priority;
}) {
  const [query, setQuery] = useState("");
  const [onlySelected, setOnlySelected] = useState(false);
  const [types, setTypes] = useState<string[] | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const [portalContainer, setPortalContainer] = useState<HTMLElement>();
  useEffect(() => { setPortalContainer(root.current?.closest("dialog") ?? undefined); }, []);
  const available = resources.filter(r => r.status === "available" && !r.deleted);
  const matches = resourceSearch(query);
  const visible = available.filter(r => matches(r) && (types === null || types.includes(r.type)) && (!onlySelected || selected.includes(r.id)));
  function remove(id: string) { onChange(selected.filter(value => value !== id)); }
  return <div className="request-picker-panel" ref={root}>
    <section className="request-selected" aria-label="已选服务器">
      <header><strong>已选服务器 <span aria-live="polite">{selected.length} 台</span></strong>
        <button type="button" className="text-button" disabled={!selected.length} onClick={() => onChange([])}>清空已选</button></header>
      <div className="request-selected-list">
        {selected.map(id => {
          const r = resources.find(resource => resource.id === id);
          return <div key={id} className={r?.status === "available" && !r.deleted ? "" : "selection-unavailable"}>
            <span><strong>{r?.name ?? "资源已不可见"}</strong><small className="mono">{r?.ip ?? "请移除此项"}{r && (r.status !== "available" || r.deleted) ? " · 当前不可申请" : ""}</small></span>
            <button type="button" className="icon-button" aria-label={`移除已选 ${r?.name ?? "不可用资源"}`} onClick={() => remove(id)}><X size={14} /></button>
          </div>;
        })}
        {!selected.length && <p className="muted">尚未选择服务器，在下方勾选后会显示在这里。</p>}
      </div>
    </section>
    <div className="request-picker-controls">
      <div className="search"><Search size={15} /><textarea aria-label="搜索可申请服务器" placeholder="搜索名称、IP、类型；多个IP用空格、逗号或换行分隔" rows={2} value={query} onChange={e => setQuery(e.target.value)} /></div>
      <ResourceTypeFilter types={[...new Set(available.map(r => r.type))]} selected={types} onChange={setTypes} label="申请服务器类型筛选" portalContainer={portalContainer} />
      <label className="checkbox-label"><input type="checkbox" checked={onlySelected} onChange={e => setOnlySelected(e.target.checked)} />只看已选</label>
    </div>
    <div className="field"><span>选择服务器 * · 当前显示 {visible.length} 台</span>
      <div className="resource-picker" aria-label="可选服务器列表">
        {visible.map(r => { const preview = range ? requestPriorityPreview(r, bookings, range, priority) : null; return <label key={r.id} className={selected.includes(r.id) ? "chosen" : ""}>
          <input type="checkbox" checked={selected.includes(r.id)} onChange={e => e.target.checked ? onChange([...new Set([...selected, r.id])]) : remove(r.id)} />
          <span><strong>{r.name}</strong><small className="mono">{r.ip}</small><small>{r.type} · {r.accessMode === "bare" ? "裸机" : "灵枢平台"} · {resourceSharingMode(r) === "shared" ? "共享" : "独占"}</small></span>
          <span className={`badge ${preview ? preview.blocking.length || preview.affected.length ? "orange" : "green" : used.has(r.id) ? "orange" : "green"}`}>{preview?.label ?? (used.has(r.id) ? "使用中" : "空闲")}</span>
        </label>; })}
        {!visible.length && <p className="muted padded">{available.length ? "没有符合条件的服务器" : "暂无可申请服务器"}</p>}
      </div>
    </div>
    <p className="text-small muted">状态依据所选时间与优先级计算。共享资源同级共用，低优保留排期；独占资源同级重叠不能批准。</p>
  </div>;
}
