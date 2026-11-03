import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyState, mutate, serializePublic } from "../lib/domain";
import { checkTablePlan, tableAllocations, tableRows, SMOKE_NOTE, CANADA_NOTE } from "../lib/weekly-table";
import type { Actor, State } from "../lib/types";
import { readFile, readdir } from "node:fs/promises";
import { Miniflare } from "miniflare";
import { loadState, saveState } from "../lib/repository";
import { scheduleNotes } from "../lib/schedule-notes";

const now = "2026-10-26T04:00:00.000Z";
const admin: Actor = { userId: "a", email: "a@test", displayName: "管理员", role: "admin", groupId: "g1", employeeId: "" };
const contact: Actor = { ...admin, userId: "c", role: "contact", displayName: "接口人" };
const act = (s: State, type: string, data: Record<string, unknown> = {}, actor = admin, clock = now) => mutate(s, actor, { type: `weekly.table.${type}`, planId: s.weeklyPlans[0]?.id, ...data }, clock);
function setup(n = 4) {
  let s = emptyState();
  for (let i = 0; i < n; i++) s = mutate(s, admin, { type: "resource.save", resource: { name: `服务器${i}`, ip: `192.0.2.${i + 1}`, type: "A3八卡", accessMode: "bare", sharingMode: "exclusive", status: "available", location: "乌兰察布", zone: "blue", family: "A3", rack: i < 3 ? "B01" : "B02", note: "" } }, now);
  return act(s, "create", { weekStart: "2026-10-26" });
}
const demand = (s: State, groupId = "g1", extras: Record<string, unknown> = {}, actor = admin) => act(s, "demand", { demand: { groupId, title: `${groupId}训练`, applicantName: "申请人", lines: [{ resourceType: "A3八卡", accessMode: "bare", desired: 2, negotiated: 2, shareCount: 0, sameRackCount: 2, sameRackGroupIds: [], ...extras }] } }, actor);
const confirmAll = (s: State) => {
  for (const groupId of [...new Set(s.weeklyPlans[0].rows!.flatMap(r => r.assignments.map(a => a.groupId)))]) s = act(s, "confirm", { groupId, status: "confirmed", note: "会议已确认，管理员代录" });
  return s;
};

test("online sheet is shared by contacts, rejects unapproved roles and preserves untouched and hidden rows", () => {
  let s = setup(3);
  s = act(s, "rows", { rows: s.weeklyPlans[0].rows!.map(r => ({ ...r, assignments: [{ groupId: "g2", purpose: "共享预排期" }] })) });
  const before = structuredClone(s.weeklyPlans[0].rows![0]), after = { ...before, specialNote: "接口人在线更新" };
  for (const role of ["visitor", "member"] as const) {
    const actor = { ...contact, role, userId: role === "visitor" ? "" : "pending" };
    assert.equal(serializePublic(s, actor, now, true).weeklyPlans.length, 0);
    assert.throws(() => act(s, "sheet", { changes: [{ before, after }] }, actor), /认证/);
  }
  assert.equal(serializePublic(s, contact, now, true).weeklyPlans[0].rows![0].assignments[0].purpose, "共享预排期");
  s.resources[2].hidden = true;
  const untouched = structuredClone(s.weeklyPlans[0].rows!.slice(1));
  s = act(s, "sheet", { changes: [{ before, after }] }, contact);
  assert.equal(s.weeklyPlans[0].rows![0].specialNote, after.specialNote);
  assert.deepEqual(s.weeklyPlans[0].rows!.slice(1), untouched);
  assert.equal(s.bookings.length, 0);
  assert.equal(s.audits.at(-1)!.action, "在线编辑服务器预排期");
  const hidden = s.weeklyPlans[0].rows![2];
  assert.throws(() => act(s, "sheet", { changes: [{ before: hidden, after: { ...hidden, specialNote: "越权" } }] }, contact), /隐藏/);
  assert.throws(() => act(s, "publish", {}, contact), /管理员/);
});

