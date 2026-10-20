import { emptyState, timeRange, chinaDate } from "./domain";
import type {
  PublicState,
  Resource,
  UsageRequest,
  Booking,
  Actor,
} from "./types";
export const demoAdmin: Actor = {
  userId: "demo-admin",
  displayName: "演示管理员",
  email: "admin@example.test",
  role: "admin",
  groupId: "g1",
  employeeId: "DEMO001",
};
export const demoContact: Actor = {
  userId: "demo-contact",
  displayName: "演示接口人",
  email: "contact@example.test",
  role: "contact",
  groupId: "g1",
  employeeId: "DEMO002",
};
export function demoState(): PublicState {
  const now = new Date();
  const s = emptyState();
  const at = now.toISOString();
  const today = chinaDate(now);
  s.groups = s.groups.map((g, i) => ({
    ...g,
    name: [
      "大模型预训练组",
      "多模态算法组",
      "推理优化组",
      "平台工程组",
      "模型评测组",
      "数据工程组",
      "强化学习组",
      "算子开发组",
      "应用研发组",
      "基础设施组",
    ][i],
    contactName: `演示接口人${i + 1}`,
    employeeId: `DEMO${String(i + 1).padStart(3, "0")}`,
  }));
  for (let i = 0; i < 16; i++)
    s.resources.push({
      id: `r${i + 1}`,
      name: `${i < 10 ? "Atlas-910B" : "Atlas-950"}-${String((i % 10) + 1).padStart(2, "0")}`,
      type: i < 10 ? "Ascend 910B · 8卡" : "Ascend 950 · 8卡",
      ip: `192.0.2.${i + 11}`,
      accessMode: i % 3 ? "bare" : "lingshu",
      sharingMode: i === 0 ? "shared" : "exclusive",
      location: `北京 · ${i < 8 ? "A01" : "A02"}机柜`,
      note: "示例服务器，仅用于演示",
      status: i === 15 ? "maintenance" : "available",
      deleted: false,
      createdAt: at,
      updatedAt: at,
    });
  const tasks = [
    "Qwen3 预训练 · 长上下文实验",
    "多模态对齐 · 第二轮训练",
    "推理引擎吞吐测试",
    "分布式通信性能回归",
    "模型精度评测",
  ];
  for (let i = 0; i < 9; i++) {
    const startAt = new Date(
      now.getTime() + (i < 5 ? -2 : 2) * 3600000,
    ).toISOString();
    const endAt = new Date(
      now.getTime() + (i < 5 ? 3 : 6) * 3600000,
    ).toISOString();
    const r: UsageRequest = {
      id: `q${i}`,
      groupId: `g${(i % 5) + 1}`,
      resourceIds: i < 3 ? [`r${i * 2 + 1}`, `r${i * 2 + 2}`] : [`r${i + 4}`],
      startAt,
      endAt,
      purpose: tasks[i % 5],
      priority: i === 2 ? "high" : "normal",
      status: i < 7 ? "approved" : "pending",
      applicantId: `demo-${i}`,
      applicantName: `演示接口人${(i % 5) + 1}`,
      createdAt: new Date(now.getTime() - 4 * 3600000).toISOString(),
      reviewedAt: i < 7 ? at : "",
      reviewer: i < 7 ? "演示管理员" : "",
      reviewNote: i < 7 ? "资源已确认" : "",
    };
    s.requests.push(r);
    if (i < 7)
      for (const resourceId of r.resourceIds)
        s.bookings.push({
          id: `b${i}-${resourceId}`,
          requestId: r.id,
          resourceId,
          groupId: r.groupId,
          startAt,
          endAt,
          purpose: r.purpose,
          priority: r.priority,
          status: "scheduled",
          parentId: "",
          createdAt: r.createdAt,
          updatedAt: at,
        });
  }
  // Two teams share one 8-card server; no per-card allocation is recorded.
  s.requests.push({
    ...s.requests[1],
    id: "shared-demo",
    resourceIds: ["r1"],
    purpose: "共享服务器 · 算法联调",
  });
  s.bookings.push({
    ...s.bookings[0],
    id: "shared-demo-booking",
    requestId: "shared-demo",
    groupId: "g2",
    purpose: "共享服务器 · 算法联调",
  });
  const past = timeRange(chinaDate(new Date(now.getTime() - 86400000)), 0);
  s.bookings.push({
    id: "history-1",
    requestId: "history-request",
    resourceId: "r1",
    groupId: "g3",
    ...past,
    purpose: "vLLM 推理基线验证",
    priority: "normal",
    status: "scheduled",
    parentId: "",
    createdAt: past.startAt,
    updatedAt: past.endAt,
  });
  s.audits.push(
    {
      id: "a1",
      at: new Date(now.getTime() - 3600000).toISOString(),
      actorId: "demo-admin",
      actorName: "演示管理员",
      action: "批准申请",
      entityType: "request",
      entityId: "q2",
      summary: "批准推理优化组的高优任务申请",
      before: "null",
      after: "null",
    },
    {
      id: "a2",
      at: new Date(now.getTime() - 7200000).toISOString(),
      actorId: "demo-admin",
      actorName: "演示管理员",
      action: "批量导入",
      entityType: "resource",
      entityId: "r1",
      summary: "批量导入16台示例服务器",
      before: "null",
      after: "null",
    },
  );
  return { ...s, actor: demoAdmin, adminConfigured: true, now: at, demo: true };
}
