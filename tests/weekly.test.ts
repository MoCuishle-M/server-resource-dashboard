import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { Miniflare } from "miniflare";
import { emptyState, mutate, serializePublic } from "../lib/domain";
import { loadState, saveState } from "../lib/repository";
import { checkWeeklyPlan, demandRange, suggestWeeklyPlan } from "../lib/weekly-planner";
import { importRows } from "../lib/csv";
import type { Actor, State, WeeklyDemand, WeeklyLine } from "../lib/types";

const now = "2026-10-22T00:00:00.000Z";
const admin: Actor = { userId: "admin", email: "admin@test", displayName: "管理员", role: "admin", groupId: "g1", employeeId: "" };
const contact: Actor = { ...admin, userId: "c1", role: "contact", groupId: "g1", displayName: "一组接口人" };
const act = (s: State, a: Record<string, unknown>, actor = admin, clock = now) => mutate(s, actor, a as never, clock);
const line = (v: Partial<WeeklyLine> = {}): WeeklyLine => ({ id: "line", zone: "green", family: "A3", accessMode: "bare", desired: 2, minimum: 2, mode: "multi", rackPolicy: "required", preferredResourceIds: [], shareCount: 0, ...v });
function setup(count = 6): State {
  let s = emptyState();
  for (let i = 0; i < count; i++) s = act(s, { type: "resource.save", resource: {
    name: `服务器${i + 1}`, type: "Ascend", ip: `192.0.2.${i + 1}`, accessMode: "bare", sharingMode: "exclusive", location: "机房A", zone: "green", family: "A3", rack: i < 3 ? "柜1" : "柜2", status: "available", note: "",
  } });
  return act(s, { type: "weekly.create", weekStart: "2026-10-26" });
}
function add(s: State, title = "版本任务", groupId = "g1", changes: Partial<WeeklyDemand> = {}, actor = admin) {
  return act(s, { type: "weekly.demand.save", planId: s.weeklyPlans[0].id, demand: {
    groupId, title, category: "version", reason: "验证版本交付", deadline: "2026-10-30T10:00:00.000Z",
    expectedStart: "2026-10-26T01:00:00.000Z", expectedEnd: "2026-10-30T09:00:00.000Z", continuousHours: 24,
    timeNote: "可协商", holdMode: "week", shareWithDemandIds: [], shareNote: "", lines: [line()], ...changes,
  } }, actor);
}
const stage = (s: State, status = "draft") => act(s, { type: "weekly.stage", planId: s.weeklyPlans[0].id, status });
const recommend = (s: State) => act(s, { type: "weekly.suggest", planId: s.weeklyPlans[0].id });
function assign(s: State, demandIndex: number, resourceIds: string[], sharedResourceIds: string[] = [], locked = true) {
  const d = s.weeklyDemands[demandIndex];
  return act(s, { type: "weekly.assign", planId: d.planId, demandId: d.id, lineId: d.lines[0].id, resourceIds, sharedResourceIds, locked, note: "人工协调" });
}
function confirm(s: State) {
  for (const groupId of [...new Set(s.weeklyDemands.filter(d => d.status === "active").map(d => d.groupId))])
    s = act(s, { type: "weekly.confirm", planId: s.weeklyPlans[0].id, groupId, status: "confirmed", note: "已与接口人核对，代录" });
  return s;
}
const publish = (s: State) => act(s, { type: "weekly.publish", planId: s.weeklyPlans[0].id });

test("weekly collection validates Beijing Mondays, numbers, timing and group ownership", () => {
  let s = setup();
  assert.throws(() => act(s, { type: "weekly.create", weekStart: "2026-10-27" }), /周一/);
  assert.throws(() => act(s, { type: "weekly.create", weekStart: "2026-10-26" }), /已有/);
  assert.throws(() => add(s, "越界", "g1", { expectedEnd: "2026-11-03T09:00:00Z" }), /该周内/);
  assert.throws(() => add(s, "数量", "g1", { lines: [line({ minimum: 3 })] }), /最低数量/);
  assert.throws(() => add(s, "连续运行", "g1", { continuousHours: 168 }), /连续运行/);
  assert.throws(() => add(s, "共享未说明", "g1", { lines: [line({ shareCount: 1 })] }), /共享/);
  s = add(s, "本组任务", "g9", {}, contact);
  assert.equal(s.weeklyDemands[0].groupId, "g1");
  assert.throws(() => act(s, { type: "weekly.demand.withdraw", planId: s.weeklyPlans[0].id, demandId: s.weeklyDemands[0].id }, { ...contact, groupId: "g2" }), /本组/);
  for (const role of ["visitor", "member"] as const) assert.throws(() => add(s, "未认证", "g1", {}, { ...contact, role }), /接口人认证/);
  s = stage(s);
  assert.throws(() => add(s), /收集已结束/);
});

