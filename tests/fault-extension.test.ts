import { test } from "node:test";
import assert from "node:assert/strict";
import { activeBookings, emptyState, mutate } from "../lib/domain";
import { importRows } from "../lib/csv";
import { resourceSearch } from "../lib/resource-search";
import type { Actor, State } from "../lib/types";
const now = "2026-10-22T00:00:00.000Z", startAt = "2026-10-22T01:00:00.000Z", endAt = "2026-10-22T04:00:00.000Z", extended = "2026-10-22T06:00:00.000Z";
const admin: Actor = { userId: "admin", role: "admin", displayName: "管理员", email: "a@example.test", groupId: "g1", employeeId: "" };
const contact: Actor = { ...admin, role: "contact", userId: "contact", displayName: "接口人" };
const act = (s: State, action: Record<string, unknown>, who = admin, at = now) => mutate(s, who, action as never, at);
function setup(shared = false) {
  let s = emptyState();
  for (let i = 1; i <= 2; i++) s = act(s, { type: "resource.save", resource: {
    name: `服务器${i}`, ip: `192.0.2.${i}`, type: "950DT*8卡", accessMode: "bare", status: "available", sharingMode: shared ? "shared" : "exclusive", location: "", note: "",
  } });
  s = act(s, { type: "request.create", resourceIds: s.resources.map(r => r.id), groupId: "g1", startAt, endAt, purpose: "训练", priority: "normal" }, contact);
  return act(s, { type: "request.review", id: s.requests[0].id, approve: true, note: "原批准" });
}
const extension = (s: State, extra = {}) => ({ type: "request.extend", id: s.requests[0].id, endAt: extended, note: "训练需要更多时间", ...extra });
const review = (s: State, extra = {}) => ({ type: "request.reviewExtension", id: s.requests[0].id, extensionId: s.requests[0].pendingExtension!.id, approve: true, ...extra });