test("online sheet rejects stale rows atomically, merges edits to other rows, and invalidates confirmations", () => {
  let s = setup(2);
  s = act(s, "rows", { rows: s.weeklyPlans[0].rows!.map(r => ({ ...r, assignments: [{ groupId: "g1", purpose: "初始" }] })) });
  s = confirmAll(act(s, "stage", { status: "confirming" }));
  const [first, second] = structuredClone(s.weeklyPlans[0].rows!);
  const changes = [{ before: first, after: { ...first, specialNote: "管理员修改" } }];
  s = act(s, "sheet", { changes });
  assert.equal(s.weeklyPlans[0].confirmations.length, 0); assert.equal(s.weeklyPlans[0].status, "draft");
  assert.throws(() => act(s, "sheet", { changes: [{ before: second, after: { ...second, specialNote: "不可部分保存" } }, ...changes] }, contact), /其他人修改/);
  assert.equal(s.weeklyPlans[0].rows![1].specialNote, "");
  s = act(s, "sheet", { changes: [{ before: second, after: { ...second, specialNote: "不同行可合并" } }] }, contact);
  assert.equal(s.weeklyPlans[0].rows![0].specialNote, "管理员修改");
  assert.equal(s.weeklyPlans[0].rows![1].specialNote, "不同行可合并");
  s = act(s, "stage", { status: "confirming" }); s = confirmAll(s); s = act(s, "publish");
  const row = s.weeklyPlans[0].rows![0];
  assert.throws(() => act(s, "sheet", { changes: [{ before: row, after: { ...row, specialNote: "修改已发布" } }] }, contact), /已发布/);
});

test("custom week end publishes through next Monday and retains notes and expiry checks", () => {
  let s = setup(1);
  const endAt = "2026-11-02T06:00:00.000Z", id = s.resources[0].id;
  s = act(s, "rows", { rows: [{ resourceId: id, assignments: [{ groupId: "g1", purpose: "周排期" }], specialNote: CANADA_NOTE }] });
  s = act(s, "stage", { status: "confirming" }); s = confirmAll(s);
  s = act(s, "time", { endAt: "2026-11-02T14:00:00+08:00" });
  assert.equal(s.weeklyPlans[0].endAt, endAt);
  assert.equal(s.weeklyPlans[0].confirmations.length, 0);
  s = act(s, "stage", { status: "confirming" }); s = confirmAll(s); s = act(s, "publish");
  assert.equal(s.bookings[0].startAt, now); assert.equal(s.bookings[0].endAt, endAt);
  assert.equal(s.requests[0].endAt, endAt);
  const monday = { startAt: "2026-11-02T01:00:00.000Z", endAt: "2026-11-02T07:00:00.000Z" };
  assert.equal(scheduleNotes(s.weeklyPlans, id, monday)[0].note, CANADA_NOTE);
  const reopened = act(s, "reopen", {}, admin, monday.startAt);
  assert.equal(reopened.weeklyPlans[0].status, "collecting");
  assert.throws(() => act(s, "reopen", {}, admin, endAt), /已经结束/);
});

test("custom week end validates permissions, bounds and conflicts in the Monday extension", () => {
  let s = setup(1), id = s.resources[0].id;
  assert.throws(() => act(s, "time", { endAt: "2026-11-02T14:00:00+08:00" }, contact), /管理员/);
  for (const endAt of ["invalid", "2026-11-02T14:00:00", now, "2026-11-03T00:01:00+08:00"])
    assert.throws(() => act(s, "time", { endAt }), /结束时间/);
  s = act(s, "time", { endAt: "2026-11-02T14:00:00+08:00" });
  s = act(s, "rows", { rows: [{ resourceId: id, assignments: [{ groupId: "g1", purpose: "周排期" }], specialNote: "" }] });
  s = mutate(s, admin, { type: "resource.timeBlock.save", resourceIds: [id], kind: "upgrade", label: "周一升级", startAt: "2026-11-02T01:00:00.000Z", endAt: "2026-11-02T02:00:00.000Z", reason: "测试", acknowledged: true }, now);
  assert.ok(checkTablePlan(s, s.weeklyPlans[0], now).some(x => /升级|标记/.test(x.message)));
  assert.throws(() => act(s, "stage", { status: "confirming" }), /升级|标记/);
});

