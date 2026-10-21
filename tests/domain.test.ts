import { test } from "node:test";
import assert from "node:assert/strict";
import {
  activeBookings,
  approvalConflicts,
  currentResourceUsage,
  groupUsage,
  emptyState,
  mutate,
  overlaps,
  serializePublic,
  timeRange,
} from "../lib/domain";
import { importRows, csvCell } from "../lib/csv";
import type { Actor, State } from "../lib/types";
const now = "2026-10-20T00:00:00.000Z";
const admin: Actor = {
  userId: "a",
  displayName: "管理员",
  email: "admin@test",
  role: "admin",
  groupId: "",
  employeeId: "",
};
const contact: Actor = {
  userId: "c",
  displayName: "接口人",
  email: "c@test",
  role: "contact",
  groupId: "g1",
  employeeId: "001",
};
const visitor: Actor = {
  userId: "",
  displayName: "访客",
  email: "",
  role: "visitor",
  groupId: "",
  employeeId: "",
};
const member: Actor = { ...contact, role: "member" };
const row = {
  name: "server-1",
  type: "910B",
  ip: "192.0.2.1",
  accessMode: "bare",
  location: "A",
  note: "",
  status: "available",
};
const apply = (s: State, a: Record<string, unknown>, who = admin) =>
  mutate(s, who, a as never, now);
