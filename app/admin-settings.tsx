"use client";
import { useEffect, useState } from "react";
import { ShieldCheck, Plus } from "lucide-react";
import type { Action, PublicState } from "@/lib/types";

export default function AdminSettings({ state, busy, onAction }: {
  state: PublicState; busy: boolean;
  onAction: (action: Action, message: string) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState(state.settings);
  const [dirty, setDirty] = useState(false);
  const [confirm, setConfirm] = useState("");
  useEffect(() => { if (!dirty) setDraft(state.settings); }, [state.settings, dirty]);
  const admins = state.accounts.filter(a => a.role === "admin" && a.status === "approved");
  const invitations = state.invitations.filter(i => i.status === "pending");
  return <div className="admin-settings">
    <section className="panel">
      <div className="section-heading"><div><h2>公告与作者签名</h2><p>保存后向所有访客展示；清空内容可显示默认占位文字。</p></div></div>
      <form className="settings-form" onSubmit={async e => {
        e.preventDefault();
        if (await onAction({ type: "site.settings", ...draft }, "公告与作者签名已保存")) setDirty(false);
      }}>
        <label className="field"><span>公告内容</span><textarea aria-label="公告内容" rows={5} maxLength={4000} value={draft.announcement} onChange={e => { setDraft({ ...draft, announcement: e.target.value }); setDirty(true); }} placeholder="请输入通知、维护安排或资源使用说明" /></label>
        <label className="field"><span>作者签名</span><textarea aria-label="作者签名" rows={2} maxLength={200} value={draft.authorSignature} onChange={e => { setDraft({ ...draft, authorSignature: e.target.value }); setDirty(true); }} placeholder="作者姓名、团队或联系说明" /></label>
        <div className="settings-submit"><button className="button primary" disabled={busy || !dirty}>保存公告与签名</button></div>
      </form>
    </section>
    <section className="panel">
      <div className="section-heading"><div><h2><ShieldCheck size={18} />管理员管理</h2><p>现有管理员可邀请或授权新管理员，权限覆盖资源、审批及网站设置。</p></div></div>
      <form className="settings-form admin-invite-form" onSubmit={async e => {
        e.preventDefault();
        const form = e.currentTarget;
        if (await onAction({ type: "admin.invite", ...Object.fromEntries(new FormData(form)) }, "管理员授权已保存；未注册账号需使用受邀邮箱登录")) form.reset();
      }}>
        <label className="field"><span>管理员登录邮箱 *</span><input aria-label="管理员登录邮箱" name="email" type="email" required maxLength={254} placeholder="对方的 ChatGPT 登录邮箱" /></label>
        <label className="field"><span>管理员姓名（可选）</span><input aria-label="管理员姓名" name="displayName" maxLength={50} /></label>
        <button className="button primary" disabled={busy}><Plus size={15} />新增管理员</button>
        <p className="muted">已有认证账号立即授权；其他账号使用受邀邮箱登录后自动绑定。此操作不会发送邮件。</p>
      </form>
      <div className="table-scroll"><table className="admin-table"><thead><tr><th>管理员</th><th>登录邮箱</th><th>状态</th><th>操作</th></tr></thead><tbody>
        {admins.map(a => <tr key={a.id}><td>{a.displayName}</td><td>{a.email}</td><td>已生效{a.userId === state.actor.userId ? " · 当前账号" : ""}</td><td>
          {a.userId !== state.actor.userId && admins.length > 1 && (confirm === a.id ? <div className="row-actions"><button className="text-button danger-text" disabled={busy} onClick={async () => { if (await onAction({ type: "admin.revoke", id: a.id }, "管理员权限已撤销")) setConfirm(""); }}>确认撤销</button><button className="text-button" onClick={() => setConfirm("")}>取消</button></div> : <button className="text-button danger-text" onClick={() => setConfirm(a.id)}>撤销管理员</button>)}
        </td></tr>)}
        {invitations.map(i => <tr key={i.id}><td>{i.displayName || "待登录绑定"}</td><td>{i.email}</td><td>待对方登录</td><td><button className="text-button danger-text" disabled={busy} onClick={() => onAction({ type: "admin.cancelInvitation", id: i.id }, "邀请已取消")}>取消邀请</button></td></tr>)}
      </tbody></table>{!admins.length && !invitations.length && <p className="settings-form muted">暂无已登记的管理员账号。</p>}</div>
    </section>
  </div>;
}
