"use client";
import { useState } from "react";
import type { Resource, UsageRequest } from "@/lib/types";

const local = (iso: string) => new Date(Date.parse(iso) + 8 * 3600000).toISOString().slice(0, 16);
export default function RequestExtensionForm({ request, resources, resourceIds, admin, busy, onConfirm, onClose }: {
  request: UsageRequest; resources: Resource[]; resourceIds: string[]; admin: boolean; busy: boolean;
  onConfirm: (value: { endAt: string; note: string }) => Promise<void>; onClose: () => void;
}) {
  const [end, setEnd] = useState(local(request.pendingExtension?.endAt ?? new Date(Date.parse(request.endAt) + 3600000).toISOString()));
  const [note, setNote] = useState("");
  const valid = Date.parse(`${end}+08:00`) > Date.parse(request.endAt);
  return <form className="extension-form" onSubmit={async e => {
    e.preventDefault();
    if (valid) await onConfirm({ endAt: new Date(`${end}+08:00`).toISOString(), note });
  }}>
    <p className="notice">{admin ? "管理员确认后直接生效。" : "提交后由管理员审批，批准前仍按原结束时间使用。"}仅延长可用且仍保留末段预约的服务器，已取消或被抢占的时段不会恢复。</p>
    <section className="assignment-selected" aria-label="本次续期服务器"><strong>本次续期 {resourceIds.length} 台服务器</strong>
      <p>{resources.filter(r => resourceIds.includes(r.id)).map(r => `${r.name}（${r.ip}）`).join("；")}</p>
    </section>
    <p>原结束时间：{local(request.endAt).replace("T", " ")}（北京时间）</p>
    <div className="slot-options">{[1, 3, 24].map(hours => <button type="button" key={hours}
      onClick={() => setEnd(local(new Date(Date.parse(request.endAt) + hours * 3600000).toISOString()))}>延长{hours === 24 ? "一天" : `${hours}小时`}</button>)}</div>
    <label className="field"><span>新的结束时间 *</span><input aria-label="续期结束时间" required type="datetime-local" value={end}
      min={local(new Date(Date.parse(request.endAt) + 60000).toISOString())} onChange={e => setEnd(e.target.value)} /></label>
    <label className="field"><span>续期说明（可选）</span><textarea aria-label="续期说明" maxLength={1000} rows={3} value={note} onChange={e => setNote(e.target.value)} /></label>
    <div className="modal-footer"><button type="button" className="button" onClick={onClose}>取消</button>
      <button className="button primary" disabled={busy || !valid || !resourceIds.length}>{admin ? "确认延长" : "提交续期申请"}</button></div>
  </form>;
}
