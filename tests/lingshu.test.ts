import test from "node:test";
import assert from "node:assert/strict";
import { emptyState, mutate, groupUsage } from "../lib/domain";
import { PLATFORM_GROUP_ID, resourceLingshuLabel, lingshuStatusLabels } from "../lib/lingshu";
import { importRows } from "../lib/csv";
import type { Actor } from "../lib/types";
const admin: Actor = { userId: "a", displayName: "管理员", email: "a@example.test", role: "admin", groupId: "", employeeId: "" };
const now = "2026-10-21T00:00:00.000Z";
const resource = { name: "灵枢测试", type: "950DT", ip: "192.0.2.100", accessMode: "lingshu", status: "available", sharingMode: "shared" };
const apply = (s: ReturnType<typeof emptyState>, action: Parameters<typeof mutate>[2], actor = admin) => mutate(s, actor, action, now);
test("Lingshu resources default to direct platform usage and validate all three statuses", () => {
  for (const status of Object.keys(lingshuStatusLabels)) {
    const s = apply(emptyState(), { type: "resource.save", resource: { ...resource, lingshuStatus: status } });
    assert.equal(s.resources[0].lingshuStatus, status);
    assert.equal(resourceLingshuLabel(s.resources[0]), lingshuStatusLabels[status as keyof typeof lingshuStatusLabels]);
  }
  const s = apply(emptyState(), { type: "resource.save", resource });
  assert.equal(s.resources[0].lingshuStatus, "platform");
  assert.throws(() => apply(s, { type: "resource.save", id: s.resources[0].id, resource: { ...resource, lingshuStatus: "invalid" } }), /状态不正确/);
  assert.throws(() => apply(emptyState(), { type: "resource.save", resource: { ...resource, accessMode: "bare", lingshuStatus: "ticket" } }), /仅适用于/);
});
test("bulk status edits are atomic and changing back to bare clears platform-only data", () => {
  let s = apply(emptyState(), { type: "resource.import", rows: [resource, { ...resource, name: "裸机测试", ip: "192.0.2.101", accessMode: "bare" }] });
  const before = structuredClone(s);
  assert.throws(() => apply(s, { type: "resource.bulkUpdate", ids: s.resources.map(r => r.id), changes: { lingshuStatus: "ticket" } }), /仅适用于/);
  assert.deepEqual(s, before);
  s = apply(s, { type: "resource.bulkUpdate", ids: s.resources.map(r => r.id), changes: { accessMode: "lingshu", lingshuStatus: "pool_platform" } });
  assert(s.resources.every(r => r.lingshuStatus === "pool_platform"));
  s = apply(s, { type: "resource.bulkUpdate", ids: s.resources.map(r => r.id), changes: { accessMode: "bare" } });
  assert(s.resources.every(r => r.accessMode === "bare" && !r.lingshuStatus));
});
test("table import supports platform status column and the three labels in the status column", () => {
  for (const label of Object.values(lingshuStatusLabels)) {
    const rows = importRows(`名称,类型,IP,使用方式,状态\n测试,950DT,192.0.2.100,灵枢平台,${label}`);
    const s = apply(emptyState(), { type: "resource.import", rows });
    assert.equal(resourceLingshuLabel(s.resources[0]), label);
    assert.equal(s.resources[0].status, "available");
  }
  const rows = importRows("IP,灵枢平台状态\n192.0.2.100,通过工单占用", "update");
  const s = apply(emptyState(), { type: "resource.save", resource });
  assert.equal(apply(s, { type: "resource.updateByIp", rows }).resources[0].lingshuStatus, "ticket");
  assert.throws(() => importRows("名称,类型,IP,使用方式,灵枢平台状态\n测试,950DT,192.0.2.100,裸机,通过工单占用"), /裸机/);
  assert.throws(() => importRows("IP,状态,灵枢平台状态\n192.0.2.100,通过工单占用,通过灵枢平台使用", "update"), /不一致/);
});
test("ten regular groups and the platform participant can book independently with contact scope enforced", () => {
  let s = apply(emptyState(), { type: "resource.save", resource });
  assert.equal(s.groups.filter(g => g.id !== PLATFORM_GROUP_ID).length, 10);
  assert.equal(s.groups.find(g => g.id === PLATFORM_GROUP_ID)!.name, "灵枢平台");
  const request = { type: "request.create", groupId: PLATFORM_GROUP_ID, resourceIds: [s.resources[0].id], startAt: "2026-10-21T01:00:00.000Z", endAt: "2026-10-21T04:00:00.000Z", purpose: "平台排期", priority: "normal" };
  s = apply(s, request);
  assert.equal(s.requests.at(-1)!.groupId, PLATFORM_GROUP_ID);
  s = apply(s, { type: "request.review", id: s.requests.at(-1)!.id, approve: true });
  assert.equal(s.bookings[0].groupId, PLATFORM_GROUP_ID);
  assert.equal(groupUsage(s, PLATFORM_GROUP_ID, "2026-10-21T02:00:00.000Z").count, 1);
  const contact = { ...admin, userId: "c", role: "contact" as const, groupId: "g1" };
  const own = apply(s, request, contact);
  assert.equal(own.requests.at(-1)!.groupId, "g1");
  const platformContact = { ...contact, groupId: PLATFORM_GROUP_ID };
  assert.equal(apply(s, request, platformContact).requests.at(-1)!.groupId, PLATFORM_GROUP_ID);
  assert.throws(() => apply(s, { type: "group.save", id: PLATFORM_GROUP_ID, name: "改名" }), /名称固定/);
});
