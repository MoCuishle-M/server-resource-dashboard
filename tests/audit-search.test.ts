import test from "node:test";
import assert from "node:assert/strict";
import { auditRange, auditTime, filterAudits } from "../lib/audit-search";
import type { Audit } from "../lib/types";
const audits: Audit[] = [
  { id: "1", at: "2026-10-20T15:59:59.999Z", action: "新增服务器", actorName: "张三", summary: "新增 Alpha", actorId: "a", entityType: "resource", entityId: "r", before: "null", after: "null" },
  { id: "2", at: "2026-10-20T16:00:00.000Z", action: "修改服务器", actorName: "李四", summary: "更新 Alpha", actorId: "b", entityType: "resource", entityId: "r", before: "null", after: "null" },
  { id: "3", at: "2026-10-20T16:00:00.999Z", action: "批准申请", actorName: "张三", summary: "批准训练任务", actorId: "a", entityType: "request", entityId: "q", before: "null", after: "null" },
  { id: "4", at: "2026-10-20T16:00:01.000Z", action: "修改服务器", actorName: "李四", summary: "更新 Beta", actorId: "b", entityType: "resource", entityId: "r2", before: "null", after: "null" },
];
const ids = (options: Parameters<typeof filterAudits>[1]) => filterAudits(audits, options).map(a => a.id);
test("history filters combine multiple exact action types and case-insensitive keywords", () => {
  assert.deepEqual(ids({ types: ["新增服务器", "修改服务器"], search: "alpha" }), ["2", "1"]);
  assert.deepEqual(ids({ types: null, search: " 张三 " }), ["3", "1"]);
  assert.deepEqual(ids({ types: [], search: "" }), []);
  assert.deepEqual(ids({ types: ["未知操作"], search: "" }), []);
});
test("history time uses Beijing dates and includes the selected ending second", () => {
  const range = auditRange("2026-10-21T00:00:00", "2026-10-21T00:00:00");
  assert.equal(range.startAt, Date.parse("2026-10-20T16:00:00Z"));
  assert.equal(range.endAt, Date.parse("2026-10-20T16:00:00.999Z"));
  assert.deepEqual(ids({ types: null, search: "", ...range }), ["3", "2"]);
  assert.deepEqual(ids({ types: ["修改服务器"], search: "", ...range }), ["2"]);
});
test("open-ended and minute-precision ranges work across midnight without mutating source data", () => {
  assert.deepEqual(ids({ types: null, search: "", ...auditRange("", "2026-10-20T23:59") }), ["1"]);
  assert.deepEqual(ids({ types: null, search: "", ...auditRange("2026-10-21T00:00:01", "") }), ["4"]);
  assert.deepEqual(ids({ types: null, search: "", ...auditRange("", "") }), ["4", "3", "2", "1"]);
  assert.deepEqual(audits.map(a => a.id), ["1", "2", "3", "4"]);
});
test("invalid ranges are rejected and history timestamps retain year and seconds", () => {
  assert.throws(() => auditRange("2026-10-22T00:00", "2026-10-21T23:59"), /不能早于/);
  assert.throws(() => auditRange("invalid", ""), /完整/);
  assert.throws(() => auditRange("2026-10-21T99:00", ""), /格式/);
  assert.match(auditTime(audits[1].at), /2026.*10.*21.*00:00:00/);
});
