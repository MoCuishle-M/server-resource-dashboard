"use client";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { Action, PublicState, WeeklyPlan, WeeklySectionName, WeeklyServerRow, WorkspaceAllocation } from "@/lib/types";
import { demandAssigned, linkDayRows, resourceUnavailable, sectionIssues, workspaceCapacity, workspaceConfigured } from "@/lib/weekly-workspace";

type Props = { state: PublicState; busy: boolean; onAction: (a: Action, message?: string) => Promise<boolean>; onDirty: (dirty: boolean) => void; planId?: string; section?: WeeklySectionName; onSelect: (id: string, part: WeeklySectionName) => void; onBack: (id: string, part: WeeklySectionName) => void };
const groupName = (s: PublicState, id: string) => s.groups.find(g => g.id === id)?.name ?? id;
type Choice = { id: string; label: string; description?: string; disabled?: boolean };

/** A cell editor is portaled out of the sheet so it never clips inside a row. */
function ChoiceCell({ label, value, choices, multiple, disabled, onChange, placeholder = "点击选择" }: { label: string; value: string[]; choices: Choice[]; multiple?: boolean; disabled?: boolean; onChange: (ids: string[]) => void; placeholder?: string }) {
  const button = useRef<HTMLButtonElement>(null), popup = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number; maxHeight: number }>(), [search, setSearch] = useState("");
  function close() { setPosition(undefined); button.current?.focus(); }
  useEffect(() => {
    if (!position) return;
    const outside = (e: PointerEvent) => { if (!popup.current?.contains(e.target as Node) && !button.current?.contains(e.target as Node)) setPosition(undefined); };
    const escape = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); close(); } };
    const dismiss = () => setPosition(undefined);
    document.addEventListener("pointerdown", outside); document.addEventListener("keydown", escape); window.addEventListener("resize", dismiss);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); window.removeEventListener("resize", dismiss); };
  }, [position]);
  const text = choices.filter(x => value.includes(x.id)).map(x => x.label).join("、") || placeholder;
  return <><button ref={button} type="button" className="sheet-choice-cell" aria-label={label} aria-expanded={!!position} disabled={disabled} onClick={() => { if (position) { close(); return; } const rect = button.current!.getBoundingClientRect(); const height = Math.min(370, innerHeight - 24), below = innerHeight - rect.bottom - 12; setSearch(""); setPosition({ top: below >= Math.min(height, 220) ? rect.bottom + 4 : Math.max(12, rect.top - height - 4), left: Math.max(12, Math.min(rect.left, innerWidth - 302)), maxHeight: below >= 220 ? Math.min(height, below) : height }); }}><span>{text}</span>{!disabled && <span aria-hidden>⌄</span>}</button>
    {position && createPortal(<div ref={popup} role="dialog" aria-label={`${label}选项`} className="sheet-cell-popover" style={position}>
      <input autoFocus aria-label="搜索选项" placeholder="搜索组名或事项" value={search} onChange={e => setSearch(e.target.value)} />
      <div className="sheet-choice-options">{choices.filter(x => `${x.label} ${x.description ?? ""}`.toLowerCase().includes(search.toLowerCase())).map(x => <label key={x.id} className="sheet-choice-option"><input type={multiple ? "checkbox" : "radio"} name={label} checked={value.includes(x.id)} disabled={x.disabled} onChange={() => { onChange(multiple ? value.includes(x.id) ? value.filter(id => id !== x.id) : [...value, x.id] : [x.id]); if (!multiple) close(); }} /><span>{x.label}{x.description && <small>{x.description}</small>}</span></label>)}</div>
      <div className="sheet-popover-footer"><button type="button" className="text-button" onClick={() => { onChange([]); if (!multiple) close(); }}>清空选择</button><button type="button" className="button primary" onClick={close}>完成</button></div>
    </div>, document.body)}
  </>;
}
function CellText({ label, value, disabled, maxLength, onChange }: { label: string; value: string; disabled?: boolean; maxLength: number; onChange: (text: string) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current; if (!el) return;
    const fit = () => { el.style.height = "auto"; el.style.height = `${Math.max(35, el.scrollHeight + 2)}px`; };
    fit(); const observer = new ResizeObserver(fit); observer.observe(el); return () => observer.disconnect();
  }, [value]);
  return <textarea ref={ref} aria-label={label} value={value} rows={1} maxLength={maxLength} readOnly={disabled} onChange={e => onChange(e.target.value)} className="sheet-text-cell" placeholder="点击填写" />;
}
function useSheet<T>(value: T, onDirty: Props["onDirty"]) {
  const [edit, setEdit] = useState<{ before: T; value: T }>();
  const dirty = !!edit && JSON.stringify(edit.before) !== JSON.stringify(edit.value), stale = !!edit && JSON.stringify(edit.before) !== JSON.stringify(value);
  useEffect(() => { onDirty(dirty); return () => onDirty(false); }, [dirty, onDirty]);
  useEffect(() => { const warn = (e: BeforeUnloadEvent) => { if (dirty) { e.preventDefault(); e.returnValue = ""; } }; window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn); }, [dirty]);
  return { value: edit?.value ?? value, before: edit?.before ?? value, dirty, stale, change: (next: T) => setEdit(old => ({ before: old?.before ?? structuredClone(value), value: next })), reset: () => setEdit(undefined) };
}
function SaveBar({ dirty, stale, busy, save, reset, children }: { dirty: boolean; stale: boolean; busy: boolean; save: () => void; reset: () => void; children?: ReactNode }) {
  return <div className="allocation-savebar"><div><strong>{stale ? "服务器上的分配已更新，当前输入已保留" : dirty ? "有未保存的表格修改" : "表格已同步"}</strong><small>{stale ? "请先核对最新数据，避免覆盖其他人的修改。" : "点击单元格编辑，支持 Tab 切换、Ctrl+S 保存。"}</small></div><div className="weekly-actions">{children}<button type="button" className="button" disabled={!dirty || busy} onClick={() => { if (window.confirm("放弃本地输入并载入最新分配？")) reset(); }}>放弃修改</button><button type="submit" className="button primary" disabled={!dirty || stale || busy} onClick={e => { e.preventDefault(); save(); }}>保存分配</button></div></div>;
}