test("table plans validate Mondays, inherit previous/default assignments and use an explicit server pool", () => {
  let s = setup();
  assert.throws(() => act(s, "create", { weekStart: "2026-10-27" }), /周一/);
  s = act(s, "pool", { resourceIds: [s.resources[0].id] });
  s = act(s, "rows", { rows: [{ resourceId: s.resources[0].id, assignments: [{ groupId: "g1", purpose: "常态" }, { groupId: "g2", purpose: "共用" }], specialNote: SMOKE_NOTE }] });
  const row = s.weeklyPlans[0].rows![0];
  s = act(s, "defaults", { resourceIds: [row.resourceId], rows: [row] });
  s = act(s, "create", { weekStart: "2026-11-02" });
  assert.deepEqual(s.weeklyPlans[1].rows, [row]); assert.deepEqual(s.weeklyPlans[1].resourceIds, [row.resourceId]);
  assert.equal(s.weeklyPlans[1].confirmations.length, 0);
  assert.throws(() => act(s, "rows", { rows: [{ resourceId: s.resources[1].id, assignments: [], specialNote: "" }] }), /排期服务器/);
  assert.throws(() => act(s, "pool", { resourceIds: [] }, contact), /管理员/);
  s = mutate(s, admin, { type: "site.settings", announcement: "通知", authorSignature: "签名" }, now);
  assert.deepEqual(s.settings.weeklyDefaults, [row], "other settings must preserve normal allocation");
});

test("only administrators can fill negotiated quantities; blank and zero have different meaning", () => {
  let s = demand(setup(), "g1", {}, contact);
  assert.equal(s.weeklyDemands[0].lines[0].negotiated, undefined);
  assert.ok(checkTablePlan(s, s.weeklyPlans[0], now).some(x => /协商后数量/.test(x.message)));
  s = act(s, "negotiate", { demandId: s.weeklyDemands[0].id, lineId: s.weeklyDemands[0].lines[0].id, quantity: 0 });
  assert.equal(s.weeklyDemands[0].lines[0].negotiated, 0);
  assert.equal(checkTablePlan(s, s.weeklyPlans[0], now).filter(x => x.severity === "error").length, 0, "zero negotiated quantity disables topology requirements");
  assert.throws(() => act(s, "negotiate", { demandId: s.weeklyDemands[0].id, lineId: s.weeklyDemands[0].lines[0].id, quantity: 2 }, contact), /管理员/);
  s = act(s, "demand", { demand: { ...s.weeklyDemands[0], lines: [{ ...s.weeklyDemands[0].lines[0], negotiated: 2, sameRackCount: 0 }] } }, contact);
  assert.equal(s.weeklyDemands[0].lines[0].negotiated, 0);
  assert.equal(checkTablePlan(s, s.weeklyPlans[0], now).filter(x => x.severity === "error").length, 0);
});

test("recommendation uses negotiated counts and same rack, reports shortages instead of inventing resources", () => {
  let s = demand(setup(), "g1"); s = act(s, "recommend");
  const a = tableAllocations(s, s.weeklyPlans[0])[0]; assert.equal(a.resourceIds.length, 2);
  assert.equal(new Set(a.resourceIds.map(id => s.resources.find(r => r.id === id)!.rack)).size, 1);
  assert.equal(checkTablePlan(s, s.weeklyPlans[0], now).length, 0);
  let scarce = demand(setup(1)); scarce = act(scarce, "recommend");
  assert.ok(checkTablePlan(scarce, scarce.weeklyPlans[0], now).some(x => /缺1台/.test(x.message)));
  assert.throws(() => act(scarce, "stage", { status: "confirming" }), /缺1台/);
});

test("shared servers count once per group and require allowed shared quantities, all groups confirm before publication", () => {
  let s = demand(demand(setup(2), "g1", { shareCount: 2 }), "g2", { shareCount: 2 });
  s = act(s, "rows", { rows: s.weeklyPlans[0].rows!.map(r => ({ ...r, assignments: [{ groupId: "g1", purpose: "MM1" }, { groupId: "g2", purpose: "MM2" }], specialNote: CANADA_NOTE })) });
  assert.equal(checkTablePlan(s, s.weeklyPlans[0], now).length, 0);
  s = act(s, "stage", { status: "confirming" });
  assert.throws(() => act(s, "publish"), /未确认/);
  assert.throws(() => act(s, "confirm", { groupId: "g1", status: "confirmed", note: "" }), /代确认原因/);
  s = act(s, "confirm", { status: "confirmed", note: "" }, contact);
  assert.throws(() => act(s, "publish"), /未确认/);
  s = act(s, "confirm", { groupId: "g2", status: "confirmed", note: "已与接口人核对" });
  s = act(s, "publish"); assert.equal(s.bookings.length, 4); assert.ok(s.resources.every(r => r.sharingMode === "shared"));
  assert.ok(s.bookings.every(b => b.startAt === now && b.endAt === "2026-11-01T16:00:00.000Z"));
  assert.throws(() => act(s, "publish"), /已发布/);
  s = act(s, "reopen"); assert.equal(s.weeklyPlans[0].confirmations.length, 0);
  s = act(s, "stage", { status: "confirming" }); s = confirmAll(s); s = act(s, "publish", {}, admin, "2026-10-26T05:00:00.000Z");
  assert.equal(s.bookings.filter(b => b.status === "scheduled").length, 4); assert.equal(s.bookings.filter(b => b.status === "released").length, 4);
});