test("recommendation reserves whole-task minima before extras, keeps locks and reports scarcity", () => {
  let s = setup(5);
  s = add(s, "任务甲", "g1", { lines: [line({ desired: 4, rackPolicy: "any" })] });
  s = add(s, "任务乙", "g2", { lines: [line({ desired: 4, rackPolicy: "any" })] });
  s = stage(s); s = assign(s, 0, s.resources.slice(0, 2).map(r => r.id)); s = recommend(s);
  assert.equal(s.weeklyPlans[0].allocations[0].locked, true);
  assert.equal(s.weeklyPlans[0].allocations.find(a => a.demandId === s.weeklyDemands[1].id)!.resourceIds.length, 3);
  assert.equal(checkWeeklyPlan(s, s.weeklyPlans[0]).filter(i => i.severity === "error").length, 0);
  assert.equal(s.bookings.length, 0, "draft must not reserve machines");
  let scarce = add(setup(1)); scarce = recommend(stage(scarce));
  assert.equal(scarce.weeklyPlans[0].allocations.length, 0);
  assert.match(checkWeeklyPlan(scarce, scarce.weeklyPlans[0])[0].message, /缺2台/);
  assert.throws(() => stage(scarce, "confirming"), /先处理冲突/);
  assert.deepEqual(suggestWeeklyPlan(s, s.weeklyPlans[0]), suggestWeeklyPlan(s, s.weeklyPlans[0]), "deterministic baseline");
});

test("topology, availability, zone and family are hard constraints; history is a preference", () => {
  let s = setup(4); s = add(s, "四机任务", "g1", { lines: [line({ desired: 4, minimum: 4 })] }); s = recommend(stage(s));
  assert.equal(s.weeklyPlans[0].allocations.length, 0, "must not split required same-rack gang");
  s = assign(s, 0, s.resources.map(r => r.id));
  assert.ok(checkWeeklyPlan(s, s.weeklyPlans[0]).some(i => /同柜/.test(i.message)));
  let h = setup(6); h = add(h);
  h.bookings.push({ id: "history", requestId: "old", resourceId: h.resources[5].id, groupId: "g1", startAt: "2026-10-18T16:00:00.000Z", endAt: "2026-10-25T16:00:00.000Z", purpose: "上周任务", priority: "normal", status: "scheduled", parentId: "", createdAt: now, updatedAt: now });
  h = recommend(stage(h));
  assert.ok(h.weeklyPlans[0].allocations[0].resourceIds.includes(h.resources[5].id));
  const selected = h.weeklyPlans[0].allocations[0].resourceIds[0];
  h = act(h, { type: "resource.fault", id: selected, description: "掉卡" });
  assert.ok(checkWeeklyPlan(h, h.weeklyPlans[0]).some(i => /不可用/.test(i.message)));
  h = recommend(h); assert.ok(!h.weeklyPlans[0].allocations.some(a => a.resourceIds.includes(selected)));
});

test("multi-type demand is all-or-nothing when its minimum configuration cannot be met", () => {
  let s = setup(); s = add(s, "混合任务", "g1", { lines: [line(), line({ id: "a5", family: "A5" })] });
  s = recommend(stage(s)); assert.equal(s.weeklyPlans[0].allocations.length, 0);
  assert.equal(s.bookings.length, 0);
});

test("simultaneous sharing requires both tasks, exact server selections and quantity limits", () => {
  let s = setup(1); s.resources[0].sharingMode = "shared";
  s = add(s, "任务甲", "g1", { lines: [line({ desired: 1, minimum: 1, shareCount: 1 })], shareNote: "依赖兼容，可同时共用一台" });
  s = add(s, "任务乙", "g2", { lines: [line({ desired: 1, minimum: 1, shareCount: 1 })], shareWithDemandIds: [s.weeklyDemands[0].id], shareNote: "同意共用" });
  s = add(s, "任务甲", "g1", { ...s.weeklyDemands[0], shareWithDemandIds: [s.weeklyDemands[1].id] });
  s = stage(s); const ids = [s.resources[0].id];
  s = assign(s, 0, ids, ids); s = assign(s, 1, ids);
  assert.ok(checkWeeklyPlan(s, s.weeklyPlans[0]).some(i => /共享需双方/.test(i.message)));
  s = assign(s, 1, ids, ids);
  assert.equal(checkWeeklyPlan(s, s.weeklyPlans[0]).filter(i => i.severity === "error").length, 0);
  s = publish(confirm(stage(s, "confirming")));
  assert.equal(s.bookings.length, 2); assert.equal(new Set(s.bookings.map(b => b.resourceId)).size, 1);
});

