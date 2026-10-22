import { test } from "node:test";
import assert from "node:assert/strict";
import { activeBookings, emptyState, mutate, serializePublic } from "../lib/domain";
import type { Actor, State } from "../lib/types";

const now = "2026-10-22T00:00:00.000Z";
const startAt = "2026-10-22T01:00:00.000Z", endAt = "2026-10-22T11:00:00.000Z";
const admin: Actor = { userId: "admin", displayName: "管理员", email: "a@example.test", role: "admin", groupId: "", employeeId: "" };
const contact: Actor = { ...admin, userId: "contact", displayName: "接口人", role: "contact", groupId: "g1" };
const act = (s: State, action: Record<string, unknown>, actor = admin, at = now) => mutate(s, actor, action as never, at);
function setup(approved = true) {
  let s = emptyState();
  for (let i = 1; i <= 3; i++) s = act(s, { type: "resource.save", resource: {
    name: `服务器${i}`, ip: `192.0.2.${i}`, type: "950DT*8卡", accessMode: "bare", status: "available", location: "", note: "",
  } });
  s = act(s, { type: "request.create", resourceIds: s.resources.map(r => r.id), groupId: "g1", purpose: "统一预留", priority: "normal", startAt, endAt }, contact);
  if (approved) s = act(s, { type: "request.review", id: s.requests[0].id, approve: true, note: "原审批说明" });
  return s;
}
const change = (s: State, resourceIds = s.requests[0].resourceIds, extra = {}) => ({
  type: "request.reassign", id: s.requests[0].id, resourceIds, groupId: "g2", purpose: "新训练事项", ...extra,
});

test("whole-request allocation correction preserves approval, identities and occupied intervals", () => {
  const original = setup();
  const s = act(original, change(original));
  assert.equal(s.requests.length, 1);
  assert.deepEqual(s.requests[0], { ...original.requests[0], groupId: "g2", purpose: "新训练事项" });
  assert.deepEqual(s.bookings, original.bookings.map(b => ({ ...b, groupId: "g2", purpose: "新训练事项", updatedAt: now })));
  assert.equal(original.requests[0].groupId, "g1");
  assert.deepEqual([...new Set(activeBookings(s, "2026-10-22T02:00:00.000Z").map(b => b.groupId))], ["g2"]);
  assert.equal(s.audits.at(-1)!.action, "调整使用组与事项");
  assert.equal(JSON.parse(s.audits.at(-1)!.before).request.purpose, "统一预留");
});

test("single and multi-resource splits partition the original request and can be adjusted repeatedly", () => {
  const original = setup();
  const [a, b, c] = original.requests[0].resourceIds;
  let s = act(original, change(original, [a]));
  assert.deepEqual(s.requests[0].resourceIds, [b, c]);
  const child = s.requests[1];
  assert.equal(child.sourceRequestId, original.requests[0].id);
  assert.deepEqual(child, { ...original.requests[0], id: child.id, sourceRequestId: original.requests[0].id, resourceIds: [a], groupId: "g2", purpose: "新训练事项" });
  assert.equal(s.bookings.find(x => x.resourceId === a)!.requestId, child.id);
  assert.deepEqual(s.bookings.filter(x => x.resourceId !== a), original.bookings.filter(x => x.resourceId !== a));
  s = act(s, change(s, [b, c], { groupId: "g3", purpose: "另一组的事项" }));
  assert.equal(s.requests.length, 2);
  assert.deepEqual(s.requests.flatMap(r => r.resourceIds).sort(), [a, b, c].sort());
  assert.equal(s.bookings.length, 3);
  assert.equal(s.requests[0].groupId, "g3");
  assert.equal(s.requests[1].groupId, "g2");
});

test("pending splits retain pending state and can be approved independently without extra reservations", () => {
  const original = setup(false);
  let s = act(original, change(original, original.requests[0].resourceIds.slice(0, 2)));
  assert.equal(s.bookings.length, 0);
  assert(s.requests.every(r => r.status === "pending"));
  for (const r of s.requests) s = act(s, { type: "request.review", id: r.id, approve: true, note: "" });
  assert.equal(s.bookings.length, 3);
  assert.equal(s.bookings.filter(b => b.groupId === "g2").length, 2);
  assert.equal(s.bookings.filter(b => b.groupId === "g1").length, 1);
});

