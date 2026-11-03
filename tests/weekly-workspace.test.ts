import { test } from "node:test";
import assert from "node:assert/strict";
import { approvalConflicts, emptyState, mutate, serializePublic } from "../lib/domain";
import { makeWeeklySlots, demandAssigned, sectionGroups, sectionIssues, workspaceCapacity } from "../lib/weekly-workspace";
import type { Actor, State, WeeklySectionName, WorkspaceDemand } from "../lib/types";
import { Miniflare } from "miniflare";
import { readFile, readdir } from "node:fs/promises";
import { loadState, saveState } from "../lib/repository";

const now = "2026-11-08T12:00:00.000Z", week = "2026-11-09";
const admin: Actor = { userId: "a", email: "a@test", displayName: "管理员", role: "admin", groupId: "g1", employeeId: "" };
const contact: Actor = { ...admin, userId: "c", role: "contact" };
const visitor: Actor = { ...admin, userId: "", role: "visitor", groupId: "" };
const plan = (s: State) => s.weeklyPlans[0];
const sec = (s: State, part: WeeklySectionName = "multi") => plan(s).v2!.sections[part];
const act = (s: State, type: string, data: Record<string, unknown> = {}, part: WeeklySectionName = "multi", actor = admin, clock = now) => mutate(s, actor, { type: `weekly.v2.${type}`, planId: plan(s)?.id, section: part, ...data }, clock);
function setup(n = 6) {
  let s = emptyState();
  s.resources = Array.from({ length: n }, (_, i) => ({ id: `r${i}`, name: `A5-${i}`, ip: `192.0.2.${i + 1}`, type: "A5八卡", zone: "blue" as const, family: "A5" as const, rack: `柜${Math.floor(i / 4) + 1}`, accessMode: "bare" as const, location: "测试", sharingMode: "exclusive" as const, status: "available" as const, note: "", deleted: false, createdAt: now, updatedAt: now }));
  s = act(s, "create", { weekStart: week, groupIds: ["g1", "g2"] });
  return act(s, "settings", { completeSetup: true }, "day");
}
function demand(s: State, extras: Partial<WorkspaceDemand> = {}, part: WeeklySectionName = "multi", actor = admin) {
  return act(s, "demand", { demand: { groupId: "g1", title: "训练", desired: 2, negotiated: 2, slotIds: ["0-晚上"], continuous: false, sameRackCount: 0, shareCount: 0, model: "qwen", requirements: "", ...extras } }, part, actor);
}
function publish(s: State, part: WeeklySectionName, clock = now) {
  s = act(s, "stage", { status: "confirming" }, part, admin, clock);
  for (const groupId of sectionGroups(plan(s), part)) s = act(s, "confirm", { groupId, status: "confirmed", note: "会议已确认" }, part, admin, clock);
  return act(s, "publish", {}, part, admin, clock);
}
function dayPlan() { let s = demand(demand(setup(), { title: "g1白天", groupId: "g1" }, "day"), { title: "g2白天", groupId: "g2" }, "day"); return act(s, "recommend", {}, "day"); }
function external(s: State, id = "r0") {
  const slot = plan(s).v2!.slots[0], qid = "external";
  s.requests.push({ id: qid, groupId: "g3", resourceIds: [id], startAt: slot.startAt, endAt: slot.endAt, purpose: "外部预约", priority: "normal", status: "approved", applicantId: "a", applicantName: "a", createdAt: now, reviewedAt: now, reviewer: "a", reviewNote: "" });
  s.bookings.push({ id: "external-booking", requestId: qid, resourceId: id, groupId: "g3", startAt: slot.startAt, endAt: slot.endAt, purpose: "外部预约", priority: "normal", status: "scheduled", parentId: "", createdAt: now, updatedAt: now });
  return s;
}

