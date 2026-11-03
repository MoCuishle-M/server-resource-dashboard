"use client";
import { useEffect, useState } from "react";
import type { Action, PublicState, WeeklyPlan, WeeklyServerRow } from "@/lib/types";
import { resourceSearch } from "@/lib/resource-search";

type Edit = { before: WeeklyServerRow; after: WeeklyServerRow };
export default function WeeklyOnlineSheet({ state: s, plan, busy, run, onDirty, checked, setChecked }: {
  state: PublicState; plan: WeeklyPlan; busy: boolean;
  run: (action: Action, message?: string) => Promise<boolean>;
  onDirty: (dirty: boolean) => void;
  checked: string[]; setChecked: (ids: string[]) => void;
}) {
  const [edits, setEdits] = useState<Record<string, Edit>>({}), [search, setSearch] = useState("");
  const rows = plan.rows ?? [], dirty = Object.keys(edits).length > 0, admin = s.actor.role === "admin";
  const visible = rows.filter(row => { const r = s.resources.find(r => r.id === row.resourceId); return r && !r.hidden && !r.deleted && resourceSearch(search)(r); });
  const stale = Object.values(edits).some(e => JSON.stringify(rows.find(r => r.resourceId === e.before.resourceId)) !== JSON.stringify(e.before));
  useEffect(() => { onDirty(dirty); return () => onDirty(false); }, [dirty, onDirty]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if (dirty) { e.preventDefault(); e.returnValue = ""; } };
    window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  function update(row: WeeklyServerRow, value: Partial<WeeklyServerRow>) {
    setEdits(previous => {
      const before = previous[row.resourceId]?.before ?? structuredClone(row);
      const after = { ...(previous[row.resourceId]?.after ?? row), ...value }, next = { ...previous };
      if (JSON.stringify(before) === JSON.stringify(after)) delete next[row.resourceId];
      else next[row.resourceId] = { before, after };
      return next;
    });
  }
  async function save() {
    if (!dirty || busy || stale) return;
    if (await run({ type: "weekly.table.sheet", planId: plan.id, changes: Object.values(edits) }, "在线表格已保存，各组需重新确认")) setEdits({});
  }
  return <form className="weekly-online-sheet" aria-label="预排期在线表格" onSubmit={e => { e.preventDefault(); void save(); }} onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); void save(); } }}>
    <div className="weekly-sheet-tools"><label className="field"><span>筛选在线表格</span><input value={search} onChange={e => setSearch(e.target.value)} placeholder="类型、区域、机柜、名称或IP" /></label>
      <span className="weekly-sheet-status" role="status">{dirty ? `${Object.keys(edits).length} 行未保存` : "已与服务器同步"}</span>
      <button className="button" type="button" disabled={!dirty || busy} onClick={() => { if (window.confirm("放弃尚未保存的表格修改，并载入最新数据？")) setEdits({}); }}>放弃修改</button>
      <button className="button primary" disabled={!dirty || busy || stale}>保存在线表格</button>
    </div>
    <p className="weekly-sheet-hint">管理员与已认证接口人可共同编辑。直接修改单元格，按 Tab 切换；支持 Ctrl+S 保存。修改后需各组重新确认。</p>
    {stale && <p className="notice" role="alert">你编辑的行已被其他人修改。当前输入已保留，请先复制需要的内容，再点“放弃修改”载入最新数据后重新编辑。</p>}
    <div className="table-scroll weekly-online-scroll"><table className="weekly-grid weekly-server-sheet"><thead><tr>{admin && <th><input aria-label="选择当前表格全部服务器" type="checkbox" checked={!!visible.length && visible.every(r => checked.includes(r.resourceId))} onChange={e => setChecked(e.target.checked ? [...new Set([...checked, ...visible.map(r => r.resourceId)])] : checked.filter(id => !visible.some(r => r.resourceId === id)))} /></th>}<th>区域 / 柜号</th><th>服务器类型</th><th>服务器 / OS/IP</th><th>使用组别</th><th>使用用途</th><th>特殊用途</th></tr></thead><tbody>{visible.map(source => {
      const row = edits[source.resourceId]?.after ?? source, r = s.resources.find(r => r.id === row.resourceId)!;
      return <tr key={r.id} className={edits[r.id] ? "weekly-sheet-changed" : ""}>{admin && <td><input type="checkbox" aria-label={`选择 ${r.ip}`} checked={checked.includes(r.id)} onChange={e => setChecked(e.target.checked ? [...checked, r.id] : checked.filter(id => id !== r.id))} /></td>}<td>{r.zone === "green" ? "绿区" : r.zone === "blue" ? "蓝区" : "未登记"}<small>{r.rack || "未登记机柜"}</small></td><td>{r.type}<small>{r.accessMode === "bare" ? "裸机" : "灵枢"}</small></td><td>{r.name}<small className="mono">{r.ip}</small></td>
        <td><details className="weekly-sheet-groups"><summary aria-label={`${r.ip} 使用组别`}>{row.assignments.map(a => s.groups.find(g => g.id === a.groupId)?.name).join("、") || "选择使用组"}</summary><div>{s.groups.map(g => <label className="checkbox-label" key={g.id}><input disabled={busy} type="checkbox" aria-label={`${r.ip} ${g.name}`} checked={row.assignments.some(a => a.groupId === g.id)} onChange={e => update(source, { assignments: e.target.checked ? [...row.assignments, { groupId: g.id, purpose: "本周使用" }] : row.assignments.filter(a => a.groupId !== g.id) })} />{g.name}</label>)}</div></details>{row.assignments.length > 1 && <small>共用 · 各组自行协调</small>}</td>
        <td>{row.assignments.map(a => <label className="weekly-sheet-purpose" key={a.groupId}><span>{s.groups.find(g => g.id === a.groupId)?.name}</span><textarea rows={2} maxLength={1000} disabled={busy} aria-label={`${r.ip} ${a.groupId}用途`} value={a.purpose} onChange={e => update(source, { assignments: row.assignments.map(x => x.groupId === a.groupId ? { ...x, purpose: e.target.value } : x) })} /></label>)}</td>
        <td><textarea rows={3} maxLength={2000} disabled={busy} aria-label={`${r.ip}特殊用途`} value={row.specialNote} onChange={e => update(source, { specialNote: e.target.value })} /></td></tr>;
    })}</tbody></table></div>
    {!rows.length && <p className="weekly-empty">暂无参与排期的服务器，请管理员先选择参与范围。</p>}
  </form>;
}
