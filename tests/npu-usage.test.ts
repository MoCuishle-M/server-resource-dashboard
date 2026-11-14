import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { Miniflare } from "miniflare";
import { analyzeUsage, minuteMs, usageRange } from "../lib/npu-usage";
import { authorizeCollector, readCollectorPayload, readUsage, saveUsage } from "../lib/npu-storage";
import type { Actor, Booking, Group, Resource } from "../lib/types";

const day = "2026-11-10";
const midnight = Date.parse(`${day}T00:00:00+08:00`);
const at = (minute: number) => new Date(midnight + minute * minuteMs).toISOString();
const now = Date.parse(at(600));
const resource: Resource = {
  id: "r1", name: "示例服务器", ip: "192.0.2.1", type: "NPU", accessMode: "bare",
  sharingMode: "shared", zone: "blue", location: "", note: "", status: "available",
  deleted: false, createdAt: at(0), updatedAt: at(0),
};
const groups: Group[] = ["a", "b", "c"].map(id => ({ id, name: id, contactName: "", employeeId: "" }));
const admin: Actor = { userId: "admin", email: "admin@example.test", displayName: "管理员", role: "admin", groupId: "", employeeId: "" };
const booking = (id: string, groupId: string, from: number, to: number, priority: Booking["priority"] = "normal"): Booking => ({
  id, resourceId: resource.id, groupId, requestId: id, startAt: at(from), endAt: at(to), priority,
  status: "scheduled", purpose: "", parentId: "", createdAt: at(0), updatedAt: at(0),
});

test("shared observations count for each group while same-group duplicates and fleet are counted once", () => {
  const state = {
    resources: [{ ...resource, sharingMode: "exclusive" as const }], groups,
    bookings: [
      booking("a1", "a", 540, 544), booking("a2", "a", 541, 542),
      booking("b1", "b", 541, 544), booking("c1", "c", 542, 543, "high"),
    ],
  };
  const result = analyzeUsage(state, [{
    resourceId: resource.id, day, expected: 8,
    samples: { 540: [8, 0, 8, 0], 541: [8, 4, 8, 240], 542: [8, 8, 8, 640] },
  }], [{ resourceId: resource.id, expected: 8, snapshot: { at: now, cards: [] } }],
  usageRange(day, day, now), "b", resource.id);
  const [a, b, c] = result.groups;
  assert.deepEqual([a.observed, a.occupied, a.expected], [16, 4, 24]);
  assert.deepEqual([b.observed, b.occupied, b.expected], [8, 4, 16]);
  assert.deepEqual([a.shared, b.shared, a.sharedOccupied, b.sharedOccupied], [16, 16, 4, 4]);
  assert.deepEqual([c.observed, c.occupied, c.shared], [8, 8, 0]);
  assert.equal(result.fleet.occupied, 12);
  assert.equal(result.groupHeatmap[0].values[36].sharedOccupied, 4);
  assert.deepEqual(result.groupTrend[36], result.groupHeatmap[0].values[36]);
  assert.equal(result.machineTrend[36].observed, 24);
});

test("a shared booking stops during upgrade and preserves valid history before release", () => {
  const host: Resource = { ...resource, timeBlocks: [{
    id: "upgrade", kind: "upgrade", label: "", startAt: at(541), endAt: at(542),
    status: "active", createdAt: at(0), updatedAt: at(0),
  }] };
  const released = { ...booking("a", "a", 540, 543), status: "released" as const };
  const analysis = analyzeUsage({ resources: [host], groups, bookings: [released] },
    [{ resourceId: host.id, day, expected: 8, samples: { 540: [8, 1, 8, 80], 541: [8, 8, 8, 800], 542: [8, 2, 8, 160] } }],
    [{ resourceId: host.id, expected: 8, snapshot: { at: now, cards: [] } }],
    usageRange(day, day, now));
  assert.equal(analysis.groups[0].expected, 16);
  assert.equal(analysis.groups[0].occupied, 3);
});