test("template uses explicit midnight dates, Saturday off and Sunday through next Monday 09", () => {
  const slots = makeWeeklySlots(week); assert.equal(slots.length, 18);
  assert.equal(slots[0].startAt, "2026-11-09T13:00:00.000Z");
  assert.equal(slots[1].startAt, "2026-11-09T16:00:00.000Z"); assert.equal(slots[1].endAt, "2026-11-10T01:00:00.000Z");
  assert.equal(slots.find(x => x.id === "2-晚上")!.startAt, "2026-11-11T11:00:00.000Z");
  assert.ok(slots.filter(x => x.saturdayDay).every(x => !x.enabled)); assert.equal(slots.at(-1)!.endAt, "2026-11-16T01:00:00.000Z");
  const s = setup(); assert.equal(plan(s).v2!.startAt, "2026-11-09T01:00:00.000Z"); assert.equal(plan(s).endAt, slots.at(-1)!.endAt);
});
test("40 machines, requests 48, negotiated 38: separates request excess, negotiated headroom and assigned remainder", () => {
  const s = demand(demand(setup(40), { title: "一组", desired: 24, negotiated: 20 }), { title: "二组", groupId: "g2", desired: 24, negotiated: 18 });
  const c = workspaceCapacity(s, plan(s), plan(s).v2!.slots[0]);
  assert.equal(c.requested, 48); assert.equal(c.requestExcess, 8); assert.equal(c.negotiated, 38); assert.equal(c.negotiatedRemaining, 2); assert.equal(c.remaining, 40);
  const assigned = act(s, "recommend"); assert.equal(workspaceCapacity(assigned, plan(assigned), plan(assigned).v2!.slots[0]).remaining, 2);
});
test("blank negotiation stays pending; zero is accepted and cannot bypass minimum day guarantees", () => {
  let s = demand(setup(), { negotiated: undefined });
  assert.equal(workspaceCapacity(s, plan(s), plan(s).v2!.slots[0]).pending, 1);
  assert.throws(() => act(s, "stage", { status: "confirming" }), /待填写/);
  s = act(s, "negotiate", { demandId: sec(s).demands[0].id, quantity: 0 });
  assert.equal(sec(s).demands[0].negotiated, 0); assert.deepEqual(sectionIssues(s, plan(s), "multi"), []);
  assert.ok(sectionIssues(setup(), plan(setup()), "day").some(x => x.includes("至少一台")));
});
test("Saturday switch refuses affected tasks and retains normal day ownership", () => {
  let s = setup(); assert.throws(() => demand(s, { slotIds: ["5-上午"] }), /已开放/);
  s = act(s, "settings", { saturdayEnabled: true }); s = demand(s, { slotIds: ["5-上午"] });
  assert.throws(() => act(s, "settings", { saturdayEnabled: false }), /训练/);
  s = act(s, "withdraw", { demandId: sec(s).demands[0].id }); s = act(s, "settings", { saturdayEnabled: false });
  assert.ok(plan(s).v2!.slots.filter(x => x.saturdayDay).every(x => !x.enabled));
});
test("continuous tasks require adjacent slots, retain same servers and respect locks", () => {
  let s = demand(setup(), { slotIds: ["0-晚上", "0-凌晨"], continuous: true });
  assert.throws(() => demand(s, { title: "错误连续", slotIds: ["0-晚上", "1-晚上"], continuous: true }), /相邻/);
  const id = sec(s).demands[0].id;
  s = act(s, "assign", { demandId: id, slotId: "0-晚上", resourceIds: ["r2", "r3"], locked: true });
  s = act(s, "recommend"); assert.deepEqual(demandAssigned(sec(s), sec(s).demands[0], "0-晚上"), ["r2", "r3"]);
  assert.deepEqual(demandAssigned(sec(s), sec(s).demands[0], "0-凌晨"), ["r2", "r3"]);
  assert.deepEqual(sectionIssues(s, plan(s), "multi"), []);
});
test("external bookings, partial time markers, faults and competing tasks reduce real capacity", () => {
  let s = demand(external(setup()), { title: "一" });
  s.resources[1].status = "fault";
  s.resources[2].timeBlocks = [{ id: "block", kind: "upgrade", label: "升级", startAt: "2026-11-09T14:00:00.000Z", endAt: "2026-11-09T15:00:00.000Z", status: "active", createdAt: now, updatedAt: now }];
  assert.equal(workspaceCapacity(s, plan(s), plan(s).v2!.slots[0]).available, 3);
  assert.throws(() => act(s, "assign", { demandId: sec(s).demands[0].id, slotId: "0-晚上", resourceIds: ["r0"] }), /不可用/);
  s = act(s, "recommend"); assert.deepEqual(demandAssigned(sec(s), sec(s).demands[0]).length, 0);
  assert.ok(demandAssigned(sec(s), sec(s).demands[0], "0-晚上").every(id => ["r3", "r4", "r5"].includes(id)));
  s = demand(s, { title: "二", groupId: "g2" }); const taken = demandAssigned(sec(s), sec(s).demands[0], "0-晚上");
  assert.throws(() => act(s, "assign", { demandId: sec(s).demands[1].id, slotId: "0-晚上", resourceIds: taken }), /其他任务/);
});
test("hard rack requirement produces actionable issue rather than silently reducing quantities", () => {
  let s = demand(setup(6), { desired: 5, negotiated: 5, sameRackCount: 5 }); s = act(s, "recommend");
  assert.equal(demandAssigned(sec(s), sec(s).demands[0], "0-晚上").length, 5);
  assert.ok(sectionIssues(s, plan(s), "multi").some(x => x.includes("同柜")));
});
test("day recommendation releases excess old ownership and gives each group its negotiated quantity", () => {
  let s = dayPlan(); assert.deepEqual(sectionIssues(s, plan(s), "day"), []);
  s = act(s, "negotiate", { demandId: sec(s, "day").demands[0].id, quantity: 1 }, "day"); s = act(s, "recommend", {}, "day");
  assert.equal(sec(s, "day").rows.filter(r => r.assignments.some(x => x.groupId === "g1")).length, 1);
  assert.equal(sec(s, "day").rows.filter(r => r.assignments.some(x => x.groupId === "g2")).length, 2);
});
test("shared physical day machine meets both group guarantees and is counted once", () => {
  let s = demand(demand(setup(2), { title: "一", desired: 1, negotiated: 1, shareCount: 1 }, "day"), { title: "二", groupId: "g2", desired: 1, negotiated: 1, shareCount: 1 }, "day");
  s = act(s, "rows", { rows: sec(s, "day").rows.map((r, i) => ({ ...r, assignments: i === 0 ? [{ groupId: "g1", purpose: "一" }, { groupId: "g2", purpose: "二" }] : [] })) }, "day");
  assert.deepEqual(sectionIssues(s, plan(s), "day"), []); assert.equal(sec(s, "day").rows.filter(r => r.assignments.length).length, 1);
  s = publish(s, "day"); assert.equal(s.bookings.filter(b => b.status === "scheduled").length, 2);
});
test("independent publication uses snapshots; day ownership resumes at exact multi end", () => {
  let s = publish(dayPlan(), "day"); const publishedDay = structuredClone(sec(s, "day").published);
  s = act(s, "reopen", {}, "day"); s = demand(s, { title: "草稿秘密", desired: 1, negotiated: 1 }, "day");
  s = demand(s, { groupId: "g2", title: "夜间任务", desired: 1, negotiated: 1 });
  s = act(s, "assign", { demandId: sec(s).demands[0].id, slotId: "0-晚上", resourceIds: ["r0"], locked: true });
  s = publish(s, "multi"); assert.deepEqual(sec(s, "day").published, publishedDay); assert.equal(sec(s, "day").status, "collecting");
  const slot = plan(s).v2!.slots[0], bookings = s.bookings.filter(b => b.status === "scheduled" && b.resourceId === "r0");
  assert.ok(bookings.some(b => b.groupId === "g2" && b.startAt === slot.startAt && b.endAt === slot.endAt));
  assert.ok(bookings.some(b => b.groupId === "g1" && b.endAt === slot.startAt));
  assert.ok(bookings.some(b => b.groupId === "g1" && b.startAt === slot.endAt));
  const publicState = serializePublic(s, visitor, now, true); assert.ok(!JSON.stringify(publicState.weeklyPlans).includes("草稿秘密"));
  assert.ok(JSON.stringify(publicState.weeklyPlans).includes("夜间任务"));
});
test("republication preserves elapsed history, cancelled future ranges and external records", () => {
  let s = publish(dayPlan(), "day");
  const cancel = s.bookings.find(b => b.status === "scheduled" && b.resourceId === "r0")!;
  s = mutate(s, admin, { type: "request.cancel", id: cancel.requestId, note: "释放" }, now);
  assert.ok(plan(s).v2!.suppressions.some(x => x.resourceId === "r0"));
  s = demand(s, { title: "夜间", desired: 1, negotiated: 1 }); s = act(s, "recommend"); s = publish(s, "multi");
  assert.ok(!s.bookings.some(b => b.status === "scheduled" && b.resourceId === "r0" && b.groupId === "g1"));
  const clock = "2026-11-10T03:00:00.000Z", old = s.bookings.filter(b => b.status === "scheduled" && b.startAt < clock && b.endAt > clock).map(b => b.id);
  s = act(s, "reopen", {}, "multi", admin, clock); s = publish(s, "multi", clock);
  for (const id of old) assert.equal(s.bookings.find(b => b.id === id)!.endAt, clock);
});
test("clear prevents any snapshot from resurrecting future allocations", () => {
  let s = publish(dayPlan(), "day");
  s = mutate(s, admin, { type: "weekly.table.clear", resourceIds: ["r0"], reason: "清空" }, now);
  s = demand(s, { title: "夜间", desired: 1, negotiated: 1 }); s = act(s, "assign", { demandId: sec(s).demands[0].id, slotId: "0-晚上", resourceIds: ["r4"] }); s = publish(s, "multi");
  assert.ok(!s.bookings.some(b => b.status === "scheduled" && b.resourceId === "r0"));
});
test("contacts share draft matters but may only edit own demands; guests see no drafts or hidden IDs", () => {
  let s = demand(demand(setup(), { title: "另一组事项", groupId: "g2" }), { title: "本组事项" }, "multi", contact);
  const other = sec(s).demands.find(d => d.groupId === "g2")!;
  assert.ok(JSON.stringify(serializePublic(s, contact, now, true).weeklyPlans).includes("另一组事项"));
  assert.equal(serializePublic(s, visitor, now, true).weeklyPlans.length, 0);
  assert.throws(() => demand(s, other, "multi", contact), /本组/);
  assert.throws(() => act(s, "assign", { demandId: other.id, slotId: "0-晚上", resourceIds: ["r0"] }, "multi", contact), /管理员/);
  assert.throws(() => act(s, "negotiate", { demandId: other.id, quantity: 1 }, "multi", contact), /管理员/);
  assert.throws(() => mutate(s, contact, { type: "weekly.table.sheet", planId: plan(s).id, changes: [] }, now), /新版/);
  s = act(s, "negotiate", { demandId: sec(s).demands.find(d => d.groupId === "g1")!.id, quantity: 2 });
  s = act(s, "recommend"); s.resources[0].hidden = true;
  assert.ok(!JSON.stringify(serializePublic(s, contact, now, true).weeklyPlans).includes('"r0"'));
});
test("late resource conflicts block publication even after confirmations", () => {
  let s = demand(setup()); s = act(s, "recommend"); s = act(s, "stage", { status: "confirming" }); s = act(s, "confirm", { groupId: "g1", status: "confirmed", note: "已确认" });
  const id = demandAssigned(sec(s), sec(s).demands[0], "0-晚上")[0]; s = external(s, id);
  assert.throws(() => act(s, "publish"), /不可用/); assert.equal(s.bookings.find(b => b.id === "external-booking")!.status, "scheduled");
});
test("D1 persists independent snapshots and atomically rejects stale writes", async () => {
  const mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("ok")}}', compatibilityDate: "2026-05-15", d1Databases: ["DB"] });
  try {
    const db = await mf.getD1Database("DB") as unknown as D1Database;
    for (const name of (await readdir("drizzle")).filter(n => n.endsWith(".sql")).sort()) await db.batch((await readFile(`drizzle/${name}`, "utf8")).split("--> statement-breakpoint").filter(x => x.trim()).map(sql => db.prepare(sql)));
    const before = await loadState(db), s = publish(dayPlan(), "day"); await saveState(db, before, s);
    const loaded = await loadState(db); assert.deepEqual(loaded.weeklyPlans, s.weeklyPlans);
    await saveState(db, loaded, act(loaded, "reopen", {}, "day"));
    await assert.rejects(saveState(db, loaded, act(loaded, "settings", { saturdayEnabled: true })), /数据刚刚/);
  } finally { await mf.dispose(); }
});