test("partial cancellations retain their gaps, split identities and status after reassignment", () => {
  let original = setup();
  const [id] = original.requests[0].resourceIds;
  original = act(original, { type: "request.cancelPartial", id: original.requests[0].id, resourceIds: [id],
    startAt: "2026-10-22T04:00:00.000Z", endAt: "2026-10-22T06:00:00.000Z", note: "取消中间两小时" });
  const at = "2026-10-22T03:00:00.000Z";
  let s = act(original, change(original, [id]), admin, at);
  const child = s.requests[1];
  assert.deepEqual(s.bookings.filter(b => b.resourceId === id), original.bookings.filter(b => b.resourceId === id)
    .map(b => ({ ...b, requestId: child.id, groupId: "g2", purpose: "新训练事项", updatedAt: at })));
  assert.equal(activeBookings(s, "2026-10-22T05:00:00.000Z").filter(b => b.resourceId === id).length, 0);
  assert.throws(() => act(s, { type: "request.cancel", id: child.id }, contact, at), /只能操作本组/);
  s = act(s, { type: "request.cancel", id: child.id }, { ...contact, groupId: "g2" }, at);
  assert.equal(s.requests[0].status, "approved");
  assert.equal(s.requests[1].status, "cancelled");
  assert.equal(s.bookings.filter(b => b.resourceId !== id && b.status === "scheduled").length, 2);
});

test("preempted intervals are never restored and unrelated bookings keep their allocation", () => {
  let original = setup();
  const id = original.resources[0].id;
  original = act(original, { type: "request.create", resourceIds: [id], groupId: "g3", purpose: "高优任务", priority: "high",
    startAt: "2026-10-22T04:00:00.000Z", endAt: "2026-10-22T06:00:00.000Z" });
  original = act(original, { type: "request.review", id: original.requests[1].id, approve: true, preempt: true, note: "确认抢占" });
  const s = act(original, change(original, [id]));
  assert.equal(s.bookings.filter(b => b.status === "preempted").length, 1);
  assert.deepEqual(s.bookings.filter(b => b.requestId === original.requests[1].id), original.bookings.filter(b => b.requestId === original.requests[1].id));
  assert.deepEqual(activeBookings(s, "2026-10-22T05:00:00.000Z").filter(b => b.resourceId === id).map(b => b.purpose), ["高优任务"]);
});

test("all non-admin roles are rejected and invalid/stale selections are atomic", () => {
  const s = setup(), snapshot = JSON.stringify(s);
  for (const role of ["contact", "member", "visitor"] as const)
    assert.throws(() => act(s, change(s), { ...contact, role }), /仅服务器管理员/);
  for (const action of [change(s, []), change(s, [s.resources[0].id, "outside"]), change(s, undefined, { groupId: "missing" }),
    change(s, undefined, { purpose: " " }), change(s, undefined, { purpose: "字".repeat(1001) }),
    change(s, undefined, { groupId: "g1", purpose: "统一预留" })]) assert.throws(() => act(s, action));
  assert.equal(JSON.stringify(s), snapshot);
  assert.throws(() => act(s, change(s), admin, "2026-10-22T12:00:00.000Z"), /尚未结束/);
  const closed = act(s, { type: "request.cancel", id: s.requests[0].id });
  assert.throws(() => act(closed, change(closed)), /尚未结束/);
  const partial = act(s, { type: "request.cancelPartial", id: s.requests[0].id, resourceIds: [s.resources[0].id], startAt, endAt, note: "全部取消该机器" });
  assert.throws(() => act(partial, change(partial, [s.resources[0].id])), /已无剩余有效预约/);
});

test("split audit snapshots do not expose hidden resources to non-admin users", () => {
  const original = setup();
  original.resources[0].hidden = true;
  const s = act(original, change(original, [original.resources[1].id]));
  const visible = serializePublic(s, { ...contact, role: "visitor" }, now, true);
  assert(!visible.requests.some(r => r.id === original.requests[0].id));
  assert(visible.requests.some(r => r.id === s.requests[1].id));
  assert(!visible.audits.some(a => a.action === "调整使用组与事项"));
});
