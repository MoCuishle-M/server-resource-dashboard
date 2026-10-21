"use client";
import { useState } from "react";
import { partialCancellationPlan } from "@/lib/booking-adjustment";
import type { Booking, Resource, UsageRequest } from "@/lib/types";

const local = (iso: string) => new Date(Date.parse(iso) + 8 * 3600000).toISOString().slice(0, 16);
const display = (iso: string) => new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
}).format(new Date(iso));

export default function PartialCancelForm({ request, bookings, resources, clock, busy, initialResourceId, onConfirm, onClose }: {
  request: UsageRequest; bookings: Booking[]; resources: Resource[]; clock: string; busy: boolean;
  initialResourceId?: string;
  onConfirm: (value: { resourceIds: string[]; startAt: string; endAt: string; note: string }) => Promise<void>;
  onClose: () => void;
}) {
  const future = bookings.filter(b => b.requestId === request.id && b.status === "scheduled" && b.endAt > clock)
    .sort((a, b) => a.startAt.localeCompare(b.startAt));
  const options = [...new Set(future.map(b => b.resourceId))];
  const [ids, setIds] = useState(initialResourceId ? [initialResourceId] : options);
  const first = future.find(b => !initialResourceId || b.resourceId === initialResourceId);
  const initialStart = Math.max(Date.parse(first?.startAt ?? request.startAt), Math.ceil(Date.parse(clock) / 60000) * 60000);
  const [start, setStart] = useState(local(new Date(initialStart).toISOString()));
  const [end, setEnd] = useState(local(first?.endAt ?? request.endAt));
  const [note, setNote] = useState("");
  const startMs = Date.parse(`${start}+08:00`), endMs = Date.parse(`${end}+08:00`);
  const range = Number.isFinite(startMs) && Number.isFinite(endMs)
    ? { startAt: new Date(startMs).toISOString(), endAt: new Date(endMs).toISOString() } : null;
  const error = !ids.length ? "请选择需要调整的服务器"
    : !range || endMs <= startMs ? "取消结束时间必须晚于开始时间"
    : startMs < Date.parse(clock) ? "不能取消已经过去的时间段"
    : startMs < Date.parse(request.startAt) || endMs > Date.parse(request.endAt) ? "取消时间必须在原申请范围内" : "";
  const plan = range && !error ? partialCancellationPlan(bookings, request.id, ids, range) : [];
  const name = (id: string) => resources.find(r => r.id === id)?.name ?? "历史资源";
  return <form className="partial-form" onSubmit={async e => {
    e.preventDefault();
    if (range && !error && plan.length && note.trim()) await onConfirm({ resourceIds: ids, ...range, note: note.trim() });
  }}>
    <div className="request-summary"><h3>{request.purpose}</h3><p>原申请：{display(request.startAt)} → {display(request.endAt)}</p></div>
    <fieldset className="partial-resources"><legend>需要调整的服务器</legend>
      {options.map(id => <label key={id}><input type="checkbox" checked={ids.includes(id)} onChange={e => setIds(e.target.checked ? [...ids, id] : ids.filter(x => x !== id))} />{name(id)}</label>)}
    </fieldset>
    <div className="form-grid">
      <label className="field"><span>取消开始时间 *</span><input type="datetime-local" required value={start} min={local(new Date(Math.max(Date.parse(request.startAt), Math.ceil(Date.parse(clock) / 60000) * 60000)).toISOString())} max={local(request.endAt)} onChange={e => setStart(e.target.value)} /></label>
      <label className="field"><span>取消结束时间 *</span><input type="datetime-local" required value={end} max={local(request.endAt)} onChange={e => setEnd(e.target.value)} /></label>
      <label className="field wide"><span>取消原因 *</span><textarea required maxLength={1000} rows={3} value={note} onChange={e => setNote(e.target.value)} placeholder="例如12–14点临时任务，需要释放该时段。" /></label>
    </div>
    <section className="partial-preview" aria-label="时段调整预览" aria-live="polite">
      <h3>调整预览</h3>
      {error ? <p role="alert">{error}</p> : !plan.length ? <p role="alert">所选时间内没有可取消的有效预约</p> : plan.map(p => <div key={p.booking.id}>
        <strong>{name(p.booking.resourceId)}</strong>
        <p>取消：{display(p.cancelled.startAt)} → {display(p.cancelled.endAt)}</p>
        <p>保留：{p.retained.length ? p.retained.map(r => `${display(r.startAt)} → ${display(r.endAt)}`).join("；") : "该条预约无剩余时段"}</p>
      </div>)}
      <p className="muted">只取消与有效预约重叠的时段，其他时段与服务器保持原排期和占用模式。腾出的时段可重新申请。</p>
    </section>
    <div className="modal-footer"><button type="button" className="button" onClick={onClose}>返回</button><button className="button danger" disabled={busy || !!error || !plan.length || !note.trim()}>确认取消所选时段</button></div>
  </form>;
}