test("conflicting edits reject captured baselines instead of silently overwriting a refreshed client", () => {
  let s = demand(setup()); const before = structuredClone(sec(s).demands[0]);
  s = act(s, "negotiate", { demandId: before.id, quantity: 1 });
  assert.throws(() => act(s, "demand", { demand: { ...before, title: "过时编辑" }, before }), /其他人修改/);
  assert.throws(() => act(s, "negotiateMany", { values: [{ demandId: before.id, quantity: 0, before: 2 }] }), /其他人修改/);
  const allocationBefore = structuredClone(sec(s).allocations);
  s = act(s, "assign", { demandId: before.id, slotId: "0-晚上", resourceIds: ["r0"], before: allocationBefore });
  assert.throws(() => act(s, "assign", { demandId: before.id, slotId: "0-晚上", resourceIds: ["r1"], before: allocationBefore }), /其他人修改/);
});

test("new weeks inherit the pool and ownership, but Saturday daytime needs a fresh weekly opt in", () => {
  let s = act(setup(), "settings", { saturdayEnabled: true });
  s = act(s, "create", { weekStart: "2026-11-16", groupIds: ["g1", "g2"] });
  assert.deepEqual(s.weeklyPlans[1].resourceIds, s.weeklyPlans[0].resourceIds);
  assert.ok(s.weeklyPlans[1].v2!.slots.filter(x => x.saturdayDay).every(x => !x.enabled));
});