test("day-only and snapshot-only machines remain visible without double counting machines with both", () => {
  const second = { ...resource, id: "r2" };
  const third = { ...resource, id: "r3" };
  const result = analyzeUsage({ resources: [resource, second, third], groups, bookings: [] }, [
    { resourceId: resource.id, day, expected: 8, samples: { 540: [8, 4, 8, 240] } },
    { resourceId: second.id, day, expected: 4, samples: { 540: [4, 2, 4, 120] } },
  ], [
    { resourceId: second.id, expected: 4, snapshot: { at: now, cards: [] } },
    { resourceId: third.id, expected: 8, snapshot: { at: now, cards: [] } },
  ], usageRange(day, day, now), "", resource.id);
  assert.equal(result.machines.length, 3);
  assert.equal(result.machines.find(row => row.id === resource.id)?.snapshot, null);
  assert.equal(result.fleet.observed, 12);
  assert.equal(result.fleet.occupied, 6);
  assert.equal(result.fleet.expected, 20 * 600);
  assert.equal(result.machineTrend[36].observed, 8);
});

test("D1 minute-only uploads appear in machine and group analysis; non-blue resources are rejected without writes", async () => {
  const mf = new Miniflare({
    modules: true, script: 'export default {fetch(){return new Response("ok")}}',
    compatibilityDate: "2026-05-15", d1Databases: ["DB"],
  });
  try {
    const db = await mf.getD1Database("DB") as unknown as D1Database;
    const sql = await Promise.all((await readdir("drizzle")).filter(name => name.endsWith(".sql")).sort()
      .map(name => readFile(`drizzle/${name}`, "utf8")));
    await db.batch(sql.flatMap(text => text.split("--> statement-breakpoint")).filter(x => x.trim()).map(x => db.prepare(x)));
    const hosts = [resource, { ...resource, id: "green", ip: "192.0.2.2", zone: "green" },
      { ...resource, id: "unknown", ip: "192.0.2.3", zone: undefined }];
    await db.batch(hosts.map(host => db.prepare("INSERT INTO resources (id, payload) VALUES (?, ?)")
      .bind(host.id, JSON.stringify(host))));
    const sample = { day, ip: resource.ip, expected: 8, points: [[540, 8, 4, 8, 240]] };
    await saveUsage(db, sample, now);
    for (const host of hosts.slice(1)) {
      await assert.rejects(saveUsage(db, { ...sample, ip: host.ip }, now), /匹配蓝区资源/);
    }
    const { emptyState } = await import("../lib/domain");
    const result = await readUsage(db, { ...emptyState(), resources: [resource], groups, bookings: [booking("a", "a", 540, 541)] }, admin,
      new URL(`https://test.invalid/?start=${day}&end=${day}&group=a&machine=${resource.id}`), now);
    assert.equal(result.machines.length, 1);
    assert.equal(result.machines[0].snapshot, null);
    assert.equal(result.fleet.observed, 8);
    assert.equal(result.fleet.occupied, 4);
    assert.equal(result.groups[0].expected, 8);
    assert.equal(result.groups[0].observed, 8);
    assert.equal(result.groupTrend[36].occupied, 4);
    assert.equal(result.machineTrend[36].observed, 8);
    assert.equal((await db.prepare("SELECT count(*) AS count FROM npu_days").first<{ count: number }>())?.count, 1);
    assert.equal((await db.prepare("SELECT count(*) AS count FROM npu_latest").first<{ count: number }>())?.count, 0);
  } finally {
    await mf.dispose();
  }
});

