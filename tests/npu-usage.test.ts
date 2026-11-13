import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { Miniflare } from "miniflare";
import { analyzeUsage, minuteMs, usageRange } from "../lib/npu-usage";
import { authorizeCollector, readCollectorPayload, readUsage, saveUsage } from "../lib/npu-storage";
import type { Booking, Group, Resource } from "../lib/types";

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
    const result = await readUsage(db, { ...emptyState(), resources: [resource], groups, bookings: [booking("a", "a", 540, 542)] },
      new URL(`https://test.invalid/?start=${day}&end=${day}`), now);
    assert.equal(result.groups[0].observed, 16);
    assert.equal(result.groups[0].occupied, 4);
    assert.equal(result.machines[0].snapshot.at, sample.snapshot.at);
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