test("weekly holding prevents unintended backfill; explicit windows permit adjacent use", () => {
  let s = setup(1);
  const first = { lines: [line({ desired: 1, minimum: 1 })], continuousHours: 1, expectedEnd: "2026-10-26T03:00:00.000Z" };
  s = add(s, "上午", "g1", first); s = add(s, "下午", "g2", { ...first, expectedStart: first.expectedEnd, expectedEnd: "2026-10-26T06:00:00.000Z" });
  s = stage(s); s = assign(s, 0, [s.resources[0].id]); s = assign(s, 1, [s.resources[0].id]);
  assert.ok(checkWeeklyPlan(s, s.weeklyPlans[0]).some(i => i.severity === "error"));
  s.weeklyDemands.forEach(d => { d.holdMode = "window"; });
  assert.equal(checkWeeklyPlan(s, s.weeklyPlans[0]).filter(i => i.severity === "error").length, 0);
  assert.equal(demandRange(s.weeklyPlans[0], s.weeklyDemands[0]).endAt, first.expectedEnd);
});

test("publishing needs group acceptance, resets confirmations on edits, and is immutable/idempotent", () => {
  let s = recommend(stage(add(setup())));
  s = stage(s, "confirming");
  assert.throws(() => publish(s), /未确认/);
  assert.throws(() => act(s, { type: "weekly.confirm", planId: s.weeklyPlans[0].id, groupId: "g1", status: "confirmed", note: "" }), /代确认原因/);
  s = act(s, { type: "weekly.confirm", planId: s.weeklyPlans[0].id, groupId: "g9", status: "confirmed", note: "" }, contact);
  assert.equal(s.weeklyPlans[0].confirmations[0].groupId, "g1");
  s = recommend(s); assert.equal(s.weeklyPlans[0].confirmations.length, 0); assert.equal(s.weeklyPlans[0].status, "draft");
  s = publish(confirm(stage(s, "confirming")));
  assert.equal(s.requests[0].status, "approved"); assert.equal(s.bookings.length, 2);
  assert.equal(s.bookings[0].startAt, "2026-10-25T16:00:00.000Z");
  assert.throws(() => publish(s), /已发布/); assert.throws(() => recommend(s), /已发布/);
  assert.equal(s.requests.length, 1);
});

test("new reservations after confirmation block atomic publication, with no preemption", () => {
  let s = confirm(stage(recommend(stage(add(setup()))), "confirming"));
  const id = s.weeklyPlans[0].allocations[0].resourceIds[0];
  s = act(s, { type: "request.create", groupId: "g2", resourceIds: [id], purpose: "临时任务", priority: "normal", startAt: "2026-10-26T00:00:00Z", endAt: "2026-10-27T00:00:00Z" });
  s = act(s, { type: "request.review", id: s.requests[0].id, approve: true });
  const before = structuredClone(s);
  assert.throws(() => publish(s), /已有正式预约/);
  assert.deepEqual(s, before); assert.equal(s.bookings[0].status, "scheduled");
});

test("deferred tasks require a reason and acceptance, and do not generate bookings", () => {
  let s = stage(add(setup(0)));
  assert.throws(() => act(s, { type: "weekly.defer", planId: s.weeklyPlans[0].id, demandId: s.weeklyDemands[0].id, reason: "" }), /暂缓原因/);
  s = act(s, { type: "weekly.defer", planId: s.weeklyPlans[0].id, demandId: s.weeklyDemands[0].id, reason: "资源不足，已协商下周安排" });
  s = publish(confirm(stage(s, "confirming")));
  assert.equal(s.bookings.length, 0); assert.equal(s.weeklyPlans[0].status, "published");
});

