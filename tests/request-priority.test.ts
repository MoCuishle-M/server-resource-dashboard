import { test } from "node:test";
import assert from "node:assert/strict";
import { activeBookings, emptyState, groupUsage, mutate, serializePublic } from "../lib/domain";
import { priorityAdjustmentPreview } from "../lib/priority-adjustment";
import { displayBookings } from "../lib/priority";
import type { Actor, Priority, State } from "../lib/types";
import { readFile, readdir } from "node:fs/promises";
import { Miniflare } from "miniflare";
import { loadState, saveState } from "../lib/repository";

const now = "2026-10-23T00:00:00.000Z", startAt = "2026-10-23T01:00:00.000Z", endAt = "2026-10-23T11:00:00.000Z";
const admin: Actor = { userId: "a", displayName: "管理员", email: "a@test", role: "admin", groupId: "", employeeId: "" };
const contact: Actor = { ...admin, userId: "c", role: "contact", groupId: "g1" };
const act = (s: State, action: Record<string, unknown>, who = admin, at = now) => mutate(s, who, action as never, at);
function setup(shared = true) {
  let s = emptyState();
  for (let i = 0; i < 2; i++) s = act(s, { type: "resource.save", resource: { name: `server${i}`, ip: `192.0.2.${i + 1}`, type: "A3", accessMode: "bare", sharingMode: shared ? "shared" : "exclusive", status: "available", location: "", note: "" } });
  s = act(s, { type: "request.create", resourceIds: s.resources.map(r => r.id), groupId: "g1", purpose: "原任务", priority: "normal", startAt, endAt });
  return act(s, { type: "request.review", id: s.requests[0].id, approve: true });
}
function peer(s: State, groupId: string, priority = "normal", range = { startAt, endAt }) {
  s = act(s, { type: "request.create", resourceIds: [s.resources[0].id], groupId, purpose: `并行${groupId}`, priority, ...range });
  return act(s, { type: "request.review", id: s.requests.at(-1)!.id, approve: true, preempt: true, note: "协调" });
}
const action = (s: State, priority: Priority = "high", extra = {}) => ({ type: "request.changePriority", id: s.requests[0].id, resourceIds: s.requests[0].resourceIds, priority, note: "任务变更", confirm: true, ...extra });

test("admin reprioritizes approved schedules without changing dates, approval or unrelated requests", () => {
  const original = peer(setup(), "g2");
  const next = act(original, action(original));
  assert.deepEqual(next.requests[0], { ...original.requests[0], priority: "high" });
  assert.deepEqual(next.requests[1], original.requests[1]);
  assert.deepEqual(activeBookings(next, "2026-10-23T02:00:00.000Z").map(b => b.groupId), ["g1", "g1"]);
  assert(next.bookings.filter(b => b.requestId === next.requests[0].id).every(b => b.priority === "high"));
  const audit = next.audits.at(-1)!;
  assert.equal(audit.action, "调整排期优先级");
  assert.equal(JSON.parse(audit.before).request.priority, "normal");
  assert.equal(JSON.parse(audit.after).request.priority, "high");
  assert.match(audit.summary, /普通 → 高优/);
  assert.equal(original.requests[0].priority, "normal");
});

test("raising a second peer to the same rank allows sharing; lowering restores lower bookings", () => {
  let s = peer(setup(), "g2");
  s = act(s, action(s));
  const second = s.requests[1];
  s = act(s, action(s, "high", { id: second.id, resourceIds: second.resourceIds }));
  assert.deepEqual(activeBookings(s, "2026-10-23T02:00:00.000Z").filter(b => b.resourceId === s.resources[0].id).map(b => b.groupId).sort(), ["g1", "g2"]);
  s = act(s, action(s, "urgent"));
  assert.deepEqual(activeBookings(s, "2026-10-23T02:00:00.000Z").filter(b => b.resourceId === s.resources[0].id).map(b => b.groupId), ["g1"]);
  s = act(s, action(s, "normal"));
  assert.deepEqual(activeBookings(s, "2026-10-23T02:00:00.000Z").filter(b => b.resourceId === s.resources[0].id).map(b => b.groupId), ["g2"]);
});

test("ongoing changes preserve elapsed priority and usage through repeated adjustments", () => {
  let s = peer(setup(), "g2");
  const at = "2026-10-23T04:00:00.000Z", later = "2026-10-23T06:00:00.000Z";
  s = act(s, action(s), admin, at);
  assert.equal(groupUsage(s, "g2", at).hours, 3);
  assert.equal(groupUsage(s, "g2", later).hours, 3);
  s = act(s, action(s, "normal"), admin, later);
  assert.equal(groupUsage(s, "g2", endAt).hours, 8);
  assert.deepEqual(s.bookings.filter(b => b.requestId === s.requests[0].id && b.resourceId === s.resources[0].id).map(b => [b.startAt, b.endAt, b.priority]), [
    [startAt, at, "normal"], [at, later, "high"], [later, endAt, "normal"],
  ]);
});