test("same-rack peer groups and share limits block invalid publication", () => {
  let s = demand(setup(), "g1", { sameRackGroupIds: ["g2"] });
  s = act(s, "rows", { rows: s.weeklyPlans[0].rows!.map((r, i) => ({ ...r, assignments: [{ groupId: i < 2 ? "g1" : "g2", purpose: "安排" }] })) });
  assert.equal(checkTablePlan(s, s.weeklyPlans[0], now).length, 0);
  s.weeklyPlans[0].rows![0].assignments.push({ groupId: "g2", purpose: "共用" });
  assert.ok(checkTablePlan(s, s.weeklyPlans[0], now).some(x => /超过允许/.test(x.message)));
  s.weeklyPlans[0].rows![0].assignments.pop(); s.weeklyPlans[0].rows![2].assignments = [];
  assert.ok(checkTablePlan(s, s.weeklyPlans[0], now).some(x => /同柜的要求/.test(x.message)));
});

test("clear affects selected servers only: truncates current use, cancels future/preempted intervals, removes pending use and extension", () => {
  let s = setup(2); const [r1, r2] = s.resources.map(r => r.id);
  s.bookings = ["current", "future", "preempted", "past", "other"].map((id, i) => ({ id, requestId: id, resourceId: id === "other" ? r2 : r1, groupId: "g1", purpose: id, priority: "normal", status: id === "preempted" ? "preempted" : "scheduled", startAt: i === 1 || i === 2 ? "2026-10-27T00:00:00.000Z" : "2026-10-25T00:00:00.000Z", endAt: id === "past" ? "2026-10-25T12:00:00.000Z" : "2026-11-02T00:00:00.000Z", parentId: "", createdAt: now, updatedAt: now }));
  s.requests.push({ id: "pending", resourceIds: [r1, r2], groupId: "g1", startAt: now, endAt: "2026-11-01T00:00:00.000Z", purpose: "申请", priority: "normal", status: "pending", applicantId: "a", applicantName: "申请人", createdAt: now, reviewedAt: "", reviewer: "", reviewNote: "",
    pendingExtension: { id: "ext", originalEndAt: now, endAt: "2026-11-02T00:00:00.000Z", resourceIds: [r1], applicantId: "a", applicantName: "申请人", requestedAt: now, note: "" } });
  const rows = s.weeklyPlans[0].rows!.map(r => ({ ...r, assignments: [{ groupId: "g1", purpose: "分配" }], specialNote: SMOKE_NOTE }));
  s = act(s, "defaults", { resourceIds: [r1, r2], rows }); s = act(s, "rows", { rows });
  assert.throws(() => act(s, "clear", { resourceIds: [r1], reason: "重排" }, contact), /管理员/);
  assert.throws(() => act(s, "clear", { resourceIds: [r1], reason: "" }), /清空原因/);
  s = act(s, "clear", { resourceIds: [r1], reason: "新需求需重新排" });
  assert.equal(s.bookings.find(b => b.id === "current")!.endAt, now); assert.equal(s.bookings.find(b => b.id === "current")!.status, "released");
  assert.equal(s.bookings.find(b => b.id === "future")!.status, "cancelled"); assert.equal(s.bookings.find(b => b.id === "preempted")!.status, "cancelled");
  assert.equal(s.bookings.find(b => b.id === "past")!.endAt, "2026-10-25T12:00:00.000Z"); assert.equal(s.bookings.find(b => b.id === "other")!.status, "scheduled");
  assert.deepEqual(s.requests[0].resourceIds, [r2]); assert.equal(s.requests[0].pendingExtension, undefined);
  assert.equal(s.weeklyPlans[0].rows![0].assignments.length, 0); assert.equal(s.weeklyPlans[0].rows![0].specialNote, SMOKE_NOTE);
  assert.equal(s.weeklyPlans[0].rows![1].assignments.length, 1); assert.equal(s.settings.weeklyDefaults![0].assignments.length, 1);
});