test("draft privacy and hidden-resource protection apply to raw API serialization", () => {
  let s = add(add(setup(), "本组", "g1"), "别组", "g2", { reason: "别组私有理由" });
  const visitor = { ...contact, userId: "", role: "visitor" as const };
  assert.equal(serializePublic(s, visitor, now, true).weeklyPlans.length, 0);
  const own = serializePublic(s, contact, now, true);
  assert.equal(own.weeklyDemands.length, 1); assert.equal(own.weeklyPlans[0].directory!.length, 2);
  assert.ok(!JSON.stringify(own).includes("别组私有理由")); assert.equal(own.audits.filter(a => a.entityType === "weekly").length, 0);
  s = recommend(stage(s)); s = publish(confirm(stage(s, "confirming")));
  assert.equal(serializePublic(s, visitor, now, true).weeklyDemands.length, 2);
  const usedId = s.weeklyPlans[0].allocations[0].resourceIds[0];
  s = act(s, { type: "resource.bulkUpdate", ids: [usedId], changes: { hidden: true } });
  const publicState = serializePublic(s, visitor, now, true);
  assert.ok(!JSON.stringify(publicState.weeklyPlans).includes(usedId));
  assert.ok(!publicState.weeklyDemands.some(d => d.id === s.weeklyPlans[0].allocations[0].demandId));
});

test("resource classification supports import and validates values without inventing old inventory metadata", () => {
  const rows = importRows("IP,区域,排期型号,机柜\n192.0.2.1,绿区,A3,A01", "update");
  assert.deepEqual(rows[0], { ip: "192.0.2.1", zone: "green", family: "A3", rack: "A01" });
  assert.throws(() => importRows("IP,区域\n192.0.2.1,红区", "update"), /绿区或蓝区/);
  let s = setup(); s = act(s, { type: "resource.bulkUpdate", ids: s.resources.map(r => r.id), changes: { zone: "blue", family: "A5", rack: "B01" } });
  assert.ok(s.resources.every(r => r.zone === "blue" && r.family === "A5" && r.rack === "B01"));
  assert.throws(() => act(s, { type: "resource.bulkUpdate", ids: [s.resources[0].id], changes: { zone: "red" } }), /区域/);
});

test("copying prior-week demands shifts dates and sharing references, keeps machine preferences but not approval", () => {
  let s = add(add(setup(), "上期甲", "g1"), "上期乙", "g2");
  s.weeklyDemands[0].shareWithDemandIds = [s.weeklyDemands[1].id];
  s = publish(confirm(stage(recommend(stage(s)), "confirming")));
  s = act(s, { type: "weekly.create", weekStart: "2026-11-02" });
  const p = s.weeklyPlans[1];
  s = act(s, { type: "weekly.copyPrevious", planId: p.id });
  const copied = s.weeklyDemands.filter(d => d.planId === p.id);
  assert.equal(copied.length, 2);
  assert.equal(copied[0].expectedStart, "2026-11-02T01:00:00.000Z");
  assert.equal(copied[0].deadline, "2026-11-06T10:00:00.000Z");
  assert.deepEqual(copied[0].shareWithDemandIds, [copied[1].id]);
  assert.equal(copied[0].lines[0].preferredResourceIds.length, 2);
  assert.equal(s.weeklyPlans[1].allocations.length, 0);
  assert.equal(s.weeklyPlans[1].confirmations.length, 0);
  assert.throws(() => act(s, { type: "weekly.copyPrevious", planId: p.id }), /已有需求/);
});

test("real D1 persists weekly drafts, publications and all-or-nothing concurrent writes", async () => {
  const mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("ok")}}', compatibilityDate: "2026-05-15", d1Databases: ["DB"] });
  try {
    const db = await mf.getD1Database("DB") as unknown as D1Database;
    for (const name of (await readdir("drizzle")).filter(n => n.endsWith(".sql")).sort())
      await db.batch((await readFile(`drizzle/${name}`, "utf8")).split("--> statement-breakpoint").filter(x => x.trim()).map(sql => db.prepare(sql)));
    const initial = await loadState(db);
    let s = confirm(stage(recommend(stage(add(setup()))), "confirming"));
    await saveState(db, initial, s);
    const persisted = await loadState(db); assert.deepEqual(persisted.weeklyPlans, s.weeklyPlans); assert.deepEqual(persisted.weeklyDemands, s.weeklyDemands);
    const published = publish(persisted), stale = recommend(persisted);
    await saveState(db, persisted, published);
    await assert.rejects(saveState(db, persisted, stale), /数据刚刚发生变化/);
    s = await loadState(db); assert.equal(s.weeklyPlans[0].status, "published"); assert.equal(s.bookings.length, 2); assert.equal(s.requests.length, 1);
  } finally { await mf.dispose(); }
});
