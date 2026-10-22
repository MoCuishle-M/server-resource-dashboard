import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { Miniflare } from "miniflare";
import { loadState, saveState } from "../lib/repository";
import { mutate } from "../lib/domain";
import type { Actor } from "../lib/types";
const admin: Actor = {
  userId: "a",
  email: "a@test",
  displayName: "管理员",
  role: "admin",
  groupId: "",
  employeeId: "",
};
const now = "2026-10-20T00:00:00.000Z";
const resource = {
  name: "s1",
  ip: "192.0.2.1",
  type: "910B",
  accessMode: "bare",
  status: "available",
  location: "",
  note: "",
};
test("real D1 persistence, atomic rollback and concurrent writers", async () => {
  const mf = new Miniflare({
    modules: true,
    script: 'export default {fetch(){return new Response("ok")}}',
    compatibilityDate: "2026-05-15",
    d1Databases: ["DB"],
  });
  try {
    const db = (await mf.getD1Database("DB")) as unknown as D1Database;
    const sql = (await Promise.all((await readdir("drizzle")).filter(name => name.endsWith(".sql")).sort()
      .map(name => readFile(`drizzle/${name}`, "utf8")))).join("\n--> statement-breakpoint\n");
    await db.batch(
      sql
        .split("--> statement-breakpoint")
        .filter((x) => x.trim())
        .map((x) => db.prepare(x)),
    );
    const initial = await loadState(db);
    assert.equal(initial.revision, 0);
    assert.equal(initial.groups.length, 11);
    const first = mutate(
      initial,
      admin,
      { type: "resource.save", resource },
      now,
    );
    await saveState(db, initial, first);
    const loaded = await loadState(db);
    assert.deepEqual(loaded, first);
    const a = mutate(
      loaded,
      admin,
      {
        type: "resource.save",
        resource: { ...resource, name: "s2", ip: "192.0.2.2" },
      },
      now,
    );
    const b = mutate(
      loaded,
      admin,
      {
        type: "resource.save",
        resource: { ...resource, name: "s3", ip: "192.0.2.3" },
      },
      now,
    );
    const result = await Promise.allSettled([
      saveState(db, loaded, a),
      saveState(db, loaded, b),
    ]);
    assert.equal(result.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(result.filter((r) => r.status === "rejected").length, 1);
    const after = await loadState(db);
    assert.equal(after.revision, 2);
    assert.equal(after.resources.length, 2);
    assert.equal(after.audits.length, 2);
    await assert.rejects(saveState(db, initial, first), /数据刚刚发生变化/);
    assert.deepEqual(await loadState(db), after);
    const guards = await db
      .prepare("SELECT COUNT(*) AS count FROM guards")
      .first<{ count: number }>();
    assert.equal(guards?.count, 0);
    // Two conflicting approvals from the same snapshot cannot both commit.
    let planned = mutate(
      after,
      { ...admin, role: "contact", groupId: "g1" },
      {
        type: "request.create",
        resourceIds: [after.resources[0].id],
        startAt: "2026-10-20T01:00:00.000Z",
        endAt: "2026-10-20T04:00:00.000Z",
        purpose: "任务A",
        priority: "normal",
      },
      now,
    );
    await saveState(db, after, planned);
    let next = mutate(
      planned,
      { ...admin, role: "contact", groupId: "g2" },
      {
        type: "request.create",
        resourceIds: [after.resources[0].id],
        startAt: "2026-10-20T02:00:00.000Z",
        endAt: "2026-10-20T05:00:00.000Z",
        purpose: "任务B",
        priority: "normal",
      },
      now,
    );
    await saveState(db, planned, next);
    const approved = next.requests.map((r) =>
      mutate(
        next,
        admin,
        { type: "request.review", id: r.id, approve: true, note: "" },
        now,
      ),
    );
    const concurrent = await Promise.allSettled(
      approved.map((a) => saveState(db, next, a)),
    );
    assert.equal(concurrent.filter((r) => r.status === "fulfilled").length, 1);
    const final = await loadState(db);
    assert.equal(final.bookings.length, 1);
    assert.equal(
      final.requests.filter((r) => r.status === "pending").length,
      1,
    );
    const published = mutate(final, admin, { type: "site.settings", announcement: "D1持久化公告", authorSignature: "测试作者" }, now);
    await saveState(db, final, published);
    const invited = mutate(published, admin, { type: "admin.invite", email: "next@example.test" }, now);
    await saveState(db, published, invited);
    assert.deepEqual(await loadState(db), { ...invited,
      audits: [...invited.audits].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id)),
    });
    const staleSettings = mutate(final, admin, { type: "site.settings", announcement: "不应写入" }, now);
    await assert.rejects(saveState(db, final, staleSettings), /数据刚刚发生变化/);
    assert.equal((await loadState(db)).settings.announcement, "D1持久化公告");
    const booking = invited.bookings[0];
    const partial = mutate(invited, admin, {
      type: "request.cancelPartial", id: booking.requestId, resourceIds: [booking.resourceId],
      startAt: new Date(Date.parse(booking.startAt) + 30 * 60000).toISOString(),
      endAt: new Date(Date.parse(booking.startAt) + 60 * 60000).toISOString(),
      note: "D1部分取消验证",
    }, now);
    await saveState(db, invited, partial);
    const persisted = await loadState(db);
    assert.equal(persisted.revision, partial.revision);
    assert.deepEqual([...persisted.bookings].sort((a, b) => a.id.localeCompare(b.id)), [...partial.bookings].sort((a, b) => a.id.localeCompare(b.id)));
    assert.equal(persisted.bookings.filter(b => b.status === "scheduled").length, 2);
    assert.equal(persisted.audits.filter(a => a.action === "取消部分时段").length, 1);
    const staleCancel = mutate(invited, admin, { type: "request.cancel", id: booking.requestId }, now);
    await assert.rejects(saveState(db, invited, staleCancel), /数据刚刚发生变化/);
    assert.deepEqual(await loadState(db), persisted);
    const privateResource = mutate(persisted, admin, {
      type: "resource.bulkUpdate", ids: [persisted.resources[1].id], changes: { status: "unavailable", hidden: true },
    }, now);
    await saveState(db, persisted, privateResource);
    const privateLoaded = await loadState(db);
    assert.equal(privateLoaded.resources.find(r => r.id === persisted.resources[1].id)?.status, "unavailable");
    assert.equal(privateLoaded.resources.find(r => r.id === persisted.resources[1].id)?.hidden, true);
    const stalePublic = mutate(persisted, admin, { type: "resource.bulkUpdate", ids: [persisted.resources[1].id], changes: { hidden: false } }, now);
    await assert.rejects(saveState(db, persisted, stalePublic), /数据刚刚发生变化/);
    assert.deepEqual(await loadState(db), privateLoaded);
    // A split allocation, its booking links and audit must persist in one revision.
    let allocation = await loadState(db);
    const restored = mutate(allocation, admin, { type: "resource.bulkUpdate", ids: allocation.resources.map(r => r.id), changes: { status: "available" } }, now);
    await saveState(db, allocation, restored);
    allocation = await loadState(db);
    for (const action of [
      { type: "request.create", resourceIds: allocation.resources.map(r => r.id), groupId: "g1", purpose: "整批预留",
        priority: "normal", startAt: "2026-10-21T01:00:00.000Z", endAt: "2026-10-21T04:00:00.000Z" },
      { type: "request.review", approve: true, note: "整批批准" },
    ]) {
      const saved = mutate(allocation, admin, { ...action, ...(action.type === "request.review" ? { id: allocation.requests.at(-1)!.id } : {}) }, now);
      await saveState(db, allocation, saved);
      allocation = await loadState(db);
    }
    const reassigned = mutate(allocation, admin, { type: "request.reassign", id: allocation.requests.at(-1)!.id,
      resourceIds: [allocation.resources[0].id], groupId: "g11", purpose: "平台使用事项" }, now);
    await saveState(db, allocation, reassigned);
    const allocationPersisted = await loadState(db);
    assert.deepEqual(allocationPersisted, { ...reassigned, audits: [...reassigned.audits].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id)) });
    const child = allocationPersisted.requests.find(r => r.purpose === "平台使用事项")!;
    assert(child.sourceRequestId);
    assert.equal(allocationPersisted.bookings.find(b => b.requestId === child.id)!.groupId, "g11");
    const staleAllocation = mutate(allocation, admin, { type: "request.reassign", id: allocation.requests.at(-1)!.id,
      resourceIds: allocation.resources.map(r => r.id), groupId: "g3", purpose: "过期修改" }, now);
    await assert.rejects(saveState(db, allocation, staleAllocation), /数据刚刚发生变化/);
    assert.deepEqual(await loadState(db), allocationPersisted);
  } finally {
    await mf.dispose();
  }
});