function setup() {
  return apply(emptyState(), { type: "resource.save", resource: row });
}
function request(
  s: State,
  startAt = "2026-10-20T01:00:00.000Z",
  endAt = "2026-10-20T10:00:00.000Z",
  priority = "normal",
  who = contact,
) {
  return apply(
    s,
    {
      type: "request.create",
      groupId: "g2",
      resourceIds: [s.resources[0].id],
      startAt,
      endAt,
      priority,
      purpose: "训练任务",
    },
    who,
  );
}
function approve(s: State, id = s.requests.at(-1)!.id) {
  return apply(s, { type: "request.review", id, approve: true, note: "" });
}
test("ten unconfigured regular groups plus the Lingshu participant", () => {
  const s = emptyState();
  assert.equal(s.groups.length, 11);
  assert(s.groups.every((g) => !g.contactName && !g.employeeId));
});
test("all five windows, cross-midnight and adjacent intervals", () => {
  const expected = [3, 2, 3.5, 3.5, 12];
  for (let i = 0; i < 5; i++) {
    const r = timeRange("2026-10-20", i);
    assert.equal(
      (Date.parse(r.endAt) - Date.parse(r.startAt)) / 3600000,
      expected[i],
    );
  }
  const night = timeRange("2026-10-20", 4);
  assert.equal(night.startAt, "2026-10-20T13:00:00.000Z");
  assert.equal(night.endAt, "2026-10-21T01:00:00.000Z");
  assert(!overlaps(timeRange("2026-10-20", 0), timeRange("2026-10-20", 1)));
});
test("visitor and unverified account cannot mutate resources or apply", () => {
  for (const who of [visitor, member, contact])
    assert.throws(
      () => apply(emptyState(), { type: "resource.save", resource: row }, who),
      /仅服务器管理员/,
    );
  for (const who of [visitor, member])
    assert.throws(
      () => request(setup(), undefined, undefined, undefined, who),
      /接口人认证/,
    );
});
test("CRUD validation and immutable operation history", () => {
  let s = setup();
  const id = s.resources[0].id;
  s = apply(s, {
    type: "resource.save",
    id,
    resource: { ...row, note: "已修改" },
  });
  assert.equal(s.resources[0].note, "已修改");
  assert.equal(JSON.parse(s.audits.at(-1)!.before).note, "");
  assert.throws(
    () =>
      apply(s, {
        type: "resource.save",
        resource: { ...row, name: "two", ip: "999.2.3.4" },
      }),
    /IP地址/,
  );
  s = apply(s, { type: "resource.delete", ids: [id] });
  assert(s.resources[0].deleted);
  assert.equal(s.audits.length, 3);
});
test("bulk import is atomic, validates duplicates and supports IPv6", () => {
  const s = setup();
  assert.throws(
    () =>
      apply(s, {
        type: "resource.import",
        rows: [
          { ...row, name: "s2", ip: "192.0.2.2" },
          { ...row, name: "s3" },
        ],
      }),
    /IP地址重复/,
  );
  assert.equal(s.resources.length, 1);
  const next = apply(s, {
    type: "resource.import",
    rows: [
      { ...row, name: "s2", ip: "2001:db8::1" },
      { ...row, name: "s3", ip: "192.0.2.3", accessMode: "lingshu" },
    ],
  });
  assert.equal(next.resources.length, 3);
  assert.equal(next.audits.at(-1)!.action, "批量导入");
  assert.throws(
    () => apply(s, { type: "resource.import", rows: Array(201).fill(row) }),
    /200/,
  );
});
test("contact group cannot be forged; pending is not occupied; approved is occupied", () => {
  let s = request(setup());
  assert.equal(s.requests[0].groupId, "g1");
  assert.equal(s.bookings.length, 0);
  s = approve(s);
  assert.equal(activeBookings(s, "2026-10-20T02:00:00.000Z").length, 1);
  assert.throws(() => approve(s), /已处理/);
});
test("approval requires admin and rejects overlaps; adjacency works", () => {
  let s = approve(request(setup()));
  s = request(s);
  assert.throws(
    () =>
      apply(
        s,
        { type: "request.review", id: s.requests.at(-1)!.id, approve: true },
        contact,
      ),
    /仅服务器管理员/,
  );
  assert.throws(() => approve(s), /冲突/);
  s = request(s, "2026-10-20T10:00:00.000Z", "2026-10-20T12:00:00.000Z");
  s = approve(s);
  assert.equal(s.bookings.length, 2);
});
test("priority preemption requires explicit confirmation, reason and higher rank, preserves both tails", () => {
  let s = approve(request(setup()));
  s = request(
    s,
    "2026-10-20T03:00:00.000Z",
    "2026-10-20T06:00:00.000Z",
    "high",
  );
  const id = s.requests.at(-1)!.id;
  assert.throws(() => approve(s), /冲突/);
  assert.throws(
    () =>
      apply(s, {
        type: "request.review",
        id,
        approve: true,
        preempt: true,
        note: "",
      }),
    /必须填写原因/,
  );
  s = apply(s, {
    type: "request.review",
    id,
    approve: true,
    preempt: true,
    note: "高优紧急实验",
  });
  assert.equal(s.bookings.filter((b) => b.status === "preempted").length, 1);
  const scheduled = s.bookings.filter((b) => b.status === "scheduled");
  assert.equal(scheduled.length, 3);
  assert.deepEqual(
    scheduled.map((b) => [b.startAt, b.endAt]),
    [
      ["2026-10-20T01:00:00.000Z", "2026-10-20T03:00:00.000Z"],
      ["2026-10-20T06:00:00.000Z", "2026-10-20T10:00:00.000Z"],
      ["2026-10-20T03:00:00.000Z", "2026-10-20T06:00:00.000Z"],
    ],
  );
  assert(s.audits.some((a) => a.action === "高优任务抢占"));
  s = request(
    s,
    "2026-10-20T04:00:00.000Z",
    "2026-10-20T05:00:00.000Z",
    "high",
  );
  assert.throws(
    () =>
      apply(s, {
        type: "request.review",
        id: s.requests.at(-1)!.id,
        approve: true,
        preempt: true,
        note: "同优",
      }),
    /只能抢占/,
  );
});
test("release preserves elapsed use and releases all remaining segments", () => {
  let s = approve(request(setup()));
  const id = s.requests[0].id;
  s = mutate(
    s,
    contact,
    { type: "request.cancel", id, note: "已完成" },
    "2026-10-20T04:00:00.000Z",
  );
  assert.equal(s.bookings[0].status, "released");
  assert.equal(s.bookings[0].endAt, "2026-10-20T04:00:00.000Z");
  assert.equal(activeBookings(s, "2026-10-20T05:00:00.000Z").length, 0);
  assert(s.audits.some((a) => a.action === "提前释放"));
});
test("cannot modify another group request or delete resources with future allocation", () => {
  let s = approve(request(setup()));
  assert.throws(
    () =>
      apply(
        s,
        { type: "request.cancel", id: s.requests[0].id },
        { ...contact, groupId: "g2" },
      ),
    /本组/,
  );
  assert.throws(
    () => apply(s, { type: "resource.delete", ids: [s.resources[0].id] }),
    /有效预约/,
  );
  assert.throws(
    () =>
      apply(s, {
        type: "resource.save",
        id: s.resources[0].id,
        resource: { ...row, status: "maintenance" },
      }),
    /有效预约/,
  );
});
test("reject requires reason, stale or invalid times fail, maintenance cannot be requested", () => {
  let s = request(setup());
  assert.throws(
    () =>
      apply(s, {
        type: "request.review",
        id: s.requests[0].id,
        approve: false,
        note: "",
      }),
    /填写原因/,
  );
  s = apply(s, {
    type: "request.review",
    id: s.requests[0].id,
    approve: false,
    note: "资源调整",
  });
  assert.equal(s.requests[0].status, "rejected");
  assert.throws(() => request(setup(), "2026-10-19T00:00:00.000Z"), /早于当前/);
  assert.throws(
    () =>
      request(setup(), "2026-10-21T00:00:00.000Z", "2026-10-20T00:00:00.000Z"),
    /晚于/,
  );
  s = setup();
  s = apply(s, {
    type: "resource.save",
    id: s.resources[0].id,
    resource: { ...row, status: "maintenance" },
  });
  assert.throws(() => request(s), /维护中/);
});
test("identity enrollment requires admin verification, protects duplicate employee ids", () => {
  let s = apply(
    setup(),
    {
      type: "account.apply",
      groupId: "g2",
      employeeId: "123",
      displayName: "张三",
    },
    member,
  );
  assert.equal(s.accounts[0].status, "pending");
  assert.throws(
    () =>
      apply(
        s,
        { type: "account.review", id: s.accounts[0].id, approve: true },
        member,
      ),
    /仅服务器管理员/,
  );
  s = apply(s, { type: "account.review", id: s.accounts[0].id, approve: true });
  assert.equal(s.groups[1].contactName, "张三");
  assert.equal(s.groups[1].employeeId, "123");
  s = apply(
    s,
    {
      type: "account.apply",
      groupId: "g3",
      employeeId: "123",
      displayName: "李四",
    },
    { ...member, userId: "d" },
  );
  assert.throws(
    () =>
      apply(s, { type: "account.review", id: s.accounts[1].id, approve: true }),
    /工号已有认证/,
  );
  s = apply(s, { type: "account.revoke", id: s.accounts[0].id });
  assert.equal(s.accounts[0].status, "rejected");
});
test("public state hides account emails, stable ids and raw audit payloads", () => {
  let s = apply(
    setup(),
    {
      type: "account.apply",
      groupId: "g1",
      employeeId: "123",
      displayName: "张三",
    },
    member,
  );
  const p = serializePublic(s, visitor, now, true);
  assert.equal(p.accounts.length, 0);
  assert(p.audits.every((a) => !a.actorId && !a.before && !a.after));
  assert(p.audits.every((a) => a.entityType !== "account"));
});
test("table import handles Excel TSV, CSV quoted comma/newline, BOM and rejects bad modes", () => {
  const rows = importRows(
    "\uFEFF名称\t类型\tIP\t使用方式\r\ns1\t910B\t192.0.2.1\t裸机",
  );
  assert.equal(rows[0].accessMode, "bare");
  const csv = importRows(
    '名称,类型,IP,使用方式,备注\ns1,910B,192.0.2.1,灵枢平台,"有逗号,有\n换行"',
  );
  assert.equal(csv[0].note, "有逗号,有\n换行");
  assert.equal(csv[0].accessMode, "lingshu");
  assert.throws(() => importRows("名称,IP\ns1,192.0.2.1"), /缺少列/);
  assert.throws(
    () => importRows("名称,类型,IP,使用方式\ns1,t,192.0.2.1,invalid"),
    /使用方式/,
  );
  assert.equal(csvCell("=SUM(A1)"), '"\'=SUM(A1)"');
});

