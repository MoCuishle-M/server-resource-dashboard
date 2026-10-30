"use client";
import { useState } from "react";
import { customRange } from "@/lib/schedule";
import { overlappingTimeBlocks, timeBlockLabels, timeBlockTitle } from "@/lib/resource-time-blocks";
import type { Action, Booking, Group, Resource, ResourceTimeBlock } from "@/lib/types";

const localInput = (iso: string) => new Date(Date.parse(iso) + 8 * 3600000).toISOString().slice(0, 16);
const time = (iso: string) => new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
export default function ResourceTimeBlockForm({ resources, bookings, groups, now, block, initialRange, busy, onSave, onClose }: {
  resources: Resource[]; bookings: Booking[]; groups: Group[]; now: string; block?: ResourceTimeBlock;
  initialRange?: { startAt: string; endAt: string }; busy: boolean;
  onSave: (action: Action) => Promise<boolean>; onClose: () => void;
}) {
  const startDefault = block?.startAt ?? initialRange?.startAt ?? now;
  const [start, setStart] = useState(localInput(startDefault < now ? now : startDefault));
  const [end, setEnd] = useState(localInput(block?.endAt ?? initialRange?.endAt ?? new Date(Date.parse(now) + 3 * 3600000).toISOString()));
  const [kind, setKind] = useState<ResourceTimeBlock["kind"]>(block?.kind ?? "emergency");
  const [label, setLabel] = useState(block?.label ?? "");
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState("");
  let range: { startAt: string; endAt: string } | undefined;
  try { range = customRange(start, end); } catch { /* Show validation on submit. */ }
  const effective = range ? { ...range, startAt: range.startAt < now ? now : range.startAt } : undefined;
  const conflicts = effective ? resources.flatMap(r => overlappingTimeBlocks(r, effective!).filter(b => b.id !== block?.id).map(b => ({ r, b }))) : [];
  const affected = effective ? bookings.filter(b => resources.some(r => r.id === b.resourceId) && b.status === "scheduled" && b.startAt < effective.endAt && b.endAt > effective.startAt) : [];
  function changed() { setConfirmed(false); setError(""); }
  return <form className="assignment-form time-block-form" onSubmit={async e => {
    e.preventDefault();
    try {
      const value = customRange(start, end);
      if (value.endAt <= new Date().toISOString()) throw new Error("结束时间必须晚于当前时间");
      if (await onSave({ type: "resource.timeBlock.save", resourceIds: resources.map(r => r.id), id: block?.id, kind, label, ...value, confirmImpact: confirmed })) onClose();
    } catch (e) { setError((e as Error).message); }
  }}>
    <p className="notice">标记时段内暂停已有预约的使用权，原排期保留；结束或提前解除后自动恢复。该时段不能新申请或批准预约。时间均为北京时间。</p>
    <section className="assignment-selected" aria-label="标记的服务器"><strong>已选 {resources.length} 台服务器</strong><p>{resources.map(r => `${r.name}（${r.ip}）`).join("；")}</p></section>
    <div className="form-grid">
      <label className="field"><span>标记类型 *</span><select aria-label="标记类型" value={kind} onChange={e => { setKind(e.target.value as ResourceTimeBlock["kind"]); changed(); }}>
        {Object.entries(timeBlockLabels).map(([value, text]) => <option key={value} value={value}>{text}</option>)}
      </select></label>
      <label className="field wide"><span>自定义说明{kind === "emergency" ? " *" : "（可选）"}</span><input aria-label="自定义说明" required={kind === "emergency"} maxLength={200} placeholder={kind === "emergency" ? "例如：客户现场问题定位、MM版本发布" : "例如：CANN升级、固件更新"} value={label} onChange={e => { setLabel(e.target.value); changed(); }} /></label>
      <label className="field"><span>标记开始时间 *</span><input aria-label="标记开始时间" type="datetime-local" required value={start} onChange={e => { setStart(e.target.value); changed(); }} /></label>
      <label className="field"><span>标记结束时间 *</span><input aria-label="标记结束时间" type="datetime-local" required value={end} onChange={e => { setEnd(e.target.value); changed(); }} /></label>
    </div>
    {block && block.startAt < now && <p className="muted">正在生效的标记从保存时刻调整，之前的标记与使用历史保留。</p>}
    <section className="priority-preview" aria-label="时段标记影响预览" aria-live="polite"><strong>预览：{timeBlockTitle({ kind, label: label.trim() })}</strong>
      {range && <p>{time(range.startAt < now ? now : range.startAt)} — {time(range.endAt)} · 北京时间</p>}
      {conflicts.map(({ r, b }) => <p className="priority-blocked-text" key={`${r.id}:${b.id}`}>{r.ip} 已有重叠标记：{timeBlockTitle(b)}，请编辑原标记或调整时间。</p>)}
      <strong>影响 {affected.length} 条已有预约</strong>
      {affected.map(b => <p key={b.id}>{resources.find(r => r.id === b.resourceId)?.ip} · {groups.find(g => g.id === b.groupId)?.name ?? "历史团队"} · {b.purpose}<br />暂停：{time(b.startAt > effective!.startAt ? b.startAt : effective!.startAt)} — {time(b.endAt < effective!.endAt ? b.endAt : effective!.endAt)}</p>)}
      {!affected.length && <p>所选时段没有已批准预约。</p>}
    </section>
    {!!affected.length && <label className="checkbox-label"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />确认暂停上述预约重叠时段的使用权，保留原排期</label>}
    {error && <p className="schedule-error" role="alert">{error}</p>}
    <div className="modal-footer"><button type="button" className="button" onClick={onClose}>取消</button><button className="button primary" disabled={busy || !resources.length || !!conflicts.length || (!!affected.length && !confirmed)}>保存时段标记</button></div>
  </form>;
}

export function ResourceTimeBlockList({ resource, now, onEdit, onCancel }: {
  resource: Resource; now: string; onEdit?: (block: ResourceTimeBlock) => void; onCancel?: (block: ResourceTimeBlock) => void;
}) {
  const blocks = [...(resource.timeBlocks ?? [])].sort((a, b) => b.startAt.localeCompare(a.startAt));
  return <section className="time-block-list" aria-label="服务器时段标记"><h3 className="detail-section-title">紧急占用与升级时段</h3>
    {!blocks.length && <p className="muted">暂无时段标记</p>}
    {blocks.map(b => <div className={`time-block-item time-block-${b.kind}`} key={b.id}>
      <div><strong>{timeBlockTitle(b)}</strong><small>{time(b.startAt)} — {time(b.endAt)} · 北京时间</small><small>{b.status === "cancelled" ? "已取消" : b.endAt <= now ? "已结束" : b.startAt > now ? "待开始" : "正在生效"}</small></div>
      {b.status === "active" && b.endAt > now && <div className="row-actions">{onEdit && <button className="text-button" onClick={() => onEdit(b)}>编辑标记</button>}{onCancel && <button className="text-button danger-text" onClick={() => onCancel(b)}>解除标记</button>}</div>}
    </div>)}
  </section>;
}
