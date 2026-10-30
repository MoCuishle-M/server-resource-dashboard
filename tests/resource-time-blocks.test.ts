import { test } from "node:test";
import assert from "node:assert/strict";
import { activeBookings, emptyState, groupUsage, mutate, serializePublic } from "../lib/domain";
import { bookingAvailability, requestPriorityPreview } from "../lib/priority";
import { overlappingTimeBlocks } from "../lib/resource-time-blocks";
import { layoutTimeBlocks } from "../lib/schedule";
import { checkTablePlan, recommendTableRows } from "../lib/weekly-table";
import type { Actor, State, WeeklyPlan } from "../lib/types";
const at = (hour: number) => new Date(Date.UTC(2026, 9, 30, hour)).toISOString();
const now = at(0);
const admin: Actor = { userId: "admin", role: "admin", displayName: "管理员", email: "admin@test", groupId: "g1", employeeId: "" };
const contact: Actor = { ...admin, userId: "contact", role: "contact" };
const act = (s: State, action: { type: string; [key: string]: unknown }, who = admin, time = now) => mutate(s, who, action, time);
function setup(shared = false) {
  let s = emptyState();
  for (let i = 1; i <= 2; i++) s = act(s, { type: "resource.save", resource: { name: `服务器${i}`, ip: `192.0.2.${i}`, type: "910B", accessMode: "bare", sharingMode: shared ? "shared" : "exclusive", status: "available" } });
  s = act(s, { type: "request.create", resourceIds: s.resources.map(r => r.id), groupId: "g1", startAt: at(1), endAt: at(7), purpose: "训练", priority: "urgent" });
  return act(s, { type: "request.review", id: s.requests[0].id, approve: true });
}
const mark = (s: State, extra = {}) => ({ type: "resource.timeBlock.save", resourceIds: [s.resources[0].id], kind: "emergency", label: "客户现场问题定位", startAt: at(3), endAt: at(5), confirmImpact: true, ...extra });
const request = (s: State, startAt = at(3), endAt = at(4)) => ({ type: "request.create", resourceIds: [s.resources[0].id], groupId: "g2", startAt, endAt, purpose: "新任务", priority: "urgent" });

test("whole-day annotations retain the requested display start without rewriting elapsed usage", () => {
  const original = setup();
  let s = act(original, mark(original, { startAt: now, endAt: at(9), label: "被上级抽调" }), admin, at(4));
  const block = s.resources[0].timeBlocks![0];
  assert.equal(block.displayStartAt, now);
  assert.equal(block.startAt, at(4));
  assert.equal(groupUsage(s, "g1", at(4)).hours, groupUsage(original, "g1", at(4)).hours);
  assert.equal(activeBookings(s, at(2)).length, 2);
  assert.equal(activeBookings(s, at(5)).length, 1);
  assert.equal(layoutTimeBlocks([block], { startAt: now, endAt: at(12) }).bars[0].booking.startAt, now);
  s = act(s, { type: "resource.timeBlock.cancel", resourceId: s.resources[0].id, id: block.id, note: "抽调结束" }, admin, at(6));
  assert.equal(activeBookings(s, at(6)).length, 2);
  assert.equal(s.resources[0].timeBlocks![0].displayStartAt, now);
  assert.equal(groupUsage(s, "g1", at(7)).hours, 10);
});

test("timed blocks require admin, valid times, custom emergency label and impact acknowledgement", () => {
  const s = setup();
  for (const who of [contact, { ...contact, role: "member" as const }, { ...contact, role: "visitor" as const }]) assert.throws(() => act(s, mark(s), who), /仅服务器管理员/);
  for (const change of [{ kind: "other" }, { label: " " }, { label: "x".repeat(201) }, { startAt: "invalid" }, { endAt: at(3) }, { endAt: now }]) assert.throws(() => act(s, mark(s, change)));
  assert.throws(() => act(s, mark(s, { confirmImpact: false })), /请确认暂停/);
  assert.equal(s.resources[0].timeBlocks, undefined);
});

for (const shared of [false, true]) test(`blocks suspend even urgent reservations, preserve history and restore automatically (${shared ? "shared" : "exclusive"})`, () => {
  const original = setup(shared), s = act(original, mark(original));
  assert.deepEqual(s.bookings, original.bookings);
  assert.deepEqual(s.requests, original.requests);
  assert.equal(activeBookings(s, at(2)).length, 2);
  assert.equal(activeBookings(s, at(3)).length, 1);
  assert.equal(activeBookings(s, at(5)).length, 2);
  assert.equal(groupUsage(s, "g1", at(7)).hours, 10);
  const segments = bookingAvailability(s.bookings[0], s.bookings, shared, s.resources[0].timeBlocks);
  assert.deepEqual(segments.map(x => [x.startAt, x.endAt, x.blockedByTimeBlocks.length]), [[at(1), at(3), 0], [at(3), at(5), 1], [at(5), at(7), 0]]);
  assert.equal(requestPriorityPreview(s.resources[0], s.bookings, { startAt: at(3), endAt: at(4) }, "urgent")!.timeBlocks.length, 1);
});

test("requests, late approval and both extension paths recheck blocks, including boundary adjacency", () => {
  let s = setup();
  s = act(s, request(s));
  const id = s.requests[1].id;
  s = act(s, mark(s));
  assert.throws(() => act(s, request(s), contact), /紧急占用/);
  assert.throws(() => act(s, { type: "request.review", id, approve: true, preempt: true, note: "强行抢占" }), /紧急占用/);
  assert.doesNotThrow(() => act(s, request(s, at(5), at(6))));
  assert.doesNotThrow(() => act(s, request(s, at(2), at(3))));
  s = setup();
  s = act(s, { type: "request.extend", id: s.requests[0].id, endAt: at(9) }, contact);
  s = act(s, mark(s, { startAt: at(7), endAt: at(8), kind: "upgrade", label: "CANN更新" }));
  assert.throws(() => act(s, { type: "request.extend", id: s.requests[0].id, endAt: at(9) }), /正在升级/);
  assert.throws(() => act(s, { type: "request.reviewExtension", id: s.requests[0].id, extensionId: s.requests[0].pendingExtension!.id, approve: true }), /正在升级/);
});

