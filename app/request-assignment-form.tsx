"use client";
import { useState } from "react";
import { resourceSearch } from "@/lib/resource-search";
import type { Booking, Group, Resource, UsageRequest } from "@/lib/types";

export default function RequestAssignmentForm({ request, bookings, resources, groups, clock, busy,
  initialResourceId, onConfirm, onClose }: {
  request: UsageRequest; bookings: Booking[]; resources: Resource[]; groups: Group[];
  clock: string; busy: boolean; initialResourceId?: string;
  onConfirm: (value: { resourceIds: string[]; groupId: string; purpose: string }) => Promise<void>;
  onClose: () => void;
}) {
  const eligible = resources.filter(resource => !resource.deleted && request.resourceIds.includes(resource.id)
    && (request.status === "pending" || bookings.some(b => b.requestId === request.id
      && b.resourceId === resource.id && b.status === "scheduled" && b.endAt > clock)));
  const [ids, setIds] = useState(initialResourceId ? [initialResourceId] : eligible.map(r => r.id));
  const [groupId, setGroupId] = useState(request.groupId);
  const [purpose, setPurpose] = useState(request.purpose);
  const [search, setSearch] = useState("");
  const chosen = eligible.filter(r => ids.includes(r.id));
  const matches = resourceSearch(search);
  return <form className="assignment-form" onSubmit={async e => {
    e.preventDefault();
    await onConfirm({ resourceIds: chosen.map(r => r.id), groupId, purpose: purpose.trim() });
  }}>
    <p className="notice">调整作用于原申请的整个预约周期，原时段、优先级及审批结果沿用。已取消或被抢占的时段不会恢复；调整前内容保留在变更历史。</p>
    <section className="assignment-selected" aria-label="本次调整的服务器">
      <strong>已选 {chosen.length} / {eligible.length} 台可调整服务器</strong>
      <p>{chosen.length ? chosen.map(r => `${r.name}（${r.ip}）`).join("；") : "请勾选要修改的服务器"}</p>
    </section>
    <label className="field"><span>搜索本工单服务器</span><textarea aria-label="搜索待调整服务器" rows={2}
      placeholder="名称或批量IP，可用空格、英文逗号、换行分隔" value={search} onChange={e => setSearch(e.target.value)} /></label>
    <div className="assignment-tools">
      <button type="button" className="text-button" onClick={() => setIds(eligible.map(r => r.id))}>全选可调整服务器</button>
      <button type="button" className="text-button" onClick={() => setIds([])}>清空选择</button>
    </div>
    <fieldset className="assignment-resources"><legend>选择要调整的单台或多台服务器</legend>
      {eligible.filter(matches).map(r => <label key={r.id}>
        <input type="checkbox" checked={ids.includes(r.id)} onChange={e => setIds(e.target.checked ? [...ids, r.id] : ids.filter(id => id !== r.id))} />
        <span>{r.name}<small>{r.ip}</small></span>
      </label>)}
      {!eligible.filter(matches).length && <p className="muted">没有匹配的可调整服务器</p>}
    </fieldset>
    <div className="form-grid">
      <label className="field"><span>使用组 *</span><select aria-label="调整后的使用组" value={groupId} required onChange={e => setGroupId(e.target.value)}>
        {groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
      </select></label>
      <label className="field wide"><span>使用事项 *</span><textarea aria-label="调整后的使用事项" required maxLength={1000} rows={3}
        value={purpose} onChange={e => setPurpose(e.target.value)} /></label>
    </div>
    <p className="assignment-result" role="status">{chosen.length < request.resourceIds.length
      ? `所选${chosen.length}台将形成独立工单，其余服务器保留原分配。`
      : "本工单的全部服务器将统一更新使用组和事项。"}</p>
    <div className="modal-footer">
      <button type="button" className="button" onClick={onClose}>取消</button>
      <button className="button primary" disabled={busy || !chosen.length || !purpose.trim()
        || (groupId === request.groupId && purpose.trim() === request.purpose)}>确认调整</button>
    </div>
  </form>;
}
