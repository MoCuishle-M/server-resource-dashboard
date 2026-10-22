"use client";
import { useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { CalendarDays, CheckCircle2, Download, LockKeyhole, Plus, Server, WandSparkles, X } from "lucide-react";
import type { Action, PublicState, Resource, WeeklyDemand, WeeklyLine, WeeklyPlan } from "@/lib/types";
import { calendarRange, shiftDate } from "@/lib/schedule";
import { checkWeeklyPlan, demandRange, historicalResources, matchesWeeklyLine, weeklyCategoryLabels, weeklyDemands, weeklyStatusLabels, weeklyZoneLabels } from "@/lib/weekly-planner";
import { downloadCSV } from "@/lib/csv";
import { resourceSearch } from "@/lib/resource-search";
import { FeedbackContext, OperationFeedback } from "./operation-feedback";

type Run = (action: Action, message?: string) => Promise<boolean>;
const local = (s: string) => new Date(Date.parse(s) + 8 * 3600000).toISOString().slice(0, 16);
const iso = (s: string) => new Date(`${s}:00+08:00`).toISOString();
const fmt = (s: string) => local(s).replace("T", " ");
const desc = (l: WeeklyLine) => `${weeklyZoneLabels[l.zone]} ${l.family} · ${l.accessMode === "bare" ? "裸机" : "灵枢"}`;
function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const feedback = useContext(FeedbackContext);
  useEffect(() => {
    const dialog = ref.current, previous = document.activeElement as HTMLElement;
    dialog?.showModal();
    return () => { dialog?.close(); previous?.focus(); feedback?.setNotice(n => n?.dialog === dialog ? n.kind === "error" ? null : { ...n, dialog: null } : n); };
  }, []);
  return <dialog ref={ref} className="modal modal-wide weekly-dialog" aria-label={title} onCancel={onClose}>
    {ref.current && feedback?.notice?.dialog === ref.current && <OperationFeedback notice={feedback.notice} insideDialog onClose={() => feedback.setNotice(null)} />}
    <header><h2>{title}</h2><button type="button" className="icon-button" aria-label="关闭" onClick={onClose}><X size={18} /></button></header>
    {children}
  </dialog>;
}
function Field({ label, children }: { label: string; children: ReactNode }) { return <label className="field"><span>{label}</span>{children}</label>; }
function freshLine(): WeeklyLine { return { id: crypto.randomUUID(), zone: "green", family: "A3", accessMode: "bare", desired: 1, minimum: 1, mode: "single", rackPolicy: "any", preferredResourceIds: [], shareCount: 0 }; }

