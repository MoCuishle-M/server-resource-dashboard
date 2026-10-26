import { request } from "playwright";
import assert from "node:assert/strict";
const base = "http://127.0.0.1:5173"; // Fixed loopback: never exercises production records.
const client = await request.newContext(), visitor = await request.newContext();
let state, resourceId;
try {
  await client.get(base + "/signin-with-chatgpt?return_to=/");
  state = await (await client.get(base + "/api/state")).json();
  assert.equal(state.actor.role, "admin");
  async function action(a, expected = 200) {
    const r = await client.post(base + "/api/action", { headers: { Origin: base }, data: { ...a, revision: a.revision ?? state.revision } });
    const data = await r.json(); assert.equal(r.status(), expected, JSON.stringify(data));
    if (expected === 200) state = data;
    return data;
  }
  let monday = new Date("2030-01-07T00:00:00+08:00");
  while (state.weeklyPlans.some(p => p.weekStart === new Date(monday.getTime() + 8 * 3600000).toISOString().slice(0, 10))) monday = new Date(monday.getTime() + 7 * 86400000);
  const weekStart = new Date(monday.getTime() + 8 * 3600000).toISOString().slice(0, 10);
  const suffix = Date.now(), title = `QA周需求-${suffix}`, name = `QA周服务器-${suffix}`;
  await action({ type: "resource.save", resource: { name, ip: `2001:db8:100::${suffix.toString(16).match(/.{1,4}/g).join(":")}`, type: "QA周排期", zone: "green", family: "A3", rack: "QA01", location: "本地QA", accessMode: "bare", sharingMode: "exclusive", status: "available", note: "" } });
  resourceId = state.resources.find(r => r.name === name).id;
  await action({ type: "weekly.create", weekStart });
  const planId = state.weeklyPlans.find(p => p.weekStart === weekStart).id;
  await action({ type: "weekly.demand.save", planId, demand: {
    groupId: "g1", title, category: "ticket", reason: "本地API专用私有理由", deadline: new Date(monday.getTime() + 6 * 86400000).toISOString(),
    expectedStart: new Date(monday.getTime() + 9 * 3600000).toISOString(), expectedEnd: new Date(monday.getTime() + 2 * 86400000).toISOString(),
    holdMode: "week", continuousHours: 24, timeNote: "", shareNote: "", shareWithDemandIds: [],
    lines: [{ id: "line", zone: "green", family: "A3", accessMode: "bare", desired: 1, minimum: 1, mode: "single", rackPolicy: "any", preferredResourceIds: [resourceId], shareCount: 0 }],
  } });
  const demand = state.weeklyDemands.find(d => d.planId === planId);
  let publicState = await (await visitor.get(base + "/api/state")).json();
  assert.ok(!JSON.stringify(publicState).includes(title));
  const forged = await visitor.post(base + "/api/action", { headers: { Origin: base }, data: { type: "weekly.stage", planId, status: "draft", revision: state.revision } });
  assert.equal(forged.status(), 401);
  const stale = state.revision;
  await action({ type: "weekly.stage", planId, status: "draft" });
  await action({ type: "weekly.assign", planId, demandId: demand.id, lineId: "line", resourceIds: [resourceId], sharedResourceIds: [], locked: true, note: "本地API校验" });
  await action({ type: "weekly.stage", planId, status: "confirming" });
  await action({ type: "weekly.publish", planId }, 409);
  await action({ type: "weekly.confirm", planId, groupId: "g1", status: "confirmed", note: "本地测试代录确认" });
  await action({ type: "weekly.publish", planId });
  const persisted = await (await client.get(base + "/api/state")).json();
  assert.equal(persisted.weeklyPlans.find(p => p.id === planId).status, "published");
  assert.equal(persisted.requests.filter(r => r.weeklyPlanId === planId).length, 1);
  publicState = await (await visitor.get(base + "/api/state")).json();
  assert.ok(publicState.weeklyDemands.some(d => d.title === title));
  assert.ok(!JSON.stringify(publicState).includes("本地API专用私有理由"));
  await action({ type: "weekly.publish", planId }, 409);
  await action({ type: "weekly.stage", planId, status: "draft", revision: stale }, 409);
  const tableWeek = new Date(monday.getTime() + 7 * 86400000 + 8 * 3600000).toISOString().slice(0, 10);
  await action({ type: "weekly.table.create", weekStart: tableWeek });
  const tablePlan = state.weeklyPlans.find(p => p.weekStart === tableWeek).id;
  await action({ type: "weekly.table.pool", planId: tablePlan, resourceIds: [resourceId] });
  const tableTitle = `表格私有需求-${suffix}`;
  await action({ type: "weekly.table.demand", planId: tablePlan, demand: { groupId: "g1", title: tableTitle, applicantName: "本地申请人", lines: [{ resourceType: "QA周排期", accessMode: "bare", desired: 1, negotiated: 1, shareCount: 0, sameRackCount: 1, sameRackGroupIds: [], requirements: "同柜验证" }] } });
  await action({ type: "weekly.table.recommend", planId: tablePlan });
  publicState = await (await visitor.get(base + "/api/state")).json(); assert.ok(!JSON.stringify(publicState).includes(tableTitle));
  const constant = [{ resourceId, assignments: [{ groupId: "g1", purpose: "常态" }], specialNote: "每天北京时间6–8点冒烟，失败最高优先级" }];
  await action({ type: "weekly.table.defaults", resourceIds: [resourceId], rows: constant });
  publicState = await (await visitor.get(base + "/api/state")).json(); assert.equal(publicState.settings.weeklyDefaults, undefined);
  await action({ type: "weekly.table.stage", planId: tablePlan, status: "confirming" });
  await action({ type: "weekly.table.publish", planId: tablePlan }, 409);
  await action({ type: "weekly.table.confirm", planId: tablePlan, groupId: "g1", status: "confirmed", note: "会议确认代录" });
  await action({ type: "weekly.table.publish", planId: tablePlan });
  publicState = await (await visitor.get(base + "/api/state")).json(); assert.ok(publicState.weeklyPlans.find(p => p.id === tablePlan).rows.some(r => r.assignments.length === 1));
  const unauthorizedClear = await visitor.post(base + "/api/action", { headers: { Origin: base }, data: { type: "weekly.table.clear", resourceIds: [resourceId], reason: "越权", revision: state.revision } });
  assert.equal(unauthorizedClear.status(), 401);
  await action({ type: "weekly.table.clear", resourceIds: [resourceId], reason: "新需求重排" });
  const cleared = await (await client.get(base + "/api/state")).json(); assert.ok(!cleared.bookings.some(b => b.resourceId === resourceId && b.status === "scheduled" && b.endAt > new Date().toISOString()));
  assert.deepEqual(cleared.settings.weeklyDefaults, constant); assert.deepEqual(cleared.weeklyPlans.find(p => p.id === tablePlan).clearedResourceIds, [resourceId]);
  console.log("PASS: local HTTP/D1 legacy and table plans, negotiated quantities, private drafts/templates, anonymous write denial, confirmation/publication, whole-future clear, snapshots and stale writes");
} finally {
  if (resourceId) {
    state = await (await client.get(base + "/api/state")).json();
    for (const r of state.requests.filter(r => r.resourceIds.includes(resourceId) && r.status === "approved")) {
      const response = await client.post(base + "/api/action", { headers: { Origin: base }, data: { type: "request.cancel", id: r.id, note: "本地周排期API测试清理", revision: state.revision } });
      assert.equal(response.status(), 200); state = await response.json();
    }
    for (const a of [{ type: "resource.bulkUpdate", ids: [resourceId], changes: { hidden: true } }, { type: "resource.delete", ids: [resourceId] }]) {
      const response = await client.post(base + "/api/action", { headers: { Origin: base }, data: { ...a, revision: state.revision } });
      assert.equal(response.status(), 200); state = await response.json();
    }
  }
  await client.dispose(); await visitor.dispose();
}