test("D1 ingest authenticates, merges repeat uploads and keeps the newest snapshot", async () => {
  const secret = "test-token-for-local-d1-integration";
  await assert.rejects(authorizeCollector(new Request("https://test.invalid"), secret), /认证失败/);
  await assert.rejects(authorizeCollector(new Request("https://test.invalid"), undefined), /尚未配置/);
  await authorizeCollector(new Request("https://test.invalid", { headers: { Authorization: `Bearer ${secret}` } }), secret);
  const mf = new Miniflare({
    modules: true, script: 'export default {fetch(){return new Response("ok")}}',
    compatibilityDate: "2026-05-15", d1Databases: ["DB"],
  });
  try {
    const db = await mf.getD1Database("DB") as unknown as D1Database;
    const files = (await readdir("drizzle")).filter(name => name.endsWith(".sql")).sort();
    const sql = await Promise.all(files.map(name => readFile(`drizzle/${name}`, "utf8")));
    await db.batch(sql.flatMap(text => text.split("--> statement-breakpoint")).filter(x => x.trim()).map(x => db.prepare(x)));
    await db.prepare("INSERT INTO resources (id, payload) VALUES (?, ?)").bind(resource.id, JSON.stringify(resource)).run();
    const sample = { day, ip: resource.ip, expected: 8, points: [[541, 8, 4, 8, 240]],
      snapshot: { at: Date.parse(at(541)), cards: [{ key: "0-0", state: "active", util: 30, hbm: 40 }] } };
    await saveUsage(db, sample, now);
    await saveUsage(db, sample, now);
    await saveUsage(db, { ...sample, points: [[540, 8, 0, 8, 0]], snapshot: { ...sample.snapshot, at: Date.parse(at(540)) } }, now);
    await assert.rejects(saveUsage(db, { ...sample, ip: "192.0.2.255" }, now), /匹配蓝区资源/);
    const { emptyState } = await import("../lib/domain");
    const hidden = { ...resource, id: "hidden", ip: "192.0.2.2", hidden: true };
    await db.prepare("INSERT INTO resources (id, payload) VALUES (?, ?)").bind(hidden.id, JSON.stringify(hidden)).run();
    await saveUsage(db, { ...sample, ip: hidden.ip }, now);
    const state = { ...emptyState(), resources: [resource, hidden], groups, bookings: [
      booking("a", "a", 540, 542), { ...booking("hidden", "b", 541, 542), resourceId: hidden.id },
    ] };
    const url = new URL(`https://test.invalid/?start=${day}&end=${day}&machine=hidden&group=b`);
    const result = await readUsage(db, state, admin, url, now);
    assert.equal(result.groups[0].observed, 16);
    assert.equal(result.groups[0].occupied, 4);
    assert.equal(result.machines[0].snapshot?.at, sample.snapshot.at);
    assert.equal(result.machines.length, 2);
    assert.equal(result.fleet.observed, 24);
    assert.equal(result.groupHeatmap.length, 1);
    const contact = { ...admin, role: "contact" as const, groupId: "a" };
    const visible = await readUsage(db, state, contact, url, now);
    assert.deepEqual(visible.machines.map(machine => machine.id), [resource.id]);
    assert.equal(visible.fleet.observed, 16);
    assert.equal(visible.groups[1].expected, 0);
    assert.deepEqual(visible.groupHeatmap, []);
    assert.deepEqual(visible.machineTrend, []);
    const visitor: Actor = { userId: "", email: "", displayName: "访客", role: "visitor", groupId: "", employeeId: "" };
    const publicResult = await readUsage(db, state, visitor, url, now);
    assert.deepEqual(publicResult, visible);
    assert(!JSON.stringify(publicResult).includes(hidden.id));
    const publicDetails = await readUsage(db, state, visitor,
      new URL(`https://test.invalid/?start=${day}&end=${day}&group=a&machine=${resource.id}`), now);
    assert.equal(publicDetails.machineTrend[36].observed, 16);
    assert.equal(publicDetails.groupTrend[36].occupied, 4);
    assert.deepEqual(publicDetails.groupHeatmap.map(machine => machine.id), [resource.id]);
    assert.equal(publicDetails.machines[0].snapshot?.at, sample.snapshot.at);
    await assert.rejects(readUsage(db, state, { ...admin, role: "member" }, url, now), { status: 403 });
  } finally {
    await mf.dispose();
  }
});

test("collector body size is enforced on received bytes and malformed JSON is rejected", async () => {
  const request = (body: string) => new Request("https://test.invalid", {
    method: "POST", body, headers: { "Content-Type": "application/json" },
  });
  await assert.rejects(readCollectorPayload(request(JSON.stringify("测".repeat(40_000)))), /数据过大/);
  await assert.rejects(readCollectorPayload(request("{")), /不是有效的 JSON/);
  assert.deepEqual(await readCollectorPayload(request('{"day":"2026-11-10"}')), { day });
});
