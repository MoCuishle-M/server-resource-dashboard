import { test } from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { emptyState, mutate } from "../lib/domain";
import { importRows, resourceTableRows } from "../lib/csv";
import { readResourceWorkbook, workbookResourceRows } from "../lib/excel";
import type { Actor, State } from "../lib/types";
const at = "2026-10-20T00:00:00.000Z";
const admin: Actor = {
  userId: "a",
  displayName: "管理员",
  email: "a@test",
  role: "admin",
  groupId: "",
  employeeId: "",
};
const resource = {
  name: "server-1",
  type: "910B",
  ip: "192.0.2.101",
  accessMode: "bare",
  sharingMode: "exclusive",
  location: "A",
  note: "旧备注",
  status: "available",
};
const act = (s: State, a: Record<string, unknown>, actor = admin) =>
  mutate(s, actor, a as never, at);
function setup() {
  let s = emptyState();
  for (let i = 1; i <= 3; i++)
    s = act(s, {
      type: "resource.save",
      resource: { ...resource, name: `server-${i}`, ip: `192.0.2.${100 + i}` },
    });
  return s;
}
test("bulk edits every business field while preserving IP, identity and unselected resources", () => {
  const before = setup();
  const selected = before.resources.slice(0, 2).map((r) => r.id);
  const s = act(before, {
    type: "resource.bulkUpdate",
    ids: selected,
    changes: {
      name: "新-{index}-{ip}",
      type: "910C",
      accessMode: "lingshu",
      sharingMode: "shared",
      location: "苏州",
      note: "批量备注",
      status: "maintenance",
    },
  });
  for (let i = 0; i < 2; i++) {
    assert.equal(s.resources[i].ip, before.resources[i].ip);
    assert.equal(s.resources[i].id, before.resources[i].id);
    assert.equal(s.resources[i].createdAt, before.resources[i].createdAt);
    assert.equal(s.resources[i].name, `新-${i + 1}-${before.resources[i].ip}`);
    assert.equal(s.resources[i].type, "910C");
    assert.equal(s.resources[i].accessMode, "lingshu");
    assert.equal(s.resources[i].sharingMode, "shared");
    assert.equal(s.resources[i].status, "maintenance");
    assert.equal(s.resources[i].location, "苏州");
    assert.equal(s.resources[i].note, "批量备注");
  }
  assert.deepEqual(s.resources[2], before.resources[2]);
  assert.equal(s.audits.filter((a) => a.action === "批量修改服务器").length, 2);
  const cleared = act(s, {
    type: "resource.bulkUpdate",
    ids: selected,
    changes: { location: "", note: "" },
  });
  assert(cleared.resources.slice(0, 2).every((r) => !r.note && !r.location));
  assert.equal(cleared.resources[0].type, "910C");
});
test("bulk writes reject forged IP/system fields, empty edits, duplicate names and unauthorized users atomically", () => {
  const s = setup();
  const snapshot = structuredClone(s);
  const ids = s.resources.map((r) => r.id);
  for (const changes of [
    { ip: "1.2.3.4" },
    { id: "forged" },
    { deleted: true },
    { createdAt: at },
    { role: "admin" },
  ])
    assert.throws(
      () => act(s, { type: "resource.bulkUpdate", ids, changes }),
      /不允许修改IP/,
    );
  assert.throws(
    () => act(s, { type: "resource.bulkUpdate", ids, changes: {} }),
    /至少选择/,
  );
  assert.throws(
    () =>
      act(s, {
        type: "resource.bulkUpdate",
        ids,
        changes: { name: "same-name" },
      }),
    /名称重复/,
  );
  assert.throws(
    () =>
      act(s, {
        type: "resource.bulkUpdate",
        ids: [ids[0], "missing"],
        changes: { note: "changed" },
      }),
    /不存在/,
  );
  assert.throws(
    () =>
      act(
        s,
        { type: "resource.bulkUpdate", ids, changes: { note: "changed" } },
        { ...admin, role: "contact", groupId: "g1" },
      ),
    /仅服务器管理员/,
  );
  assert.deepEqual(s, snapshot);
});
test("bulk maintenance and shared-to-exclusive changes retain reservation guards with no partial update", () => {
  let s = setup();
  s = act(s, {
    type: "request.create",
    groupId: "g1",
    resourceIds: [s.resources[1].id],
    startAt: "2026-10-20T01:00:00.000Z",
    endAt: "2026-10-20T04:00:00.000Z",
    purpose: "已预约",
    priority: "normal",
  });
  s = act(s, {
    type: "request.review",
    id: s.requests[0].id,
    approve: true,
    note: "",
  });
  const snapshot = structuredClone(s);
  assert.throws(
    () =>
      act(s, {
        type: "resource.bulkUpdate",
        ids: s.resources.map((r) => r.id),
        changes: { note: "不得部分修改", status: "maintenance" },
      }),
    /有效预约/,
  );
  assert.deepEqual(s, snapshot);
});
test("table updates locate by IP, preserve blanks and reject duplicates/missing targets as one batch", () => {
  const before = setup();
  const rows = importRows(
    "IP,类型,备注,使用方式\n192.0.2.101,910C,Excel更新,\n192.0.2.102,910D,,灵枢平台",
    "update",
  );
  const s = act(before, { type: "resource.updateByIp", rows });
  assert.equal(s.resources[0].type, "910C");
  assert.equal(s.resources[0].note, "Excel更新");
  assert.equal(s.resources[0].accessMode, "bare");
  assert.equal(s.resources[1].type, "910D");
  assert.equal(s.resources[1].note, "旧备注");
  assert.equal(s.resources[1].accessMode, "lingshu");
  assert.deepEqual(
    s.resources.map((r) => r.ip),
    before.resources.map((r) => r.ip),
  );
  assert.throws(
    () =>
      act(before, {
        type: "resource.updateByIp",
        rows: [rows[0], { ip: "192.0.2.199", type: "未知" }],
      }),
    /未找到IP/,
  );
  assert.throws(
    () =>
      act(before, { type: "resource.updateByIp", rows: [rows[0], rows[0]] }),
    /IP重复/,
  );
  assert.throws(
    () =>
      act(before, {
        type: "resource.updateByIp",
        rows: [{ ip: "192.0.2.101", id: "forged" }],
      }),
    /系统字段/,
  );
  assert.equal(before.resources[0].type, "910B");
});
test("table parsers validate optional status, blank updates, duplicate headers and row limits", () => {
  assert.equal(
    importRows(
      "名称,类型,IP,使用方式,状态\n中文服务器,910C,192.0.2.1,裸机,维护中",
    )[0].status,
    "maintenance",
  );
  assert.throws(() => importRows("IP,备注\n192.0.2.1,", "update"), /至少填写/);
  assert.throws(
    () => importRows("IP,IP,类型\n192.0.2.1,192.0.2.2,test", "update"),
    /表头重复/,
  );
  assert.throws(
    () => importRows("IP,状态\n192.0.2.1,错误", "update"),
    /状态应为/,
  );
  assert.throws(
    () =>
      resourceTableRows(
        [
          ["IP", "类型"],
          ...Array.from({ length: 201 }, (_, i) => [`192.0.2.${i}`, "type"]),
        ],
        "update",
      ),
    /最多200/,
  );
});
async function bytes(workbook: ExcelJS.Workbook) {
  const b = await workbook.xlsx.writeBuffer();
  return new Uint8Array(b as unknown as ArrayBuffer).buffer;
}
test("real Excel workbook reads visible sheets, Unicode, rows and add/update fields", async () => {
  const w = new ExcelJS.Workbook();
  const hidden = w.addWorksheet("隐藏");
  hidden.state = "hidden";
  hidden.addRow(["忽略"]);
  const first = w.addWorksheet("新增服务器");
  first.addRow([
    "名称",
    "类型",
    "IP",
    "使用方式",
    "占用模式",
    "位置",
    "备注",
    "状态",
  ]);
  first.addRow([
    "苏州服务器",
    "910C*8卡",
    "80.5.25.101",
    "裸机",
    "共享",
    "苏州",
    "保留中文",
    "维护中",
  ]);
  const second = w.addWorksheet("更新信息");
  second.addRow(["IP", "类型", "备注"]);
  second.addRow(["80.5.25.101", "910C新类型", ""]);
  const sheets = await readResourceWorkbook(await bytes(w));
  assert.deepEqual(
    sheets.map((s) => s.name),
    ["新增服务器", "更新信息"],
  );
  const added = workbookResourceRows(sheets[0]);
  assert.equal(added[0].name, "苏州服务器");
  assert.equal(added[0].sharingMode, "shared");
  assert.equal(added[0].status, "maintenance");
  assert.equal(added[0].note, "保留中文");
  assert.deepEqual(workbookResourceRows(sheets[1], "update"), [
    { ip: "80.5.25.101", type: "910C新类型" },
  ]);
});
test("Excel rejects corrupt files, formulas and empty workbooks", async () => {
  await assert.rejects(
    readResourceWorkbook(new TextEncoder().encode("invalid xlsx").buffer),
    /无法读取/,
  );
  const w = new ExcelJS.Workbook();
  const sheet = w.addWorksheet("含公式");
  sheet.addRow(["IP", "类型"]);
  sheet.getCell("A2").value = "192.0.2.1";
  sheet.getCell("B2").value = { formula: "1+1", result: 2 };
  await assert.rejects(readResourceWorkbook(await bytes(w)), /包含公式/);
  const empty = new ExcelJS.Workbook();
  empty.addWorksheet("空白");
  await assert.rejects(readResourceWorkbook(await bytes(empty)), /没有可导入/);
});