export default function WeeklyAllocationPage(props: Props) {
  const { state: s, planId, section = "day", onSelect, onBack } = props;
  const plans = s.weeklyPlans.filter(p => p.v2).sort((a, b) => b.weekStart.localeCompare(a.weekStart)), p = plans.find(p => p.id === planId) ?? plans[0];
  const [dirty, setDirty] = useState(false);
  useEffect(() => { props.onDirty(dirty); return () => props.onDirty(false); }, [dirty, props.onDirty]);
  const change = (id: string, part: WeeklySectionName) => { if (dirty && !window.confirm("切换将放弃未保存的分配，是否继续？")) return; setDirty(false); onSelect(id, part); };
  return <div className="weekly-workspace allocation-page"><section className="panel allocation-page-heading"><div><h2>A5 服务器分配表</h2><p>一台服务器一行，直接修改使用组、用途与特殊用途。</p></div><div className="weekly-actions">{p && <><select aria-label="分配表排期周" value={p.id} onChange={e => change(e.target.value, section)}>{plans.map(p => <option value={p.id} key={p.id}>{p.weekStart} 周</option>)}</select><select aria-label="分配流程" value={section} onChange={e => change(p.id, e.target.value as WeeklySectionName)}><option value="day">白天周分配</option><option value="multi">多机时段分配</option></select><button className="button" onClick={() => onBack(p.id, section)}>返回流程 · 确认发布</button></>}</div></section>
    {!p ? <section className="panel weekly-checks"><h3>暂无 A5 双流程周计划</h3><p>先在“每周需求与排期”创建计划并制定规则。</p></section> : !workspaceConfigured(p) ? <section className="panel weekly-checks"><h3>请先完成参与范围与规则</h3><p>管理员完成第一步后，接口人才可以提交需求，随后再进行服务器分配。</p><button className="button primary" onClick={() => onBack(p.id, section)}>返回第一步</button></section> : section === "day" ? <DaySheet key={`${p.id}/${s.actor.role}`} {...props} plan={p} onDirty={setDirty} /> : <MultiSheet key={`${p.id}/${s.actor.role}`} {...props} plan={p} onDirty={setDirty} />}
  </div>;
}
function DaySheet({ state: s, plan: p, busy, onAction: run, onDirty }: Props & { plan: WeeklyPlan }) {
  const sec = p.v2!.sections.day, sheet = useSheet(sec.rows, onDirty), rows = sheet.value, preview = linkDayRows(sec, rows);
  const editable = s.actor.role === "admin" && sec.status !== "published" && p.endAt! > s.now;
  const [search, setSearch] = useState(""), [rack, setRack] = useState(""), [selected, setSelected] = useState<string[]>([]);
  const pool = s.resources.filter(r => p.resourceIds?.includes(r.id)), choices = s.groups.filter(g => p.v2!.participantGroupIds.includes(g.id)).map(g => ({ id: g.id, label: g.name }));
  const visible = rows.filter(row => { const r = pool.find(r => r.id === row.resourceId); return r && (!rack || r.rack === rack) && `${r.name} ${r.ip} ${r.rack} ${row.assignments.map(a => groupName(s, a.groupId)).join(" ")}`.toLowerCase().includes(search.toLowerCase()); });
  const update = (id: string, changes: Partial<WeeklyServerRow>) => sheet.change(rows.map(row => row.resourceId === id ? { ...row, ...changes } : row));
  const setGroups = (row: WeeklyServerRow, groups: string[]) => ({ ...row, assignments: groups.map(groupId => row.assignments.find(a => a.groupId === groupId) ?? { groupId, purpose: "常态分配" }) });
  async function save() { if (sheet.dirty && !sheet.stale && await run({ type: "weekly.v2.rows", planId: p.id, section: "day", rows, before: sheet.before }, "白天服务器分配已保存")) sheet.reset(); }
  const issues = sectionIssues(s, p, "day", preview, s.now);
  return <form className="allocation-sheet" aria-label="白天服务器在线分配表" onSubmit={e => { e.preventDefault(); void save(); }} onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); void save(); } }}>
    <SaveBar {...sheet} busy={busy} save={() => void save()} reset={sheet.reset} />
    {!editable && <p className="notice">{sec.status === "published" ? "当前为已发布安排。需在流程页重新编排后才能修改。" : "接口人可查看分配；服务器归属由管理员编辑。"}</p>}
    <section className="panel allocation-summary"><div className="allocation-numbers"><span>参与 <b>{rows.length}</b></span><span>已分配 <b>{rows.filter(r => r.assignments.length).length}</b></span><span>剩余 <b>{rows.filter(r => !r.assignments.length).length}</b></span><span>共用 <b>{rows.filter(r => r.assignments.length > 1).length}</b></span></div><div className="allocation-team-counts">{p.v2!.participantGroupIds.map(g => { const count = rows.filter(r => r.assignments.some(a => a.groupId === g)).length, demands = sec.demands.filter(d => d.groupId === g), target = demands.reduce((n, d) => n + (d.negotiated ?? 0), 0); return <span key={g}>{groupName(s, g)} <b>{count}</b> / {!demands.length ? "常态" : demands.some(d => d.negotiated === undefined) ? "待定" : target}</span>; })}</div></section>
    <section className="panel allocation-grid-panel"><div className="allocation-filters"><input aria-label="筛选分配服务器" placeholder="搜索服务器、IP或使用组" value={search} onChange={e => setSearch(e.target.value)} /><select aria-label="筛选分配机柜" value={rack} onChange={e => setRack(e.target.value)}><option value="">全部机柜</option>{[...new Set(pool.map(r => r.rack))].filter(Boolean).map(r => <option key={r}>{r}</option>)}</select>{editable && <><ChoiceCell label="批量设置使用组" value={[]} choices={choices} disabled={!selected.length || busy} onChange={ids => { if (ids.length) sheet.change(rows.map(row => selected.includes(row.resourceId) ? setGroups(row, ids) : row)); }} /><button type="button" className="button" disabled={!selected.length || busy} onClick={() => sheet.change(rows.map(row => selected.includes(row.resourceId) ? { ...row, assignments: [] } : row))}>清空所选归属</button></>}<span>显示 {visible.length} 台{selected.length ? ` · 已选 ${selected.length} 台` : ""}</span></div>
      <div className="allocation-table-wrap"><table className="allocation-grid"><colgroup>{editable && <col style={{ width: "4%" }} />}<col style={{ width: "20%" }} /><col style={{ width: "12%" }} /><col style={{ width: "16%" }} /><col style={{ width: "20%" }} /><col style={{ width: editable ? "28%" : "32%" }} /></colgroup><thead><tr>{editable && <th><input aria-label="选择筛选结果全部服务器" type="checkbox" checked={!!visible.length && visible.every(r => selected.includes(r.resourceId))} onChange={e => setSelected(e.target.checked ? [...new Set([...selected, ...visible.map(r => r.resourceId)])] : selected.filter(id => !visible.some(r => r.resourceId === id)))} /></th>}<th>机柜 / 服务器 / IP</th><th>上周使用组</th><th>本周使用组</th><th>使用用途</th><th>特殊用途</th></tr></thead><tbody>{visible.map(row => { const r = pool.find(r => r.id === row.resourceId)!, old = p.v2!.previousRows.find(x => x.resourceId === row.resourceId), changed = JSON.stringify(sheet.before.find(x => x.resourceId === row.resourceId)) !== JSON.stringify(row); return <tr key={r.id} className={changed ? "sheet-row-edited" : ""}>
        {editable && <td><input aria-label={`选择 ${r.ip}`} type="checkbox" checked={selected.includes(r.id)} onChange={e => setSelected(e.target.checked ? [...selected, r.id] : selected.filter(id => id !== r.id))} /></td>}<td><small>{r.rack || "未登记机柜"}</small><strong>{r.name}</strong><small className="mono">{r.ip}</small></td><td>{old?.assignments.map(a => groupName(s, a.groupId)).join("、") || "—"}</td>
        <td><ChoiceCell label={`${r.ip}使用组`} value={row.assignments.map(a => a.groupId)} choices={choices} multiple disabled={!editable || busy} onChange={ids => sheet.change(rows.map(x => x.resourceId === r.id ? setGroups(x, ids) : x))} placeholder="待分配" />{row.assignments.length > 1 && <small>共用</small>}</td>
        <td>{row.assignments.map(a => <div className="sheet-purpose" key={a.groupId}>{row.assignments.length > 1 && <small>{groupName(s, a.groupId)}</small>}<CellText label={`${r.ip} ${groupName(s, a.groupId)}用途`} value={a.purpose} disabled={!editable || busy} maxLength={1000} onChange={purpose => update(r.id, { assignments: row.assignments.map(x => x.groupId === a.groupId ? { ...x, purpose } : x) })} /></div>)}</td>
        <td><CellText label={`${r.ip}特殊用途`} value={row.specialNote} disabled={!editable || busy} maxLength={2000} onChange={specialNote => update(r.id, { specialNote })} /></td>
      </tr>; })}</tbody></table></div>
    </section>
    {!!issues.length && <details className="panel allocation-issues"><summary>待协调 {issues.length} 项（不影响保存草稿）</summary><ul>{issues.map(x => <li key={x}>{x}</li>)}</ul></details>}
  </form>;
}