function DemandForm({ state, plan, demand, busy, onAction, onClose }: { state: PublicState; plan: WeeklyPlan; demand?: WeeklyDemand; busy: boolean; onAction: Run; onClose: () => void }) {
  const [lines, setLines] = useState<WeeklyLine[]>(demand?.lines ?? [freshLine()]);
  const [peers, setPeers] = useState(demand?.shareWithDemandIds ?? []);
  const [hold, setHold] = useState(demand?.holdMode ?? "week");
  const directory = plan.directory ?? weeklyDemands(state, plan).map(d => ({ id: d.id, title: d.title, groupId: d.groupId }));
  const groupName = (id: string) => state.groups.find(g => g.id === id)?.name ?? id;
  const update = (id: string, value: Partial<WeeklyLine>) => setLines(lines.map(l => l.id === id ? { ...l, ...value } : l));
  return <form onSubmit={async e => {
    e.preventDefault(); const f = new FormData(e.currentTarget);
    if (await onAction({ type: "weekly.demand.save", planId: plan.id, demand: {
      id: demand?.id, groupId: f.get("groupId"), title: f.get("title"), category: f.get("category"), reason: f.get("reason"),
      deadline: iso(String(f.get("deadline"))), expectedStart: iso(String(f.get("start"))), expectedEnd: iso(String(f.get("end"))),
      continuousHours: Number(f.get("hours")), timeNote: f.get("timeNote"), holdMode: hold, lines,
      shareWithDemandIds: peers, shareNote: f.get("shareNote"),
    } }, "需求已保存，等待管理员统一排期")) onClose();
  }}>
    <div className="notice">填写任务需求即可，无需提前挑选具体IP。时间均为北京时间；每个任务可添加多种资源。</div>
    <div className="form-grid">
      <Field label="使用组"><select name="groupId" defaultValue={demand?.groupId ?? state.actor.groupId ?? state.groups[0]?.id} disabled={state.actor.role !== "admin" || !!demand}>{state.groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}</select></Field>
      {!!demand && <input type="hidden" name="groupId" value={demand.groupId} />}
      <Field label="需求分类"><select name="category" defaultValue={demand?.category ?? "version"}>{Object.entries(weeklyCategoryLabels).map(([v, label]) => <option value={v} key={v}>{label}</option>)}</select></Field>
      <Field label="任务名称"><input name="title" required maxLength={120} defaultValue={demand?.title} placeholder="例如：版本回归 · 多机训练验收" /></Field>
      <Field label="任务DDL"><input name="deadline" type="datetime-local" required defaultValue={demand ? local(demand.deadline) : `${shiftDate(plan.weekStart, 4)}T18:00`} /></Field>
      <Field label="使用理由 / 交付结果"><textarea name="reason" required maxLength={1000} rows={3} defaultValue={demand?.reason} placeholder="写清版本、模型或问题单，以及预期交付结果" /></Field>
      <Field label="资源保留方式"><select value={hold} onChange={e => setHold(e.target.value as "week" | "window")}><option value="week">整周保留 · 默认</option><option value="window">仅预计使用窗口 · 同意其余时间可另行安排</option></select></Field>
      <Field label="预计开始时间"><input name="start" type="datetime-local" required defaultValue={demand ? local(demand.expectedStart) : `${plan.weekStart}T09:00`} /></Field>
      <Field label="预计结束时间"><input name="end" type="datetime-local" required defaultValue={demand ? local(demand.expectedEnd) : `${shiftDate(plan.weekStart, 4)}T18:00`} /></Field>
      <Field label="连续运行小时数"><input name="hours" type="number" min={0} max={168} required defaultValue={demand?.continuousHours ?? 0} /></Field>
      <Field label="时间弹性说明"><textarea name="timeNote" rows={2} maxLength={1000} defaultValue={demand?.timeNote} placeholder="可否推迟、最晚何时开始、是否需要准备环境；0小时表示无连续时长要求" /></Field>
    </div>
    {lines.map((l, index) => <fieldset className="weekly-line" key={l.id}><legend>资源需求 {index + 1}</legend>
      <div className="form-grid">
        <Field label="区域"><select value={l.zone} onChange={e => update(l.id, { zone: e.target.value as WeeklyLine["zone"] })}><option value="green">绿区</option><option value="blue">蓝区</option></select></Field>
        <Field label="型号"><select value={l.family} onChange={e => update(l.id, { family: e.target.value as WeeklyLine["family"] })}><option>A3</option><option>A5</option></select></Field>
        <Field label="使用方式"><select value={l.accessMode} onChange={e => update(l.id, { accessMode: e.target.value as WeeklyLine["accessMode"] })}><option value="bare">裸机</option><option value="lingshu">灵枢</option></select></Field>
        <Field label="单机 / 多机"><select value={l.mode} onChange={e => update(l.id, { mode: e.target.value as WeeklyLine["mode"], rackPolicy: e.target.value === "multi" ? "prefer" : "any" })}><option value="single">单机任务（多台分别使用）</option><option value="multi">多机任务（同时到位）</option></select></Field>
        <Field label="理想数量"><input type="number" min={1} max={200} required value={l.desired} onChange={e => update(l.id, { desired: Number(e.target.value) })} /></Field>
        <Field label="最低数量"><input type="number" min={1} max={l.desired} required value={l.minimum} onChange={e => update(l.id, { minimum: Number(e.target.value) })} /></Field>
        <Field label="跨柜要求"><select value={l.rackPolicy} disabled={l.mode !== "multi"} onChange={e => update(l.id, { rackPolicy: e.target.value as WeeklyLine["rackPolicy"] })}><option value="required">必须同柜</option><option value="prefer">优先同柜</option><option value="any">允许跨柜</option></select></Field>
        <Field label="可同时共享数量"><input type="number" min={0} max={l.desired} required value={l.shareCount} onChange={e => update(l.id, { shareCount: Number(e.target.value) })} /></Field>
      </div>
      <details className="weekly-details"><summary>希望沿用的服务器（可选，已部署环境优先） · 已选 {l.preferredResourceIds.length} 台</summary>
        <div className="weekly-options">{state.resources.filter(r => !r.deleted && !r.hidden && r.zone === l.zone && r.family === l.family && r.accessMode === l.accessMode).map(r => <label className="checkbox-label" key={r.id}><input type="checkbox" checked={l.preferredResourceIds.includes(r.id)} onChange={e => update(l.id, { preferredResourceIds: e.target.checked ? [...l.preferredResourceIds, r.id] : l.preferredResourceIds.filter(id => id !== r.id) })} />{r.name} · {r.ip}</label>)}</div>
      </details>
      {lines.length > 1 && <button type="button" className="text-button danger-text" onClick={() => setLines(lines.filter(x => x.id !== l.id))}>移除此类需求</button>}
    </fieldset>)}
    <button type="button" className="button" disabled={lines.length >= 10} onClick={() => setLines([...lines, freshLine()])}><Plus size={16} />添加另一种资源</button>
    <fieldset className="weekly-line"><legend>共享约定</legend><p className="muted">同时共享需双方都选中对方任务；管理员还需指定具体机器。错峰请分别选择“仅预计使用窗口”。</p>
      <div className="weekly-options">{directory.filter(d => d.id !== demand?.id).map(d => <label className="checkbox-label" key={d.id}><input type="checkbox" checked={peers.includes(d.id)} onChange={e => setPeers(e.target.checked ? [...peers, d.id] : peers.filter(id => id !== d.id))} />{groupName(d.groupId)} · {d.title}</label>)}</div>
      <Field label="共享条件与限制"><textarea name="shareNote" rows={3} maxLength={1000} defaultValue={demand?.shareNote} placeholder="例如：允许与模型开箱任务共用2台，双方确认依赖环境兼容。对方还未提交时可先写说明，之后补选。" /></Field>
    </fieldset>
    <div className="modal-footer"><button type="button" className="button" onClick={onClose}>取消</button><button className="button primary" disabled={busy}>保存需求</button></div>
  </form>;
}

