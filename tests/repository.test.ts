import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
    const sql = await readFile(
      "drizzle/0000_rainy_serpent_society.sql",
      "utf8",
    );
    await db.batch(
      sql
        .split("--> statement-breakpoint")
        .filter((x) => x.trim())
        .map((x) => db.prepare(x)),
    );
    const initial = await loadState(db);
    assert.equal(initial.revision, 0);
    assert.equal(initial.groups.length, 10);
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
  } finally {
    await mf.dispose();
  }
});