test("draft data stays private, constant allocations count for confirmation, hidden resources and normal templates stay private", () => {
  let s = demand(demand(setup(), "g1"), "g2");
  s = act(s, "rows", { rows: s.weeklyPlans[0].rows!.map((r, i) => ({ ...r, assignments: [{ groupId: i < 2 ? "g1" : "g2", purpose: i < 2 ? "本组安排" : "另组私有安排" }] })) });
  const visitor: Actor = { ...contact, userId: "", role: "visitor" };
  assert.equal(serializePublic(s, visitor, now, true).weeklyPlans.length, 0);
  const own = serializePublic(s, contact, now, true); assert.ok(JSON.stringify(own.weeklyPlans).includes("另组私有安排"));
  s = act(s, "defaults", { resourceIds: s.resources.map(r => r.id), rows: s.weeklyPlans[0].rows });
  assert.equal(serializePublic(s, contact, now, true).settings.weeklyDefaults, undefined);
  s.resources[0].hidden = true;
  assert.ok(!JSON.stringify(serializePublic(s, contact, now, true).weeklyPlans).includes(s.resources[0].id));
});

test("editing resets confirmations and stale generated row revisions are rejected", () => {
  let s = demand(setup()); s = act(s, "recommend"); s = confirmAll(act(s, "stage", { status: "confirming" }));
  assert.equal(s.weeklyPlans[0].confirmations.length, 1);
  assert.throws(() => act(s, "rows", { rows: s.weeklyPlans[0].rows, sourceRevision: s.revision - 1 }), /数据已变化/);
  s = act(s, "rows", { rows: s.weeklyPlans[0].rows }); assert.equal(s.weeklyPlans[0].confirmations.length, 0); assert.equal(s.weeklyPlans[0].status, "draft");
  s = act(s, "pool", { resourceIds: [] }); assert.equal(tableRows(s, s.weeklyPlans[0]).length, 0);
});

test("D1 persists normal templates, table demand negotiation, shared publication and clear atomically", async () => {
  const mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("ok")}}', compatibilityDate: "2026-05-15", d1Databases: ["DB"] });
  try {
    const db = await mf.getD1Database("DB") as unknown as D1Database;
    for (const name of (await readdir("drizzle")).filter(n => n.endsWith(".sql")).sort()) await db.batch((await readFile(`drizzle/${name}`, "utf8")).split("--> statement-breakpoint").filter(x => x.trim()).map(sql => db.prepare(sql)));
    const initial = await loadState(db);
    let s = demand(setup(2)); s = act(s, "recommend");
    s = act(s, "defaults", { resourceIds: s.resources.map(r => r.id), rows: s.weeklyPlans[0].rows!.map(r => ({ ...r, assignments: r.assignments.map(a => ({ groupId: a.groupId, purpose: "常态" })) })) });
    s = confirmAll(act(s, "stage", { status: "confirming" })); s = act(s, "publish");
    await saveState(db, initial, s); const persisted = await loadState(db);
    assert.deepEqual(persisted.settings.weeklyDefaults, s.settings.weeklyDefaults); assert.deepEqual(persisted.weeklyPlans, s.weeklyPlans); assert.deepEqual(persisted.weeklyDemands, s.weeklyDemands);
    const changed = act(persisted, "clear", { resourceIds: [s.resources[0].id], reason: "新需求重排" });
    await saveState(db, persisted, changed);
    await assert.rejects(saveState(db, persisted, act(persisted, "reopen")), /数据刚刚发生变化/);
    const loaded = await loadState(db); assert.equal(loaded.bookings.filter(b => b.status === "scheduled").length, 1);
    assert.deepEqual(loaded.weeklyPlans[0].clearedResourceIds, [s.resources[0].id]); assert.equal(loaded.settings.weeklyDefaults![0].assignments.length, 1);
  } finally { await mf.dispose(); }
});