test("a single-server priority change splits only selected resources into an approved child request", () => {
  const original = setup();
  const next = act(original, action(original, "high", { resourceIds: [original.resources[0].id] }));
  assert.equal(next.requests.length, 2);
  assert.deepEqual(next.requests[0].resourceIds, [original.resources[1].id]);
  assert.equal(next.requests[0].priority, "normal");
  assert.equal(next.requests[1].priority, "high");
  assert.equal(next.requests[1].status, "approved");
  assert.equal(next.requests[1].sourceRequestId, original.requests[0].id);
  assert.equal(next.bookings.find(b => b.resourceId === original.resources[0].id)!.requestId, next.requests[1].id);
  assert.deepEqual(next.bookings.filter(b => b.resourceId === original.resources[1].id), original.bookings.filter(b => b.resourceId === original.resources[1].id));
});

test("priority edits preserve cancellations and old preempted gaps, including descendant splits", () => {
  let s = setup(false);
  s = peer(s, "g2", "high", { startAt: "2026-10-23T04:00:00.000Z", endAt: "2026-10-23T06:00:00.000Z" });
  const original = structuredClone(s.bookings.filter(b => b.status === "preempted"));
  s = act(s, action(s, "urgent"), admin, "2026-10-23T07:00:00.000Z");
  assert.deepEqual(s.bookings.filter(b => b.status === "preempted"), original);
  assert.deepEqual(displayBookings(s.bookings).filter(b => b.status === "preempted").map(b => [b.startAt, b.endAt]), [["2026-10-23T04:00:00.000Z", "2026-10-23T06:00:00.000Z"]]);
  assert(!activeBookings(s, "2026-10-23T05:00:00.000Z").some(b => b.groupId === "g1" && b.resourceId === s.resources[0].id));
  let partial = setup();
  partial = act(partial, { type: "request.cancelPartial", id: partial.requests[0].id, resourceIds: [partial.resources[0].id], startAt: "2026-10-23T04:00:00.000Z", endAt: "2026-10-23T06:00:00.000Z", note: "取消中间段" });
  const cancelled = structuredClone(partial.bookings.filter(b => b.status === "cancelled"));
  const changed = act(partial, action(partial));
  assert.deepEqual(changed.bookings.filter(b => b.status === "cancelled"), cancelled);
  assert(!activeBookings(changed, "2026-10-23T05:00:00.000Z").some(b => b.resourceId === partial.resources[0].id));
});

test("preview uses actual remaining intervals and reports both displaced and restored peers", () => {
  let s = peer(setup(), "g2");
  const at = "2026-10-23T04:00:00.000Z";
  const preview = priorityAdjustmentPreview(s.bookings, s.resources, s.requests[0], s.requests[0].resourceIds, "high", at);
  assert.equal(preview.changes.length, 2);
  assert.equal(preview.impacts.length, 1);
  assert.deepEqual([preview.impacts[0].startAt, preview.impacts[0].endAt, preview.impacts[0].isBlocked], [at, endAt, true]);
  s = act(s, action(s));
  assert(priorityAdjustmentPreview(s.bookings, s.resources, s.requests[0], s.requests[0].resourceIds, "normal", now).impacts.every(p => p.wasBlocked && !p.isBlocked));
});

test("non-admin, invalid, unchanged, unconfirmed and expired priority edits fail atomically", () => {
  const s = setup(), snapshot = structuredClone(s);
  for (const role of ["visitor", "member", "contact"] as const) assert.throws(() => act(s, action(s), { ...contact, role }), /仅服务器管理员/);
  for (const extra of [{ resourceIds: [] }, { resourceIds: ["missing"] }, { priority: "custom" }, { priority: "normal" }, { note: " " }, { note: "字".repeat(1001) }, { confirm: false }]) assert.throws(() => act(s, action(s, "high", extra)));
  assert.throws(() => act(s, action(s), admin, endAt), /尚未结束/);
  const cancelled = act(s, { type: "request.cancel", id: s.requests[0].id });
  assert.throws(() => act(cancelled, action(cancelled)), /尚未结束/);
  assert.deepEqual(s, snapshot);
});