test("fault marking requires a description, keeps occupied reservations intact, and can recover directly", () => {
  const original = setup();
  const id = original.resources[0].id;
  let s = act(original, { type: "resource.fault", id, description: "3号卡掉卡\n网络间歇中断" });
  assert.equal(s.resources[0].status, "fault");
  assert.equal(s.resources[0].faultDescription, "3号卡掉卡\n网络间歇中断");
  assert.deepEqual(s.requests, original.requests);
  assert.deepEqual(s.bookings, original.bookings);
  assert.equal(s.audits.at(-1)!.action, "标记服务器故障");
  assert.throws(() => act(original, { type: "resource.fault", id, description: " " }), /故障说明/);
  assert.throws(() => act(original, { type: "resource.fault", id, description: "故障" }, contact), /仅服务器管理员/);
  assert.throws(() => act(s, { type: "request.create", resourceIds: [id], groupId: "g1", startAt: endAt, endAt: extended, purpose: "新任务", priority: "normal" }), /不可用/);
  s = act(s, { type: "resource.recover", id });
  assert.equal(s.resources[0].status, "available");
  assert.equal(s.resources[0].faultDescription, undefined);
  assert.deepEqual(s.bookings, original.bookings);
});
test("fault state supports bulk/import paths and searchable fault descriptions", () => {
  const original = setup();
  const s = act(original, { type: "resource.bulkUpdate", ids: original.resources.map(r => r.id), changes: { status: "fault", faultDescription: "NPU掉卡" } });
  assert(s.resources.every(r => r.status === "fault"));
  assert.deepEqual(s.bookings, original.bookings);
  assert(resourceSearch("NPU掉卡")(s.resources[0]));
  const rows = importRows("IP,状态,故障说明\n192.0.2.1,故障中,无法开机", "update");
  const updated = act(original, { type: "resource.updateByIp", rows });
  assert.equal(updated.resources[0].faultDescription, "无法开机");
  assert.throws(() => act(original, { type: "resource.bulkUpdate", ids: original.resources.map(r => r.id), changes: { status: "maintenance" } }), /有效预约/);
});
test("admin extension updates the same request and booking ends immediately, with approval retained", () => {
  const original = setup(), s = act(original, extension(original));
  assert.equal(s.requests.length, 1);
  assert.equal(s.requests[0].endAt, extended);
  assert.equal(s.requests[0].reviewNote, "原批准");
  assert.equal(s.requests[0].reviewedAt, original.requests[0].reviewedAt);
  assert.deepEqual(s.bookings.map(b => b.id), original.bookings.map(b => b.id));
  assert(s.bookings.every(b => b.endAt === extended));
  assert.match(s.audits.at(-1)!.summary, /训练需要更多时间/);
  assert.equal(original.requests[0].endAt, endAt);
});
test("contact renewal stays pending until admin approval, rejecting and retrying preserves old reservations", () => {
  const original = setup();
  let s = act(original, extension(original), contact);
  assert.equal(s.requests[0].endAt, endAt);
  assert.deepEqual(s.bookings, original.bookings);
  assert.equal(s.requests[0].pendingExtension!.endAt, extended);
  assert.throws(() => act(s, extension(s), contact), /已有待审批/);
  assert.throws(() => act(s, review(s), contact), /仅服务器管理员/);
  assert.throws(() => act(s, review(s, { extensionId: "old" })), /发生变化/);
  assert.throws(() => act(s, review(s, { approve: false })), /填写原因/);
  s = act(s, review(s, { approve: false, note: "稍后再续" }));
  assert(!s.requests[0].pendingExtension);
  assert.equal(s.requests[0].endAt, endAt);
  s = act(s, extension(s), contact);
  s = act(s, review(s));
  assert.equal(s.requests[0].endAt, extended);
  assert(!s.requests[0].pendingExtension);
  assert(s.bookings.every(b => b.endAt === extended));
});
test("new conflicting reservations are checked again at renewal approval, with no partial writes", () => {
  let s = setup();
  s = act(s, extension(s), contact);
  s = act(s, { type: "request.create", resourceIds: [s.resources[0].id], groupId: "g2", startAt: endAt, endAt: extended, priority: "normal", purpose: "下一组" });
  s = act(s, { type: "request.review", id: s.requests[1].id, approve: true });
  const snapshot = JSON.stringify(s);
  assert.throws(() => act(s, review(s)), /延长时段已有预约/);
  assert.equal(JSON.stringify(s), snapshot);
  assert.throws(() => act(s, extension(s)), /延长时段已有预约/);
});
test("late renewal approval creates only a remaining segment, leaving an elapsed gap unchanged", () => {
  let s = setup();
  s = act(s, extension(s), contact);
  const at = "2026-10-22T05:00:00.000Z";
  s = act(s, review(s), admin, at);
  assert.equal(s.requests[0].endAt, extended);
  assert.equal(s.bookings.filter(b => b.endAt === endAt).length, 2);
  assert.equal(s.bookings.filter(b => b.startAt === at && b.endAt === extended).length, 2);
  assert.equal(activeBookings(s, "2026-10-22T04:30:00.000Z").length, 0);
});
test("partial cancellations are not restored and non-available machines are excluded from a new renewal", () => {
  let s = setup();
  const first = s.resources[0].id;
  s = act(s, { type: "request.cancelPartial", id: s.requests[0].id, resourceIds: [first], startAt: "2026-10-22T02:00:00.000Z", endAt, note: "提前取消末段" });
  const oldFirst = structuredClone(s.bookings.filter(b => b.resourceId === first));
  s = act(s, extension(s));
  assert.deepEqual(s.bookings.filter(b => b.resourceId === first), oldFirst);
  assert.equal(s.bookings.find(b => b.resourceId !== first)!.endAt, extended);
  s = setup();
  s = act(s, { type: "resource.fault", id: s.resources[0].id, description: "硬盘故障" });
  s = act(s, extension(s));
  assert.equal(s.bookings[0].endAt, endAt);
  assert.equal(s.bookings[1].endAt, extended);
});
test("fault during pending renewal blocks approval; cancellation clears pending renewal and ownership is enforced", () => {
  let s = setup();
  assert.throws(() => act(s, extension(s), { ...contact, groupId: "g2" }), /只能操作本组/);
  for (const role of ["member", "visitor"] as const) assert.throws(() => act(s, extension(s), { ...contact, role }), /通过组接口人/);
  assert.throws(() => act(s, extension(s, { endAt })), /新的结束时间/);
  s = act(s, extension(s), contact);
  assert.throws(() => act(s, { type: "request.reassign", id: s.requests[0].id, resourceIds: [s.resources[0].id], groupId: "g2", purpose: "分配" }), /先处理待审批续期/);
  s = act(s, { type: "resource.fault", id: s.resources[0].id, description: "NPU故障" });
  assert.throws(() => act(s, review(s)), /无法续期/);
  s = act(s, { type: "request.cancel", id: s.requests[0].id }, contact);
  assert(!s.requests[0].pendingExtension);
});
test("shared servers allow nonexclusive renewal, but extension never changes priority or sharing mode", () => {
  let s = setup(true);
  s = act(s, { type: "request.create", resourceIds: [s.resources[0].id], groupId: "g2", startAt: endAt, endAt: extended, priority: "normal", purpose: "共享任务" });
  s = act(s, { type: "request.review", id: s.requests[1].id, approve: true });
  s = act(s, extension(s));
  assert.equal(s.requests[0].priority, "normal");
  assert(s.resources.every(r => r.sharingMode === "shared"));
});