function AssignmentForm({ state, plan, demand, line, busy, onAction, onClose }: { state: PublicState; plan: WeeklyPlan; demand: WeeklyDemand; line: WeeklyLine; busy: boolean; onAction: Run; onClose: () => void }) {
  const original = plan.allocations.find(a => a.demandId === demand.id && a.lineId === line.id);
  const [ids, setIds] = useState(original?.resourceIds ?? []), [shared, setShared] = useState(original?.sharedResourceIds ?? []);
  const [search, setSearch] = useState("");
  const history = historicalResources(state, plan, demand);
  const candidates = state.resources.filter(r => !r.hidden && !r.deleted && (matchesWeeklyLine(r, line) || ids.includes(r.id)) && resourceSearch(search)(r));
  return <form onSubmit={async e => {
    e.preventDefault(); const f = new FormData(e.currentTarget);
    if (await onAction({ type: "weekly.assign", planId: plan.id, demandId: demand.id, lineId: line.id,
      resourceIds: ids, sharedResourceIds: shared.filter(id => ids.includes(id)), locked: f.has("locked"), note: f.get("note") }, "分配草稿已保存；确认状态已重置")) onClose();
  }}>
    <p className="notice">{desc(line)}：理想 {line.desired} 台，最低 {line.minimum} 台。已选 {ids.length} 台，共享 {shared.filter(id => ids.includes(id)).length} 台。草稿允许暂存冲突，发布前必须处理。</p>
    <Field label="搜索候选服务器"><textarea rows={2} value={search} onChange={e => setSearch(e.target.value)} placeholder="名称、位置或批量IP" /></Field>
    <div className="weekly-picker">{candidates.map(r => {
      const range = demandRange(plan, demand);
      const reserved = state.bookings.some(b => b.resourceId === r.id && b.status === "scheduled" && b.startAt < range.endAt && b.endAt > range.startAt);
      const others = plan.allocations.filter(a => a.demandId !== demand.id && a.resourceIds.includes(r.id)).map(a => state.weeklyDemands.find(d => d.id === a.demandId)?.title).filter(Boolean);
      return <div className="weekly-pick-row" key={r.id}>
        <label className="checkbox-label"><input type="checkbox" checked={ids.includes(r.id)} onChange={e => { setIds(e.target.checked ? [...ids, r.id] : ids.filter(id => id !== r.id)); if (!e.target.checked) setShared(shared.filter(id => id !== r.id)); }} /><span><strong>{r.name}</strong><small>{r.ip} · {r.location || "未登记机房"} / {r.rack || "未登记机柜"}</small><small>{history.includes(r.id) ? "近期本组预约过 · " : ""}{reserved ? "已有正式预约 · " : ""}{others.length ? `草稿已分给：${others.join("、")}` : ""}</small></span></label>
        <label className="checkbox-label"><input type="checkbox" aria-label={`允许共享 ${r.name}`} checked={shared.includes(r.id)} disabled={!ids.includes(r.id) || r.sharingMode !== "shared" || !line.shareCount} onChange={e => setShared(e.target.checked ? [...shared, r.id] : shared.filter(id => id !== r.id))} />可共享</label>
      </div>;
    })}{!candidates.length && <p className="weekly-empty">没有符合条件的机器。请先在服务器资源中登记区域、排期型号和机柜。</p>}</div>
    <label className="checkbox-label"><input type="checkbox" name="locked" defaultChecked={original?.locked ?? true} />锁定本行分配，重新推荐时保留</label>
    <Field label="分配说明"><textarea name="note" rows={2} maxLength={1000} defaultValue={original?.note} placeholder="记录迁移、共享或数量妥协的原因" /></Field>
    <div className="modal-footer"><button type="button" className="button" onClick={onClose}>取消</button><button className="button primary" disabled={busy}>保存分配</button></div>
  </form>;
}

