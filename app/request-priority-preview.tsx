"use client";
import { requestPriorityPreview, priorityLabel } from "@/lib/priority";
import type { Booking, Group, Priority, Resource } from "@/lib/types";

const time = (iso: string) => new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
export default function RequestPriorityPreview({ resources, bookings, groups, startAt, endAt, priority }: {
  resources: Resource[]; bookings: Booking[]; groups: Group[]; startAt: string; endAt: string; priority: Priority;
}) {
  const name = (b: Booking) => `${groups.find(g => g.id === b.groupId)?.name ?? "历史团队"} · ${b.purpose}（${priorityLabel[b.priority]}）`;
  return <section className="priority-preview" aria-label="优先级与排期预览" aria-live="polite">
    <strong>优先级与排期预览 · {priorityLabel[priority]}</strong>
    <p>共享服务器：同级共用，高优优先；低优保留排期，仅重叠时段不可用。提交申请不占用资源，批准时重新核对。</p>
    {!resources.length && <p>选择服务器和起止时间后，查看可用时段及受影响的排期。</p>}
    {resources.map(resource => {
      const preview = requestPriorityPreview(resource, bookings, { startAt, endAt }, priority);
      return <div className="priority-preview-resource" key={resource.id}>
        <strong>{resource.name} · {preview?.label ?? "请填写有效的起止时间"}</strong>
        {preview?.shared && preview.segments.map(segment => <p key={segment.startAt} className={segment.blockedBy.length ? "priority-blocked-text" : ""}>
          {time(segment.startAt)} — {time(segment.endAt)}：{segment.blockedBy.length
            ? `暂不可用，高优占用：${segment.blockedBy.map(name).join("、")}`
            : segment.sharedWith.length ? `同级共享：${segment.sharedWith.map(name).join("、")}` : "可用"}
        </p>)}
        {!!preview?.affected.length && <p className="priority-blocked-text">批准后将影响：{preview.affected.map(name).join("、")}；仅重叠时段被抢占，原排期保留。管理员需确认并填写原因。</p>}
        {!preview?.shared && !!preview?.blocking.length && <p className="priority-blocked-text">独占服务器已有同级或更高优预约：{preview.blocking.map(name).join("、")}。请调整服务器或时间。</p>}
      </div>;
    })}
  </section>;
}