test("bulk marking is atomic, overlaps rejected, normal edits cannot erase or inject markers", () => {
  const original = setup();
  const s = act(original, mark(original, { resourceIds: original.resources.map(r => r.id), kind: "upgrade", label: "" }));
  assert(s.resources.every(r => r.timeBlocks?.length === 1));
  assert.throws(() => act(s, mark(s)), /重叠时段标记/);
  const snapshot = JSON.stringify(s);
  assert.throws(() => act(s, mark(s, { resourceIds: [s.resources[1].id, "missing"], startAt: at(8), endAt: at(9) })), /不存在/);
  assert.equal(JSON.stringify(s), snapshot);
  const saved = act(s, { type: "resource.save", id: s.resources[0].id, resource: { ...s.resources[0], note: "更新备注", timeBlocks: [] } });
  assert.deepEqual(saved.resources[0].timeBlocks, s.resources[0].timeBlocks);
  const imported = act(saved, { type: "resource.bulkUpdate", ids: saved.resources.map(r => r.id), changes: { rack: "A01" } });
  assert.deepEqual(imported.resources.map(r => r.timeBlocks), s.resources.map(r => r.timeBlocks));
});

test("editing running markers and early release preserve elapsed blocked usage", () => {
  let s = setup(); s = act(s, mark(s));
  const first = s.resources[0].timeBlocks![0];
  s = act(s, mark(s, { id: first.id, startAt: at(3), endAt: at(6), label: "升级定位", kind: "upgrade" }), admin, at(4));
  assert.equal(s.resources[0].timeBlocks!.length, 2);
  assert.equal(s.resources[0].timeBlocks![0].endAt, at(4));
  assert.equal(s.resources[0].timeBlocks![1].startAt, at(4));
  const block = s.resources[0].timeBlocks![1];
  assert.throws(() => act(s, { type: "resource.timeBlock.cancel", resourceId: s.resources[0].id, id: block.id, note: "" }, admin, at(5)), /解除原因/);
  s = act(s, { type: "resource.timeBlock.cancel", resourceId: s.resources[0].id, id: block.id, note: "升级完成" }, admin, at(5));
  assert.equal(activeBookings(s, at(5)).length, 2);
  assert.equal(groupUsage(s, "g1", at(7)).hours, 10);
  assert.equal(s.resources[0].timeBlocks![1].endAt, at(5));
});

test("future cancellation restores availability and nonadmins cannot read hidden-server markers", () => {
  let s = setup(); s = act(s, mark(s));
  const id = s.resources[0].id, block = s.resources[0].timeBlocks![0];
  const cancel = { type: "resource.timeBlock.cancel", resourceId: id, id: block.id, note: "临时取消" };
  assert.throws(() => act(s, cancel, contact), /仅服务器管理员/);
  s = act(s, cancel);
  assert.equal(overlappingTimeBlocks(s.resources[0], { startAt: at(3), endAt: at(5) }).length, 0);
  assert.equal(layoutTimeBlocks(s.resources[0].timeBlocks!, { startAt: at(2), endAt: at(6) }).bars.length, 0);
  s = act(s, { type: "resource.save", id, resource: { ...s.resources[0], hidden: true } });
  assert(!serializePublic(s, { ...contact, role: "visitor" }, now, true).resources.some(r => r.id === id));
});

test("time block layout clips correctly and weekly validation and recommendations respect marked windows", () => {
  let s = setup(); s = act(s, mark(s));
  const block = s.resources[0].timeBlocks![0];
  const layout = layoutTimeBlocks([block], { startAt: at(4), endAt: at(6) });
  assert.equal(layout.bars[0].left, 0);
  assert.equal(layout.bars[0].width, 50);
  assert.equal(layout.bars[0].continuesBefore, true);
  s.bookings = []; s.requests = [];
  const p: WeeklyPlan = { id: "week", layout: "table", resourceIds: s.resources.map(r => r.id), weekStart: "2026-10-26", status: "draft", allocations: [], rows: [{ resourceId: s.resources[0].id, assignments: [{ groupId: "g1", purpose: "周任务" }], specialNote: "" }, { resourceId: s.resources[1].id, assignments: [], specialNote: "" }], deferred: [], confirmations: [], createdAt: now, updatedAt: now, publishedAt: "" };
  assert(checkTablePlan(s, p, now).some(x => /紧急占用/.test(x.message)));
  s.weeklyPlans.push(p);
  p.rows![0].assignments = [];
  s.weeklyDemands.push({ id: "d", planId: p.id, groupId: "g1", title: "周任务", category: "model", reason: "", deadline: at(10), expectedStart: at(1), expectedEnd: at(7), continuousHours: 1, timeNote: "", holdMode: "week", shareWithDemandIds: [], shareNote: "", table: true, lines: [{ id: "l", resourceType: "910B", zone: "green", family: "A3", accessMode: "bare", desired: 1, minimum: 1, negotiated: 1, mode: "single", rackPolicy: "any", preferredResourceIds: [], shareCount: 0 }], status: "active", createdAt: now, updatedAt: now });
  assert.equal(recommendTableRows(s, p)[0].assignments.length, 0);
  assert.equal(recommendTableRows(s, p)[1].assignments.length, 1);
});