test("admin changes pending priority without approval or bookings; approval uses the new value", () => {
  let s = setup();
  s = act(s, { type: "request.create", resourceIds: s.resources.map(r => r.id), groupId: "g2", purpose: "待审批测试", priority: "normal", startAt, endAt });
  const id = s.requests.at(-1)!.id;
  const update = { ...action(s), id };
  const snapshot = structuredClone(s);
  for (const role of ["visitor", "member", "contact"] as const) assert.throws(() => act(s, update, { ...contact, role }), /仅服务器管理员/);
  for (const extra of [{ resourceIds: [s.resources[0].id] }, { priority: "custom" }, { priority: "normal" }, { note: " " }, { confirm: false }]) assert.throws(() => act(s, { ...update, ...extra }));
  assert.throws(() => act(s, update, admin, endAt), /尚未结束/);
  assert.deepEqual(s, snapshot);
  s = act(s, update);
  assert.equal(s.requests.at(-1)!.priority, "high");
  assert.equal(s.requests.at(-1)!.status, "pending");
  assert.deepEqual(s.bookings, snapshot.bookings);
  assert.equal(s.audits.at(-1)!.action, "调整申请优先级");
  s = act(s, { ...update, priority: "urgent" });
  s = act(s, { type: "request.review", id, approve: true, preempt: true, note: "批准调整后的申请" });
  assert(s.bookings.filter(b => b.requestId === id).every(b => b.priority === "urgent"));
  assert.equal(s.requests.at(-1)!.status, "approved");
});

test("priority audit and split requests respect hidden-resource privacy", () => {
  const original = setup(); original.resources[0].hidden = true;
  const next = act(original, action(original, "high", { resourceIds: [original.resources[1].id] }));
  const visible = serializePublic(next, { ...contact, role: "visitor" }, now, true);
  assert(!visible.requests.some(r => r.id === original.requests[0].id));
  assert(visible.requests.some(r => r.id === next.requests[1].id));
  assert(!visible.audits.some(a => a.action === "调整排期优先级"));
});

test("pending renewal, deleted resources and completely cancelled selections block priority edits", () => {
  const original = setup();
  const renewal = act(original, { type: "request.extend", id: original.requests[0].id, resourceIds: original.requests[0].resourceIds, endAt: "2026-10-23T12:00:00.000Z" }, contact);
  assert.throws(() => act(renewal, action(renewal)), /待审批续期/);
  const deleted = structuredClone(original); deleted.resources[0].deleted = true;
  assert.throws(() => act(deleted, action(deleted)), /已删除/);
  const partial = act(original, { type: "request.cancelPartial", id: original.requests[0].id, resourceIds: [original.resources[0].id], startAt, endAt, note: "释放单台全部时段" });
  assert.throws(() => act(partial, action(partial, "high", { resourceIds: [original.resources[0].id] })), /已无剩余排期/);
});

test("real D1 persists priority splits and rejects a stale competing edit without partial writes", async () => {
  const mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("ok")}}', compatibilityDate: "2026-05-15", d1Databases: ["DB"] });
  try {
    const db = await mf.getD1Database("DB") as unknown as D1Database;
    const sql = (await Promise.all((await readdir("drizzle")).filter(f => f.endsWith(".sql")).sort().map(f => readFile(`drizzle/${f}`, "utf8")))).join("\n--> statement-breakpoint\n");
    await db.batch(sql.split("--> statement-breakpoint").filter(x => x.trim()).map(x => db.prepare(x)));
    const initial = await loadState(db), baseline = peer(setup(), "g2");
    await saveState(db, initial, baseline);
    const loaded = await loadState(db), at = "2026-10-23T04:00:00.000Z";
    const high = act(loaded, action(loaded, "high", { resourceIds: [loaded.resources[0].id] }), admin, at);
    const urgent = act(loaded, action(loaded, "urgent", { resourceIds: [loaded.resources[0].id] }), admin, at);
    const results = await Promise.allSettled([saveState(db, loaded, high), saveState(db, loaded, urgent)]);
    assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
    const persisted = await loadState(db), winner = results[0].status === "fulfilled" ? high : urgent;
    assert.equal(persisted.revision, loaded.revision + 1);
    assert.equal(persisted.requests.length, winner.requests.length);
    assert.equal(persisted.bookings.length, winner.bookings.length);
    assert.equal(persisted.audits.filter(a => a.action === "调整排期优先级").length, 1);
    assert.deepEqual(persisted.requests.find(r => r.sourceRequestId === loaded.requests[0].id), winner.requests.find(r => r.sourceRequestId === loaded.requests[0].id));
    assert.equal(groupUsage(persisted, "g2", endAt).hours, 3);
    const pending = act(persisted, { type: "request.create", resourceIds: [persisted.resources[0].id], groupId: "g3", purpose: "持久化待审批优先级", priority: "normal", startAt, endAt });
    await saveState(db, persisted, pending);
    const edited = act(pending, { ...action(pending, "urgent"), id: pending.requests.at(-1)!.id, resourceIds: [pending.resources[0].id] });
    await saveState(db, pending, edited);
    const reloaded = await loadState(db);
    assert.equal(reloaded.requests.find(r => r.id === pending.requests.at(-1)!.id)!.priority, "urgent");
    assert.equal(reloaded.requests.find(r => r.id === pending.requests.at(-1)!.id)!.status, "pending");
    assert.deepEqual(reloaded.bookings, pending.bookings);
  } finally { await mf.dispose(); }
});
