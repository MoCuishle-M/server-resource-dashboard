import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyState, mutate, serializePublic, groupUsage, currentResourceUsage } from "../lib/domain";
import { importRows } from "../lib/csv";
import type { Actor, State } from "../lib/types";

const now = "2026-10-21T00:00:00.000Z";
const admin: Actor = { userId: "admin", displayName: "管理员", email: "admin@test", role: "admin", groupId: "", employeeId: "" };
const contact: Actor = { ...admin, userId: "contact", role: "contact", groupId: "g1" };
const apply = (s: State, a: Record<string, unknown>, who = admin) => mutate(s, who, a as never, now);
const row = { name: "公开服务器", type: "公共8卡", ip: "192.0.2.201", accessMode: "bare", sharingMode: "exclusive", location: "机房", note: "", status: "available" };
function setup() {
  let s = apply(emptyState(), { type: "resource.save", resource: row });
  s = apply(s, { type: "resource.save", resource: { ...row, name: "隐藏专用服务器", type: "机密类型", ip: "192.0.2.202", location: "机密位置", note: "机密备注" } });
  return s;
}
function request(s: State, resourceIds: string[], purpose = "训练任务") {
  return apply(s, { type: "request.create", groupId: "g1", resourceIds, startAt: "2026-10-21T01:00:00.000Z", endAt: "2026-10-21T11:00:00.000Z", purpose, priority: "normal" });
}
test("unavailable resources reject applications/approval and changing booked servers is atomic", () => {
  let s = setup();
  s = request(s, [s.resources[0].id]);
  const pendingId = s.requests[0].id;
  s = apply(s, { type: "resource.bulkUpdate", ids: [s.resources[0].id], changes: { status: "unavailable", hidden: true } });
  assert.equal(s.resources[0].status, "unavailable");
  assert.equal(s.resources[0].hidden, true);
  assert.throws(() => request(s, [s.resources[0].id]), /不可用/);
  assert.throws(() => apply(s, { type: "request.review", id: pendingId, approve: true }), /不可用/);
  s = apply(s, { type: "resource.bulkUpdate", ids: [s.resources[0].id], changes: { status: "available", hidden: false } });
  s = apply(s, { type: "request.review", id: pendingId, approve: true });
  const before = structuredClone(s);
  assert.throws(() => apply(s, { type: "resource.bulkUpdate", ids: s.resources.map(r => r.id), changes: { status: "unavailable", hidden: true } }), /有效预约/);
  assert.deepEqual(s, before);
  assert.throws(() => apply(s, { type: "resource.bulkUpdate", ids: [s.resources[1].id], changes: { hidden: "true" } }), /隐藏设置/);
});
test("server serialization hides inventory, mixed requests and related audits for all non-admin roles", () => {
  let s = setup();
  s = request(s, s.resources.map(r => r.id), "隐藏专用服务器联合任务");
  const mixed = s.requests[0].id;
  s = apply(s, { type: "request.review", id: mixed, approve: true, note: "隐藏专用服务器审批说明" });
  s = request(s, [s.resources[1].id], "隐藏专用服务器待审批");
  s = apply(s, { type: "resource.bulkUpdate", ids: s.resources.map(r => r.id), changes: { note: "机密批量备注" } });
  s = apply(s, { type: "resource.bulkUpdate", ids: [s.resources[1].id], changes: { hidden: true } });
  const secret = s.resources[1];
  for (const actor of [contact, { ...contact, role: "member" as const }, { ...contact, role: "visitor" as const, userId: "", groupId: "" }]) {
    const visible = serializePublic(s, actor, now, true);
    const json = JSON.stringify(visible);
    // Deliberate sensitive values also appear in mixed request descriptions and audit payloads.
    for (const value of [secret.id, secret.ip, secret.name, secret.type, secret.location, "机密备注", "隐藏专用服务器审批说明"])
      assert(!json.includes(value), `leaked ${value} for ${actor.role}`);
    assert.equal(visible.resources.length, 1);
    assert.equal(visible.requests.length, 0);
    assert.equal(visible.bookings.length, 1);
    assert.equal(visible.bookings[0].purpose, "资源使用预约");
    assert.equal(currentResourceUsage(visible, s.resources[0].id, "2026-10-21T02:00:00.000Z").bookings.length, 1);
    assert.equal(groupUsage(visible, "g1", "2026-10-21T02:00:00.000Z").hours, 1);
    assert(visible.audits.every(a => !a.entityId.split(",").includes(secret.id)));
  }
  const full = serializePublic(s, admin, now, true);
  assert.equal(full.resources.length, 2);
  assert.equal(full.requests.length, 2);
  assert.equal(full.bookings.length, 2);
  assert.deepEqual(full.audits, s.audits);
  assert.throws(() => apply(s, { type: "request.cancel", id: mixed }, contact), /管理员处理/);
  assert.throws(() => apply(s, { type: "request.cancelPartial", id: mixed, resourceIds: [s.resources[0].id], startAt: "2026-10-21T02:00:00.000Z", endAt: "2026-10-21T03:00:00.000Z", note: "越权调整" }, contact), /管理员处理/);
  assert.throws(() => apply(s, { type: "request.create", resourceIds: [secret.id], startAt: "2026-10-21T02:00:00.000Z", endAt: "2026-10-21T03:00:00.000Z", purpose: "伪造IP搜索结果", priority: "normal" }, contact), /不存在或不可见/);
  s = apply(s, { type: "resource.bulkUpdate", ids: [secret.id], changes: { hidden: false } });
  assert.equal(serializePublic(s, contact, now, true).requests.length, 2);
  assert.equal(serializePublic(s, contact, now, true).bookings.length, 2);
});
test("CSV/Excel rows support unavailable and boolean visibility; blanks preserve existing values", () => {
  const added = importRows("名称,类型,IP,使用方式,状态,隐藏\n测试服务器,8卡,192.0.2.210,裸机,不可用,是");
  assert.equal(added[0].status, "unavailable");
  assert.equal(added[0].hidden, true);
  const s = apply(emptyState(), { type: "resource.import", rows: added });
  assert.equal(serializePublic(s, contact, now, true).resources.length, 0);
  const updates = importRows("IP,隐藏,状态\n192.0.2.210,否,可申请", "update");
  const next = apply(s, { type: "resource.updateByIp", rows: updates });
  assert.equal(next.resources[0].hidden, false);
  assert.equal(next.resources[0].status, "available");
  const blank = importRows("IP,隐藏,状态,备注\n192.0.2.210,,,保留状态与隐藏设置", "update");
  assert.equal(blank[0].hidden, undefined);
  assert.equal(blank[0].status, undefined);
  assert.throws(() => importRows("名称,类型,IP,使用方式,隐藏\n测试,8卡,192.0.2.211,裸机,也许"), /隐藏/);
  assert.throws(() => apply(s, { type: "resource.save", resource: { ...row, ip: "192.0.2.212", hidden: "false" } }), /隐藏设置/);
});
