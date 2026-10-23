"use client";
import { useState } from "react";
import { priorityAdjustmentPreview } from "@/lib/priority-adjustment";
import { priorityLabel } from "@/lib/priority";
import type { Booking, Group, Priority, Resource, UsageRequest } from "@/lib/types";

const time = (iso: string) => new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
export default function RequestPriorityForm({ request, bookings, resources, groups, clock, busy, initialResourceId, onConfirm, onClose }: {
  request: UsageRequest; bookings: Booking[]; resources: Resource[]; groups: Group[]; clock: string; busy: boolean; initialResourceId?: string;
  onConfirm: (value: { resourceIds: string[]; priority: Priority; note: string; confirm: boolean }) => Promise<void>; onClose: () => void;
}) {
  const eligible = resources.filter(r => !r.deleted && request.resourceIds.includes(r.id) && bookings.some(b => b.requestId === request.id && b.resourceId === r.id && b.status === "scheduled" && b.endAt > clock));
  const [ids, setIds] = useState(initialResourceId ? [initialResourceId] : eligible.map(r => r.id));
  const [priority, setPriority] = useState<Priority>(request.priority);
  const [note, setNote] = useState("");
  const [confirm, setConfirm] = useState(false);
  const chosen = eligible.filter(r => ids.includes(r.id));
  const preview = priorityAdjustmentPreview(bookings, resources, request, chosen.map(r => r.id), priority, clock);
  const groupName = (b: Pick<Booking, "groupId" | "purpose">) => `${groups.find(g => g.id === b.groupId)?.name ?? "历史团队"} · ${b.purpose}`;
  const resourceName = (id: string) => resources.find(r => r.id === id)?.name ?? "历史服务器";
  function choose(next: string[]) { setIds(next); setConfirm(false); }
  return <form className="assignment-form" onSubmit={async e => { e.preventDefault(); await onConfirm({ resourceIds: chosen.map(r => r.id), priority, note: note.trim(), confirm }); }}>
    <p className="notice">仅管理员可调整已批准排期。正在使用的任务从保存时刻起变更，未来任务从原开始时刻起变更；过去的优先级与使用历史保留。已取消、已释放及旧的抢占空档保持原记录。</p>
    <section className="assignment-selected" aria-label="本次调整优先级的任务"><strong>{groupName(request)}</strong><p>当前：{priorityLabel[request.priority]} · 已选 {chosen.length} / {eligible.length} 台服务器</p></section>
    <div className="assignment-tools"><button type="button" className="text-button" onClick={() => choose(eligible.map(r => r.id))}>全选可调整服务器</button><button type="button" className="text-button" onClick={() => choose([])}>清空选择</button></div>
    <fieldset className="assignment-resources"><legend>选择本任务需要调整的服务器</legend>{eligible.map(r => <label key={r.id}><input type="checkbox" checked={ids.includes(r.id)} onChange={e => choose(e.target.checked ? [...ids, r.id] : ids.filter(id => id !== r.id))} /><span>{r.name}<small>{r.ip}</small></span></label>)}</fieldset>
    <label className="field"><span>调整后的优先级 *</span><select aria-label="调整后的优先级" value={priority} onChange={e => { setPriority(e.target.value as Priority); setConfirm(false); }}>{(["normal", "high", "urgent"] as const).map(p => <option key={p} value={p}>{priorityLabel[p]}</option>)}</select></label>
    <section className="priority-preview" aria-label="优先级调整影响预览" aria-live="polite">
      <strong>{priorityLabel[request.priority]} → {priorityLabel[priority]} · 剩余排期预览</strong>
      <p>共享服务器同级共用，高优先使用；低优排期保留，仅被覆盖时段不可用。</p>
      {priority === request.priority && <p>请选择不同的优先级。</p>}
      {priority !== request.priority && !chosen.length && <p>请至少选择一台服务器。</p>}
      {preview.changes.map(p => <div key={p.booking.id} className="priority-preview-resource"><strong>{resourceName(p.booking.resourceId)} · {priorityLabel[p.booking.priority]} → {priorityLabel[priority]}</strong>{p.segments.map(s => <p key={s.startAt} className={s.blockedBy.length ? "priority-blocked-text" : ""}>{time(s.startAt)} — {time(s.endAt)}：{s.blockedBy.length ? `已排期 · 暂不可用，高优任务：${s.blockedBy.map(groupName).join("、")}` : s.sharedWith.length ? `同级共享 · 可用：${s.sharedWith.map(groupName).join("、")}` : "可用"}</p>)}</div>)}
      {!!preview.changes.length && <div className="priority-preview-resource"><strong>对其他排期的影响</strong>{!preview.impacts.length && <p>其他任务的可用状态保持不变。</p>}{preview.impacts.map((p, i) => <p key={`${p.booking.id}:${i}`} className={p.isBlocked ? "priority-blocked-text" : ""}>{resourceName(p.booking.resourceId)} · {groupName(p.booking)} · {time(p.startAt)} — {time(p.endAt)}：{p.isBlocked ? "被抢占，排期保留 · 暂不可用" : "恢复可用"}</p>)}</div>}
    </section>
    {chosen.length > 0 && chosen.length < request.resourceIds.length && <p className="assignment-result">所选服务器将拆为独立工单，其余服务器沿用原优先级。</p>}
    <label className="field"><span>调整原因 *</span><textarea aria-label="调整优先级原因" required maxLength={1000} rows={3} placeholder="说明本次提高或降低优先级的原因，保存到变更历史。" value={note} onChange={e => setNote(e.target.value)} /></label>
    <label className="checkbox-label"><input type="checkbox" checked={confirm} onChange={e => setConfirm(e.target.checked)} />确认调整优先级，并按预览更新使用权，其他任务排期保留</label>
    <div className="modal-footer"><button type="button" className="button" onClick={onClose}>取消</button><button className="button primary" disabled={busy || !chosen.length || priority === request.priority || !note.trim() || !confirm}>保存优先级</button></div>
  </form>;
}