test("legacy resource payloads default to exclusive; shared bookings persist for multiple groups", async () => {
  const mf = new Miniflare({
    modules: true,
    script: 'export default {fetch(){return new Response("ok")}}',
    compatibilityDate: "2026-05-15",
    d1Databases: ["DB"],
  });
  try {
    const db = (await mf.getD1Database("DB")) as unknown as D1Database;
    const sql = await readFile("drizzle/0000_rainy_serpent_society.sql", "utf8");
    await db.batch(
      sql
        .split("--> statement-breakpoint")
        .filter((x) => x.trim())
        .map((x) => db.prepare(x)),
    );
    await db
      .prepare("INSERT INTO resources(id,payload) VALUES(?,?)")
      .bind(
        "legacy",
        JSON.stringify({
          ...resource,
          id: "legacy",
          deleted: false,
          createdAt: now,
          updatedAt: now,
        }),
      )
      .run();
    const upgrade = (await Promise.all((await readdir("drizzle"))
      .filter(name => name.endsWith(".sql") && !name.startsWith("0000_")).sort()
      .map(name => readFile(`drizzle/${name}`, "utf8")))).join("\n--> statement-breakpoint\n");
    await db.batch(upgrade.split("--> statement-breakpoint").filter(x => x.trim()).map(x => db.prepare(x)));
    let s = await loadState(db);
    assert.equal(s.resources[0].sharingMode, "exclusive");
    let next = mutate(
      s,
      admin,
      {
        type: "resource.save",
        id: "legacy",
        resource: { ...resource, sharingMode: "shared" },
      },
      now,
    );
    await saveState(db, s, next);
    s = await loadState(db);
    for (const groupId of ["g1", "g2"]) {
      next = mutate(
        s,
        admin,
        {
          type: "request.create",
          groupId,
          resourceIds: ["legacy"],
          startAt: "2026-10-20T01:00:00.000Z",
          endAt: "2026-10-20T04:00:00.000Z",
          purpose: groupId + "共享测试",
          priority: "normal",
        },
        now,
      );
      await saveState(db, s, next);
      s = await loadState(db);
      next = mutate(
        s,
        admin,
        {
          type: "request.review",
          id: s.requests.at(-1)!.id,
          approve: true,
          note: "",
        },
        now,
      );
      await saveState(db, s, next);
      s = await loadState(db);
    }
    assert.equal(s.bookings.filter((b) => b.status === "scheduled").length, 2);
    assert.equal(s.resources[0].sharingMode, "shared");
    assert.deepEqual(
      s.bookings.map((b) => b.groupId),
      ["g1", "g2"],
    );
    await db.prepare("INSERT INTO resources(id,payload) VALUES(?,?)").bind("legacy-platform", JSON.stringify({
      ...resource, id: "legacy-platform", name: "旧灵枢资源", ip: "192.0.2.77", accessMode: "lingshu",
      deleted: false, createdAt: now, updatedAt: now,
    })).run();
    await db.prepare("DELETE FROM groups WHERE id='g11'").run();
    s = await loadState(db);
    assert.equal(s.groups.length, 11);
    assert.equal(s.groups.find(g => g.id === "g11")!.name, "灵枢平台");
    assert.equal(s.resources.find(r => r.id === "legacy-platform")!.lingshuStatus, "platform");
    next = mutate(s, admin, { type: "group.save", id: "g11", name: "灵枢平台", contactName: "平台接口人", employeeId: "L001" }, now);
    await saveState(db, s, next);
    s = await loadState(db);
    assert.equal(s.groups.find(g => g.id === "g11")!.contactName, "平台接口人");
    next = mutate(s, admin, { type: "request.create", groupId: "g11", resourceIds: ["legacy"],
      startAt: "2026-10-20T01:00:00.000Z", endAt: "2026-10-20T04:00:00.000Z", purpose: "平台共享排期", priority: "normal" }, now);
    await saveState(db, s, next);
    s = await loadState(db);
    next = mutate(s, admin, { type: "request.review", id: s.requests.at(-1)!.id, approve: true }, now);
    await saveState(db, s, next);
    assert((await loadState(db)).bookings.some(b => b.groupId === "g11"));
  } finally {
    await mf.dispose();
  }
});
