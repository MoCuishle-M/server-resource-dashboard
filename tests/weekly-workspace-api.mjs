import { request } from "playwright";
import assert from "node:assert/strict";
const base = "http://127.0.0.1:5173";
const client = await request.newContext(), visitor = await request.newContext();
let state;
try {
  await client.get(base + "/signin-with-chatgpt?return_to=/");
  state = await (await client.get(base + "/api/state")).json(); assert.equal(state.actor.role, "admin");
  async function action(data, expected = 200) {
    const response = await client.post(base + "/api/action", { headers: { Origin: base }, data: { revision: state.revision, ...data } });
    const body = await response.json(); assert.equal(response.status(), expected, JSON.stringify(body)); if (expected === 200) state = body; return body;
  }
  const stamp = Date.now(), resourceIds = [];
  for (let i = 0; i < 4; i++) {
    const name = `A5双流程API-${stamp}-${i}`;
    await action({ type: "resource.save", resource: { name, ip: `2001:db8:55::${stamp.toString(16).match(/.{1,4}/g).join(":")}:${i + 1}`, zone: "blue", family: "A5", type: "API A5", rack: "API01", location: "本地QA", accessMode: "bare", sharingMode: "exclusive", status: "available", note: "" } });
    resourceIds.push(state.resources.find(r => r.name === name).id);
  }
  let monday = "2031-01-06";
  while (state.weeklyPlans.some(p => p.weekStart === monday)) monday = new Date(Date.parse(monday + "T12:00:00Z") + 7 * 86400000).toISOString().slice(0, 10);
  await action({ type: "weekly.v2.create", weekStart: monday, resourceIds, groupIds: ["g1", "g2"] });
  const planId = state.weeklyPlans.find(p => p.weekStart === monday).id;
  const run = (type, data = {}, section = "multi", expected = 200) => action({ type: `weekly.v2.${type}`, planId, section, ...data }, expected);
  const plan = () => state.weeklyPlans.find(p => p.id === planId), sec = (part = "multi") => plan().v2.sections[part];
  for (const groupId of ["g1", "g2"]) await run("demand", { demand: { groupId, title: `${groupId}白天API`, desired: 1, negotiated: 1 } }, "day");
  await run("recommend", {}, "day");
  async function publish(section, groups) {
    await run("stage", { status: "confirming" }, section);
    for (const groupId of groups) await run("confirm", { groupId, status: "confirmed", note: "本地测试确认" }, section);
    await run("publish", {}, section);
  }
  await publish("day", ["g1", "g2"]);
  const publishedDay = JSON.stringify(sec("day").published);
  await run("reopen", {}, "day"); await run("demand", { demand: { groupId: "g1", title: "未发布草稿API", desired: 1, negotiated: 1 } }, "day");
  await run("demand", { demand: { groupId: "g1", title: "连续多机API", desired: 5, negotiated: 4, slotIds: ["0-晚上", "0-凌晨"], continuous: true } });
  await run("recommend"); await publish("multi", ["g1"]);
  assert.equal(JSON.stringify(sec("day").published), publishedDay); assert.equal(sec("day").status, "collecting");
  const persisted = await (await client.get(base + "/api/state")).json(); assert.deepEqual(persisted.weeklyPlans.find(p => p.id === planId), plan());
  const publicState = await (await visitor.get(base + "/api/state")).json();
  assert.ok(!JSON.stringify(publicState.weeklyPlans).includes("未发布草稿API")); assert.ok(JSON.stringify(publicState.weeklyPlans).includes("连续多机API"));
  await action({ type: "weekly.v2.reopen", planId, section: "multi", revision: state.revision - 1 }, 409);
  const stale = JSON.stringify(plan()); await run("publish", {}, "multi", 400); assert.equal(JSON.stringify(plan()), stale);
  const slot = plan().v2.slots[0], own = state.requests.find(q => q.weeklyPlanId === planId && q.weeklySection === "multi");
  await action({ type: "request.cancelPartial", id: own.id, resourceIds: own.resourceIds, startAt: slot.startAt, endAt: slot.endAt, note: "本地释放验证" });
  await run("reopen"); await publish("multi", ["g1"]);
  assert.ok(!state.bookings.some(b => b.status === "scheduled" && b.resourceId === own.resourceIds[0] && b.groupId === "g1" && b.startAt < slot.endAt && b.endAt > slot.startAt));
  const anonymous = await visitor.post(base + "/api/action", { headers: { Origin: base }, data: { type: "weekly.v2.reopen", planId, section: "multi", revision: state.revision } }); assert.equal(anonymous.status(), 401);
  console.log("PASS: real local API/D1, independent published snapshots, guest draft isolation, stale revision, contiguous task publication, partial cancellation and no resurrection");
} finally { await client.dispose(); await visitor.dispose(); }