test("multi bookings remain exclusive to their task even if the daytime server is marked shared", () => {
  let s = demand(setup(), { desired: 1, negotiated: 1 }); s.resources[0].sharingMode = "shared";
  s = act(s, "assign", { demandId: sec(s).demands[0].id, slotId: "0-晚上", resourceIds: ["r0"] }); s = publish(s, "multi");
  const own = s.requests.find(q => q.weeklySection === "multi")!;
  assert.equal(approvalConflicts(s, { ...own, id: "external", weeklySection: undefined, groupId: "g2" }).length, 1);
});

test("cleared machines can be explicitly reassigned, only taking effect on the target section publication", () => {
  let s = publish(dayPlan(), "day");
  s = mutate(s, admin, { type: "weekly.table.clear", resourceIds: ["r0"], reason: "重新安排" }, now);
  s = demand(s, { title: "新任务", desired: 1, negotiated: 1 });
  s = act(s, "recommend"); assert.ok(!demandAssigned(sec(s), sec(s).demands[0], "0-晚上").includes("r0"));
  s = act(s, "assign", { demandId: sec(s).demands[0].id, slotId: "0-晚上", resourceIds: ["r0"], locked: true });
  assert.ok(!s.bookings.some(b => b.status === "scheduled" && b.resourceId === "r0"));
  s = publish(s, "multi");
  const slot = plan(s).v2!.slots[0], current = s.bookings.filter(b => b.status === "scheduled" && b.resourceId === "r0");
  assert.equal(current.length, 1); assert.equal(current[0].startAt, slot.startAt); assert.equal(current[0].endAt, slot.endAt);
});

