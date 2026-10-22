"use client";
import { useId, useState } from "react";
import { Popover } from "radix-ui";
import { ChevronDown, Filter, Search } from "lucide-react";

export default function ResourceTypeFilter({ types, selected, onChange, label: filterLabel = "类型筛选", allLabel = "全部类型", emptyMessage = "暂无服务器类型", portalContainer }: {
  types: string[];
  selected: string[] | null;
  onChange: (types: string[] | null) => void;
  label?: string;
  allLabel?: string;
  emptyMessage?: string;
  portalContainer?: HTMLElement;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState<string[]>([]);
  const titleId = useId();
  const visible = types.filter(type => type.toLowerCase().includes(query.trim().toLowerCase()));
  const allVisible = visible.length > 0 && visible.every(type => draft.includes(type));
  const someVisible = visible.some(type => draft.includes(type));
  const label = selected === null ? allLabel : selected.length === 0
    ? "未选择类型" : selected.length === 1 ? selected[0] : `已选 ${selected.length} 种类型`;
  function toggle(type: string, checked: boolean) {
    setDraft(current => checked ? [...new Set([...current, type])] : current.filter(value => value !== type));
  }
  return <Popover.Root open={open} onOpenChange={next => {
    if (next) {
      setDraft(selected === null ? [...types] : selected.filter(type => types.includes(type)));
      setQuery("");
    }
    setOpen(next);
  }}>
    <Popover.Trigger asChild>
      <button type="button" className={`type-filter-button ${selected !== null ? "is-filtered" : ""}`} aria-label={filterLabel} title={selected?.join("、") ?? allLabel}>
        <Filter size={13} /><span>{label}</span><ChevronDown size={13} />
      </button>
    </Popover.Trigger>
    <Popover.Portal container={portalContainer}>
      <Popover.Content className="type-filter-popup" align="start" sideOffset={7} collisionPadding={12} aria-labelledby={titleId}>
        <header><h3 id={titleId}>{filterLabel}</h3><span>可选择多种类型</span></header>
        <div className="search type-filter-search"><Search size={14} /><input aria-label="搜索类型" placeholder="搜索类型" value={query} onChange={e => setQuery(e.target.value)} /></div>
        <div className="type-filter-actions">
          <label><input type="checkbox" aria-label={query.trim() ? "全选搜索结果" : "全选类型"} disabled={!visible.length} checked={allVisible} ref={node => { if (node) node.indeterminate = someVisible && !allVisible; }} onChange={e => {
            setDraft(current => e.target.checked ? [...new Set([...current, ...visible])] : current.filter(type => !visible.includes(type)));
          }} />{query.trim() ? "全选搜索结果" : "全选"}</label>
          <button type="button" className="text-button" onClick={() => setDraft([])}>清空</button>
        </div>
        <div className="type-filter-options" role="group" aria-label="类型选项">
          {visible.map(type => <label key={type} title={type}>
            <input type="checkbox" value={type} checked={draft.includes(type)} onChange={e => toggle(type, e.target.checked)} /><span>{type}</span>
          </label>)}
          {!visible.length && <p className="type-filter-empty">{types.length ? "没有匹配的类型" : emptyMessage}</p>}
        </div>
        <footer><span>已选 {draft.length} / {types.length} 种</span><div>
          <Popover.Close asChild><button type="button" className="button">取消</button></Popover.Close>
          <button type="button" className="button primary" onClick={() => {
            onChange(types.every(type => draft.includes(type)) ? null : draft.filter(type => types.includes(type)));
            setOpen(false);
          }}>确定</button>
        </div></footer>
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>;
}