export default function WeeklyPlanning({ state: s, busy, onAction }: { state: PublicState; busy: boolean; onAction: Run }) {
  const [selected, setSelected] = useState("");
  const [dialog, setDialog] = useState<"create" | "demand" | "assign" | "confirm" | "defer" | "publish" | "withdraw" | null>(null);
  const [editing, setEditing] = useState<WeeklyDemand>();
  const [line, setLine] = useState<WeeklyLine>();
  const [confirmGroup, setConfirmGroup] = useState("");
  const admin = s.actor.role === "admin", contact = s.actor.role === "contact";
  const plans = [...s.weeklyPlans].sort((a, b) => b.weekStart.localeCompare(a.weekStart));
  const plan = plans.find(p => p.id === selected) ?? plans[0];
  const ds = plan ? weeklyDemands(s, plan) : [];
  const issues = plan && plan.status !== "published" && admin ? checkWeeklyPlan(s, plan) : [];
  const errors = issues.filter(x => x.severity === "error");
  const groupName = (id: string) => s.groups.find(g => g.id === id)?.name ?? id;
  const close = () => setDialog(null);
  const mutable = !!plan && plan.status !== "published";
  const groupIds = [...new Set(ds.map(d => d.groupId))];
  const confirmationGroups = admin ? groupIds : groupIds.filter(id => id === s.actor.groupId);
  const nextMonday = shiftDate(local(calendarRange(local(s.now).slice(0, 10), "week").startAt).slice(0, 10), 7);
  function exportPlan() {
    if (!plan) return;
    downloadCSV(`${plan.weekStart}周排期.csv`, [["使用组", "任务", "分类", "理由", "DDL（北京时间）", "预计开始", "预计结束", "保留方式", "类型", "理想数量", "最低数量", "已分配", "服务器IP", "机柜", "具体共享IP", "共享条件", "时间弹性", "分配说明", "暂缓原因"],
      ...ds.flatMap(d => d.lines.map(l => {
        const a = plan.allocations.find(a => a.demandId === d.id && a.lineId === l.id);
        const rs = (a?.resourceIds ?? []).map(id => s.resources.find(r => r.id === id)).filter((r): r is Resource => !!r);
        return [groupName(d.groupId), d.title, weeklyCategoryLabels[d.category], d.reason, fmt(d.deadline), fmt(d.expectedStart), fmt(d.expectedEnd), d.holdMode === "week" ? "整周" : "使用窗口", desc(l), String(l.desired), String(l.minimum), String(rs.length), rs.map(r => r.ip).join("；"), rs.map(r => `${r.location}/${r.rack || "未登记"}`).join("；"), rs.filter(r => a?.sharedResourceIds.includes(r.id)).map(r => r.ip).join("；"), d.shareNote, d.timeNote, a?.note ?? "", plan.deferred.find(x => x.demandId === d.id)?.reason ?? ""];
      }))]);
  }
  return <div className="weekly-workspace">
    <section className="panel weekly-overview"><div className="section-heading"><div><h2><CalendarDays size={20} />本周协调工作台</h2><p>先收集需求，再分配机器。草稿不占用正式资源。</p></div><div className="weekly-actions">
      {!!plans.length && <select aria-label="选择周排期" value={plan?.id} onChange={e => { setSelected(e.target.value); close(); }}>{plans.map(p => <option key={p.id} value={p.id}>{p.weekStart} 周 · {weeklyStatusLabels[p.status]}</option>)}</select>}
      {admin && <button className="button primary" disabled={busy} onClick={() => setDialog("create")}><Plus size={16} />创建周计划</button>}
    </div></div>
    {plan ? <><div className="weekly-steps">{Object.entries(weeklyStatusLabels).map(([key, label], i) => <span key={key} className={plan.status === key ? "current" : ""}><b>{i + 1}</b>{label}</span>)}</div>
      <div className="weekly-metrics"><span><strong>{ds.length}</strong>项{admin ? "有效需求" : "可见需求"}</span><span><strong>{new Set(plan.allocations.flatMap(a => a.resourceIds)).size}</strong>台{admin ? "分配服务器" : "可见服务器"}</span>{plan.status === "published" ? <span><strong>已发布</strong>各组已完成确认</span> : (admin || contact) && <span><strong>{confirmationGroups.filter(id => plan.confirmations.some(c => c.groupId === id && c.status === "confirmed")).length}/{confirmationGroups.length}</strong>{admin ? "组已确认" : "本组确认"}</span>}{admin && <span><strong>{errors.length}</strong>项待处理冲突</span>}</div>
      <div className="weekly-actions weekly-toolbar">
        {(admin || contact) && plan.status === "collecting" && <button className="button primary" disabled={busy} onClick={() => { setEditing(undefined); setDialog("demand"); }}><Plus size={16} />提交任务需求</button>}
        {admin && plan.status === "collecting" && !ds.length && plans.some(p => p.weekStart < plan.weekStart) && <button className="button" disabled={busy} onClick={() => onAction({ type: "weekly.copyPrevious", planId: plan.id }, "上一期需求已带入，日期已顺延；请各组核对DDL、数量和共享条件")}>带入上期需求</button>}
        {admin && plan.status === "collecting" && <button className="button" disabled={busy} onClick={() => onAction({ type: "weekly.stage", planId: plan.id, status: "draft" }, "收集已结束，可以安排本周资源")}>结束收集，开始排期</button>}
        {admin && mutable && plan.status !== "collecting" && <>
          <button className="button" disabled={busy} onClick={() => onAction({ type: "weekly.suggest", planId: plan.id, historyOnly: true }, "已沿用历史候选；锁定分配已保留")}><Server size={16} />沿用已有分配</button>
          <button className="button" disabled={busy} onClick={() => onAction({ type: "weekly.suggest", planId: plan.id }, "规则推荐已生成，请检查缺口与妥协项")}><WandSparkles size={16} />推荐分配</button>
          <button className="button" disabled={busy} onClick={() => onAction({ type: "weekly.stage", planId: plan.id, status: "collecting" }, "已重新开放收集；原分配保留，修改任务会清除该任务分配")}>重新开放收集</button>
          {plan.status === "draft" && <button className="button primary" disabled={busy || !!errors.length || !ds.length} onClick={() => onAction({ type: "weekly.stage", planId: plan.id, status: "confirming" }, "方案已进入各组确认，请接口人核对本组分配")}>提交各组确认</button>}
          {plan.status === "confirming" && <button className="button primary" disabled={busy || !!errors.length} onClick={() => setDialog("publish")}><CheckCircle2 size={16} />发布本周方案</button>}
        </>}
        <button className="button" disabled={!ds.length} onClick={exportPlan}><Download size={16} />导出表格</button>
      </div>
      <p className="weekly-caption">{plan.status === "published" ? `已于 ${fmt(plan.publishedAt)} 发布到使用排期。此页保留发布快照；临时事项通过申请、续期或取消另行处理。` : "默认整周保留；只有明确选择使用窗口的任务才可错峰。推荐依据预约历史，不代表机器实际利用率。"}</p>
    </> : <div className="weekly-empty"><CalendarDays size={34} /><h3>还没有可查看的周计划</h3><p>{admin ? "创建一周的需求收集，把需求和服务器放在一起协调。" : "管理员创建后，认证接口人可以提交本组需求；访客可查看已发布方案。"}</p></div>}
    </section>
    {plan && <>
      {admin && mutable && <section className="panel weekly-checks"><h3>约束检查与妥协项</h3><p className="muted">规则推荐按DDL、同柜约束和提交顺序安排，先满足最低数量；不自动降配到最低以下，不自动抢占，不自动协商共享。</p>
        {issues.length ? <ul>{issues.map((x, i) => <li className={x.severity} key={i}><b>{x.severity === "error" ? "需处理" : "需核对"}</b>{x.message}</li>)}</ul> : <p className="weekly-pass">{ds.length ? "当前草稿未发现数量、机柜、共享或预约冲突。发布时会重新校验。" : "等待提交需求。"}</p>}
        {!!s.resources.filter(r => !r.deleted && !r.hidden && (!r.zone || !r.family || !r.rack)).length && <p className="notice">部分服务器尚未登记区域、排期型号或机柜。请到“服务器资源”编辑、批量修改，或用Excel按IP更新；未登记区域和型号的机器不会进入推荐。</p>}
      </section>}
      <section className="panel"><div className="section-heading"><div><h2>需求汇总与分配</h2><p>{admin ? "每条任务可以包含多种资源；手工填表与推荐分配可交替进行。" : "未发布需求仅本组可见；请核对数量、机器和共享约定。"}</p></div></div>
        <div className="table-scroll"><table className="weekly-table"><thead><tr><th>任务 / 使用组</th><th>时间与用途</th><th>资源需求</th><th>分配草稿 / 发布快照</th><th>操作与状态</th></tr></thead><tbody>
          {ds.map(d => <tr key={d.id}><td><strong>{d.title}</strong><small>{groupName(d.groupId)} · {weeklyCategoryLabels[d.category]}</small>{d.reason && <details><summary>使用理由与约定</summary><p>{d.reason}</p><p>{d.timeNote}</p><p>{d.shareNote}</p></details>}</td>
            <td><strong>DDL {fmt(d.deadline)}</strong><small>{fmt(d.expectedStart)} 至<br />{fmt(d.expectedEnd)}</small><small>{d.holdMode === "week" ? "整周保留" : "仅使用窗口"} · 连续 {d.continuousHours} 小时</small></td>
            <td>{d.lines.map(l => <div className="weekly-cell-line" key={l.id}><strong>{desc(l)}</strong><small>理想 {l.desired} / 最低 {l.minimum} 台</small><small>{l.mode === "multi" ? "多机同时到位" : "单机分别使用"} · {l.rackPolicy === "required" ? "必须同柜" : l.rackPolicy === "prefer" ? "优先同柜" : "可跨柜"}</small><small>允许同时共享 {l.shareCount} 台</small></div>)}</td>
            <td>{plan.deferred.some(x => x.demandId === d.id) ? <p className="weekly-deferred">本周暂缓：{plan.deferred.find(x => x.demandId === d.id)?.reason}</p> : d.lines.map(l => {
              const a = plan.allocations.find(x => x.demandId === d.id && x.lineId === l.id);
              return <div className="weekly-cell-line" key={l.id}><strong>{a?.locked && <LockKeyhole size={13} />} {a?.resourceIds.length ?? 0} 台 · {desc(l)}</strong>
                {(a?.resourceIds ?? []).map(id => { const r = s.resources.find(r => r.id === id); return <small key={id}>{r?.name ?? "资源不可见"} · {r?.ip}<br />{r?.location} / {r?.rack || "未登记机柜"}{a?.sharedResourceIds.includes(id) ? " · 同时共享" : ""}</small>; })}
                {a?.note && <small>{a.note}</small>}
                {admin && mutable && plan.status !== "collecting" && <button className="text-button orange-text" disabled={busy} onClick={() => { setEditing(d); setLine(l); setDialog("assign"); }}>选择机器 / 锁定</button>}
              </div>;
            })}</td>
            <td><div className="weekly-row-actions">{mutable && plan.status === "collecting" && (admin || d.groupId === s.actor.groupId) && <><button className="text-button" disabled={busy} onClick={() => { setEditing(d); setDialog("demand"); }}>修改需求</button><button className="text-button danger-text" disabled={busy} onClick={() => { setEditing(d); setDialog("withdraw"); }}>撤回需求</button></>}
              {admin && mutable && plan.status !== "collecting" && <button className="text-button" disabled={busy} onClick={() => { setEditing(d); setDialog("defer"); }}>{plan.deferred.some(x => x.demandId === d.id) ? "恢复参与排期" : "本周暂缓"}</button>}
              <small>{plan.status === "published" ? "已发布" : plan.confirmations.find(c => c.groupId === d.groupId)?.status === "confirmed" ? "本组已确认" : plan.confirmations.find(c => c.groupId === d.groupId)?.status === "changes" ? "本组提出调整" : "待协调"}</small>
            </div></td></tr>)}
        </tbody></table></div>{!ds.length && <p className="weekly-empty">暂无可见需求。收集阶段由接口人提交，也可由管理员代填。</p>}
      </section>
      {(admin || contact) && !!ds.length && <section className="panel weekly-confirmations"><h3>各组确认</h3><p className="muted">确认仅对当前草稿有效；修改需求或分配后，需重新确认。管理员代确认必须记录原因。</p>{confirmationGroups.map(id => { const c = plan.confirmations.find(c => c.groupId === id); return <div key={id}><span><strong>{groupName(id)}</strong><small>{c ? `${c.status === "confirmed" ? "已确认" : "需调整"} · ${c.by} · ${c.note || "已核对本组分配"}` : "等待核对"}</small></span>{plan.status === "confirming" && (admin || id === s.actor.groupId) && <button className="button" disabled={busy} onClick={() => { setConfirmGroup(id); setDialog("confirm"); }}>{admin ? "记录代确认 / 反馈" : "核对本组方案"}</button>}</div>; })}</section>}
    </>}
    {dialog === "create" && <Dialog title="创建周计划" onClose={close}><form onSubmit={async e => { e.preventDefault(); const f = new FormData(e.currentTarget); if (await onAction({ type: "weekly.create", weekStart: f.get("weekStart") }, "周计划已创建，可以开始收集需求")) { setSelected(""); close(); } }}><Field label="周起始日期（北京时间周一）"><input type="date" name="weekStart" required defaultValue={nextMonday} /></Field><p className="notice">每周独立收集和发布；不会自动修改现有预约。</p><div className="modal-footer"><button className="button primary" disabled={busy}>创建并开始收集</button></div></form></Dialog>}
    {dialog === "demand" && plan && <Dialog title={editing ? "修改任务需求" : "提交任务需求"} onClose={close}><DemandForm state={s} plan={plan} demand={editing} busy={busy} onAction={onAction} onClose={close} /></Dialog>}
    {dialog === "assign" && plan && editing && line && <Dialog title={`分配服务器 · ${editing.title}`} onClose={close}><AssignmentForm state={s} plan={plan} demand={editing} line={line} busy={busy} onAction={onAction} onClose={close} /></Dialog>}
    {dialog === "confirm" && plan && <Dialog title={`核对分配 · ${groupName(confirmGroup)}`} onClose={close}><form onSubmit={async e => { e.preventDefault(); const f = new FormData(e.currentTarget); if (await onAction({ type: "weekly.confirm", planId: plan.id, groupId: confirmGroup, status: f.get("status"), note: f.get("note") }, "本组确认结果已记录")) close(); }}><p className="notice">请核对本组所有任务的服务器、数量、占用时间、共享条件与暂缓安排。</p><Field label="核对结果"><select name="status"><option value="confirmed">接受本组方案</option><option value="changes">需要调整</option></select></Field><Field label={admin ? "代确认原因（必填）" : "反馈说明（需要调整时必填）"}><textarea name="note" rows={3} maxLength={1000} required={admin} placeholder={admin ? "例如：已在线下与本组接口人核对，由管理员代录" : "具体需要怎样调整"} /></Field><div className="modal-footer"><button className="button primary" disabled={busy}>保存核对结果</button></div></form></Dialog>}
    {dialog === "defer" && plan && editing && <Dialog title={`调整本周安排 · ${editing.title}`} onClose={close}><form onSubmit={async e => { e.preventDefault(); const f = new FormData(e.currentTarget); if (await onAction({ type: "weekly.defer", planId: plan.id, demandId: editing.id, deferred: !plan.deferred.some(x => x.demandId === editing.id), reason: f.get("reason") }, "本周安排已更新，需重新确认")) close(); }}>{plan.deferred.some(x => x.demandId === editing.id) ? <p className="notice">恢复后需要重新分配服务器，并由本组确认。</p> : <><p className="notice">暂缓会清除该任务本周的草稿分配；发布前仍需本组接受此安排。</p><Field label="暂缓原因"><textarea name="reason" required maxLength={1000} rows={3} placeholder="资源缺口、协商结果及后续安排" /></Field></>}<div className="modal-footer"><button className="button primary" disabled={busy}>确认调整</button></div></form></Dialog>}
    {dialog === "withdraw" && plan && editing && <Dialog title="撤回任务需求" onClose={close}><p>撤回“{editing.title}”及其草稿分配，可在收集阶段重新提交。</p><div className="modal-footer"><button className="button" onClick={close}>保留需求</button><button className="button danger" disabled={busy} onClick={async () => { if (await onAction({ type: "weekly.demand.withdraw", planId: plan.id, demandId: editing.id }, "需求已撤回")) close(); }}>确认撤回</button></div></Dialog>}
    {dialog === "publish" && plan && <Dialog title="发布本周方案" onClose={close}><p className="notice">发布 {plan.weekStart} 周的 {ds.length} 项需求、{new Set(plan.allocations.flatMap(a => a.resourceIds)).size} 台服务器；{plan.deferred.length} 项暂缓。发布后生成正式预约，各组须已确认。若本周已经开始，预约从实际发布时间生效。</p>{issues.filter(i => i.severity === "warning").map((i, n) => <p className="weekly-publish-warning" key={n}>{i.message}</p>)}<p>发布后此页保留方案快照；突发变化通过原有预约功能另行处理。</p><div className="modal-footer"><button className="button" onClick={close}>继续检查</button><button className="button primary" disabled={busy} onClick={async () => { if (await onAction({ type: "weekly.publish", planId: plan.id }, "本周方案已发布，正式使用排期已同步")) close(); }}>确认发布到使用排期</button></div></Dialog>}
  </div>;
}