function MultiSheet({ state: s, plan: p, busy, onAction: run, onDirty }: Props & { plan: WeeklyPlan }) {
  const sec = p.v2!.sections.multi, sheet = useSheet(sec.allocations, onDirty), allocations = sheet.value;
  const [slotId, setSlotId] = useState(p.v2!.slots.find(x => x.enabled)?.id ?? ""), [search, setSearch] = useState("");
  const slot = p.v2!.slots.find(x => x.id === slotId)!, pool = s.resources.filter(r => p.resourceIds?.includes(r.id)), tasks = sec.demands.filter(d => d.slotIds.includes(slotId));
  const editable = s.actor.role === "admin" && sec.status !== "published" && p.endAt! > s.now, preview = { ...sec, allocations }, c = workspaceCapacity(s, p, slot, preview);
  const choices = tasks.map(d => ({ id: d.id, label: groupName(s, d.groupId), description: `${d.title} · 协商${d.negotiated ?? "待定"}台${d.continuous ? " · 同批连续" : ""}` }));
  const [localError, setLocalError] = useState("");
  function assign(resourceId: string, demandId?: string) {
    const old = allocations.find(a => a.slotId === slotId && a.resourceIds.includes(resourceId)), oldDemand = sec.demands.find(d => d.id === old?.demandId), next = tasks.find(d => d.id === demandId);
    const removedSlots = oldDemand?.continuous ? oldDemand.slotIds : [slotId], addedSlots = next?.continuous ? next.slotIds : [slotId];
    const ranges = p.v2!.slots.filter(x => next && addedSlots.includes(x.id));
    if (ranges.some(x => resourceUnavailable(s, p, pool.find(r => r.id === resourceId)!, x, s.now))) { setLocalError("该机器在所选任务的某个时段不可用，请选择其他服务器。"); return; }
    if (allocations.some(a => next && addedSlots.includes(a.slotId) && a.resourceIds.includes(resourceId) && a.demandId !== demandId && !(a.demandId === old?.demandId && removedSlots.includes(a.slotId)))) { setLocalError("连续任务的其他时段已有分配，请先协调该机器。"); return; }
    let draft = allocations.map(a => a.demandId === old?.demandId && removedSlots.includes(a.slotId) ? { ...a, resourceIds: a.resourceIds.filter(id => id !== resourceId) } : { ...a, resourceIds: a.resourceIds.slice() });
    if (next) for (const slotId of addedSlots) { const a = draft.find(a => a.demandId === next.id && a.slotId === slotId); if (a) { if (!a.resourceIds.includes(resourceId)) a.resourceIds.push(resourceId); } else draft.push({ demandId: next.id, slotId, resourceIds: [resourceId], locked: true }); }
    sheet.change(draft); setLocalError("");
  }
  async function save() { if (sheet.dirty && !sheet.stale && await run({ type: "weekly.v2.multiSheet", planId: p.id, section: "multi", before: sheet.before, allocations }, "多机服务器分配已保存")) sheet.reset(); }
  return <form className="allocation-sheet" aria-label="多机服务器在线分配表" onSubmit={e => { e.preventDefault(); void save(); }} onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); void save(); } }}><SaveBar {...sheet} busy={busy} save={() => void save()} reset={sheet.reset} />
    <section className="panel allocation-summary"><label className="field"><span>分配时段</span><select aria-label="分配时段" value={slotId} onChange={e => setSlotId(e.target.value)}>{p.v2!.slots.filter(x => x.enabled).map(x => <option value={x.id} key={x.id}>{x.label}</option>)}</select></label><div className="allocation-numbers"><span>可调配 <b>{c.available}</b></span><span>协商 <b>{c.negotiated}</b></span><span>已分配 <b>{c.assigned}</b></span><span>剩余 <b>{c.remaining}</b></span></div><div className="allocation-team-counts">{tasks.map(d => <span key={d.id}>{groupName(s, d.groupId)} · {d.title} <b>{demandAssigned(preview, d, slotId).length}</b> / {d.negotiated ?? "待定"}</span>)}</div></section>
    {localError && <p className="notice" role="alert">{localError}</p>}
    {!editable && <p className="notice">{sec.status === "published" ? "已发布安排，请先在流程页重新编排后再修改。" : "服务器归属由管理员编辑。"}</p>}
    <section className="panel allocation-grid-panel"><div className="allocation-filters"><input aria-label="筛选多机服务器" placeholder="搜索机柜、服务器或IP" value={search} onChange={e => setSearch(e.target.value)} /><span>选择任务后，连续任务的所有时段同步使用同一批机器。</span></div><div className="allocation-table-wrap"><table className="allocation-grid"><thead><tr><th>机柜 / 服务器 / IP</th><th>使用组 / 任务</th><th>事项</th><th>分配状态</th></tr></thead><tbody>{pool.filter(r => `${r.rack} ${r.name} ${r.ip}`.toLowerCase().includes(search.toLowerCase())).map(r => { const a = allocations.find(a => a.slotId === slotId && a.resourceIds.includes(r.id)), d = tasks.find(d => d.id === a?.demandId), unavailable = resourceUnavailable(s, p, r, slot, s.now); return <tr key={r.id}><td><small>{r.rack}</small><strong>{r.name}</strong><small className="mono">{r.ip}</small></td><td><ChoiceCell label={`${r.ip}多机任务`} value={d ? [d.id] : []} choices={choices} disabled={!editable || busy || (unavailable && !d)} placeholder={unavailable ? "不可调配" : "待分配"} onChange={ids => assign(r.id, ids[0])} /></td><td>{d?.title || "—"}{d?.continuous && <small>同一批连续使用</small>}</td><td>{a ? <label className="checkbox-label"><input type="checkbox" disabled={!editable || busy} checked={a.locked} onChange={e => sheet.change(allocations.map(x => x.demandId === a.demandId && (d?.continuous ? d.slotIds.includes(x.slotId) : x.slotId === slotId) ? { ...x, locked: e.target.checked } : x))} />锁定该任务安排</label> : unavailable ? "不可用" : "可分配"}</td></tr>; })}</tbody></table></div></section>
  </form>;
}