test("shared server approves overlapping groups and aggregates current occupancy without card allocation", () => {
  let s = setup();
  const id = s.resources[0].id;
  s = apply(s, {
    type: "resource.save",
    id,
    resource: { ...row, sharingMode: "shared" },
  });
  s = approve(request(s));
  s = request(
    s,
    "2026-10-20T02:00:00.000Z",
    "2026-10-20T12:00:00.000Z",
    "normal",
    { ...contact, userId: "c2", groupId: "g2" },
  );
  assert.equal(approvalConflicts(s, s.requests.at(-1)!).length, 0);
  s = approve(s);
  const at = "2026-10-20T05:00:00.000Z";
  assert.equal(s.bookings.filter((b) => b.status === "scheduled").length, 2);
  assert.deepEqual(currentResourceUsage(s, id, at).groupIds, ["g1", "g2"]);
  assert.equal(
    currentResourceUsage(s, id, at).releaseAt,
    "2026-10-20T12:00:00.000Z",
  );
  assert.equal(groupUsage(s, "g1", at).count, 1);
  assert.equal(groupUsage(s, "g2", at).count, 1);
  assert.equal(new Set(activeBookings(s, at).map((b) => b.resourceId)).size, 1);
  assert(!("cardCount" in s.bookings[0]));
});
test("same group sharing one server is counted once and elapsed hours use the union", () => {
  let s = setup();
  s = apply(s, {
    type: "resource.save",
    id: s.resources[0].id,
    resource: { ...row, sharingMode: "shared" },
  });
  s = approve(request(s));
  s = approve(
    request(s, "2026-10-20T02:00:00.000Z", "2026-10-20T07:00:00.000Z"),
  );
  const at = "2026-10-20T05:00:00.000Z";
  assert.deepEqual(groupUsage(s, "g1", at), { count: 1, hours: 4 });
  assert.deepEqual(currentResourceUsage(s, s.resources[0].id, at).groupIds, [
    "g1",
  ]);
});
test("switching shared back to exclusive blocks overlapping reservations and preserves history", () => {
  let s = setup();
  const id = s.resources[0].id;
  s = apply(s, {
    type: "resource.save",
    id,
    resource: { ...row, sharingMode: "shared" },
  });
  s = approve(request(s));
  s = approve(
    request(
      s,
      "2026-10-20T02:00:00.000Z",
      "2026-10-20T07:00:00.000Z",
      "normal",
      { ...contact, groupId: "g2" },
    ),
  );
  assert.throws(
    () =>
      apply(s, {
        type: "resource.save",
        id,
        resource: { ...row, sharingMode: "exclusive" },
      }),
    /重叠的共享预约/,
  );
  s = apply(s, { type: "request.cancel", id: s.requests.at(-1)!.id });
  s = apply(s, {
    type: "resource.save",
    id,
    resource: { ...row, sharingMode: "exclusive" },
  });
  assert.equal(s.resources[0].sharingMode, "exclusive");
  const event = s.audits.at(-1)!;
  assert.equal(JSON.parse(event.before).sharingMode, "shared");
  assert.equal(JSON.parse(event.after).sharingMode, "exclusive");
  s = request(s);
  assert.throws(() => approve(s), /冲突/);
});
test("higher priority on shared resources never preempts existing users; mixed approvals only preempt exclusive resources", () => {
  let s = setup();
  const sharedId = s.resources[0].id;
  s = apply(s, {
    type: "resource.save",
    id: sharedId,
    resource: { ...row, sharingMode: "shared" },
  });
  s = approve(request(s));
  const existing = s.bookings[0].id;
  s = approve(
    request(s, undefined, undefined, "urgent", { ...contact, groupId: "g2" }),
  );
  assert.equal(s.bookings.find((b) => b.id === existing)!.status, "scheduled");
  s = apply(s, {
    type: "resource.save",
    resource: { ...row, name: "exclusive-2", ip: "192.0.2.2" },
  });
  const exclusiveId = s.resources[1].id;
  s = apply(s, {
    type: "request.create",
    groupId: "g1",
    resourceIds: [exclusiveId],
    startAt: "2026-10-20T01:00:00.000Z",
    endAt: "2026-10-20T10:00:00.000Z",
    purpose: "独占普通任务",
    priority: "normal",
  });
  s = approve(s);
  s = apply(s, {
    type: "request.create",
    groupId: "g3",
    resourceIds: [sharedId, exclusiveId],
    startAt: "2026-10-20T03:00:00.000Z",
    endAt: "2026-10-20T06:00:00.000Z",
    purpose: "混合高优任务",
    priority: "high",
  });
  assert.deepEqual(
    approvalConflicts(s, s.requests.at(-1)!).map((b) => b.resourceId),
    [exclusiveId],
  );
  s = apply(s, {
    type: "request.review",
    id: s.requests.at(-1)!.id,
    approve: true,
    preempt: true,
    note: "独占资源用于高优实验",
  });
  assert(
    s.bookings
      .filter((b) => b.resourceId === sharedId)
      .every((b) => b.status === "scheduled"),
  );
  assert(
    s.bookings.some(
      (b) => b.resourceId === exclusiveId && b.status === "preempted",
    ),
  );
});
test("sharing configuration is validated and table imports default to exclusive", () => {
  assert.equal(setup().resources[0].sharingMode, "exclusive");
  assert.throws(
    () =>
      apply(emptyState(), {
        type: "resource.save",
        resource: { ...row, sharingMode: "invalid" },
      }),
    /占用模式/,
  );
  const rows = importRows(
    "名称,类型,IP,使用方式,占用模式\nshared,t,192.0.2.1,裸机,共享\nexclusive,t,192.0.2.2,灵枢平台,独占",
  );
  assert.deepEqual(
    rows.map((r) => r.sharingMode),
    ["shared", "exclusive"],
  );
  assert.equal(
    importRows("名称,类型,IP,使用方式\nlegacy,t,192.0.2.3,裸机")[0].sharingMode,
    "exclusive",
  );
  assert.throws(
    () =>
      importRows(
        "名称,类型,IP,使用方式,占用模式\nwrong,t,192.0.2.3,裸机,whatever",
      ),
    /占用模式/,
  );
  let s = apply(emptyState(), { type: "resource.import", rows });
  assert.equal(s.resources[0].sharingMode, "shared");
  // An older client omitting the field cannot reset an existing shared server.
  s = apply(s, {
    type: "resource.save",
    id: s.resources[0].id,
    resource: { ...row, name: "shared-renamed" },
  });
  assert.equal(s.resources[0].sharingMode, "shared");
});