test("guided setup gates new plans, validates permissions, and leaves existing configured workflows compatible", () => {
  let s = setup(); delete plan(s).v2!.setup;
  assert.doesNotThrow(() => demand(s));
  plan(s).v2!.setup = { completedAt: "", by: "" };
  assert.throws(() => demand(s), /先完成参与范围/);
  assert.throws(() => act(s, "recommend"), /先完成参与范围/);
  assert.throws(() => act(s, "settings", { completeSetup: true }, "day", contact), /管理员/);
  s = act(s, "settings", { completeSetup: true, saturdayEnabled: true }, "day");
  assert.equal(plan(s).v2!.setup!.completedAt, now);
  assert.ok(plan(s).v2!.slots.filter(x => x.saturdayDay).every(x => x.enabled));
  assert.doesNotThrow(() => demand(s));
});

test("inline day edits preserve purposes and expose all changed rows atomically", () => {
  let s = dayPlan();
  const before = structuredClone(sec(s, "day").rows), rows = structuredClone(before);
  rows[0].assignments = [{ groupId: "g2", purpose: "管理员直接修改的用途" }]; rows[0].specialNote = "完整多行\n特殊用途说明";
  s = act(s, "rows", { rows, before }, "day");
  assert.equal(sec(s, "day").rows[0].assignments[0].purpose, "管理员直接修改的用途");
  assert.equal(sec(s, "day").rows[0].specialNote, rows[0].specialNote);
  assert.throws(() => act(s, "rows", { rows: before, before }, "day"), /已被修改/);
});

test("multi sheet saves swaps atomically and checks continuous batches, conflicts and stale inputs", () => {
  let s = demand(demand(setup(), { title: "连续一", desired: 1, negotiated: 1, continuous: true, slotIds: ["0-晚上", "0-凌晨"] }), { title: "连续二", groupId: "g2", desired: 1, negotiated: 1, continuous: true, slotIds: ["0-晚上", "0-凌晨"] });
  s = act(s, "recommend"); const before = structuredClone(sec(s).allocations), d1 = sec(s).demands[0].id, d2 = sec(s).demands[1].id;
  const allocations = before.map(a => ({ ...a, resourceIds: [a.demandId === d1 ? "r3" : "r2"], locked: true }));
  s = act(s, "multiSheet", { before, allocations }); assert.deepEqual(sec(s).allocations, allocations);
  assert.throws(() => act(s, "multiSheet", { before, allocations }), /其他人修改/);
  const bad = allocations.map(a => ({ ...a, resourceIds: ["r0"] }));
  assert.throws(() => act(s, "multiSheet", { before: allocations, allocations: bad }), /一个任务/);
  const split = allocations.map(a => ({ ...a, resourceIds: a.demandId === d2 && a.slotId === "0-凌晨" ? ["r4"] : a.resourceIds }));
  assert.throws(() => act(s, "multiSheet", { before: allocations, allocations: split }), /同一批/);
  assert.throws(() => act(s, "multiSheet", { before: allocations, allocations }, "multi", contact), /管理员/);
});
