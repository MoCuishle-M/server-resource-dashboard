import { chromium } from "playwright";
import assert from "node:assert/strict";
const base = "http://127.0.0.1:5173";
const browser = await chromium.launch({
  headless: true,
  channel: "chromium",
  args: ["--no-sandbox"],
});
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(base + "/signin-with-chatgpt?return_to=/");
  await page.waitForLoadState("networkidle");
  let state = await (await context.request.get(base + "/api/state")).json();
  assert.equal(state.actor.role, "admin");
  async function action(a, status = 200) {
    const response = await context.request.post(base + "/api/action", {
      headers: { Origin: base },
      data: { ...a, revision: state.revision },
    });
    const result = await response.json();
    assert.equal(response.status(), status, JSON.stringify(result));
    if (response.ok()) state = result;
    return result;
  }
  const prefix = "批量联调-" + Date.now();
  await action({
    type: "resource.import",
    rows: [1, 2].map((i) => ({
      name: prefix + "-" + i,
      ip: "198.18.0." + (100 + i),
      type: "910B",
      accessMode: "bare",
      sharingMode: "shared",
      location: "测试位置",
      note: "原备注",
      status: "available",
    })),
  });
  const original = state.resources.filter((r) => r.name.startsWith(prefix));
  const ids = original.map((r) => r.id);
  assert.equal(ids.length, 2);
  await action({
    type: "resource.bulkUpdate",
    ids,
    changes: {
      name: prefix + "-{index}-{ip}",
      type: "批量类型",
      accessMode: "lingshu",
      location: "新位置",
      note: "",
    },
  });
  let saved = (
    await (await context.request.get(base + "/api/state")).json()
  ).resources.filter((r) => ids.includes(r.id));
  assert.deepEqual(
    saved.map((r) => r.ip),
    original.map((r) => r.ip),
  );
  assert(
    saved.every(
      (r) =>
        r.type === "批量类型" && r.accessMode === "lingshu" && r.note === "",
    ),
  );
  await action(
    { type: "resource.bulkUpdate", ids, changes: { ip: "192.0.2.99" } },
    400,
  );
  const startAt = new Date(Date.now() + 86400000).toISOString();
  const endAt = new Date(Date.now() + 90000000).toISOString();
  await action({
    type: "request.create",
    groupId: "g1",
    resourceIds: [ids[1]],
    startAt,
    endAt,
    purpose: "原子更新校验",
    priority: "normal",
  });
  const requestId = state.requests.at(-1).id;
  await action({
    type: "request.review",
    id: requestId,
    approve: true,
    note: "",
  });
  const revision = state.revision;
  await action(
    {
      type: "resource.bulkUpdate",
      ids,
      changes: { status: "maintenance", note: "不应写入" },
    },
    409,
  );
  const rolledBack = await (
    await context.request.get(base + "/api/state")
  ).json();
  assert.equal(rolledBack.revision, revision);
  assert(
    rolledBack.resources
      .filter((r) => ids.includes(r.id))
      .every((r) => r.status === "available" && r.note === ""),
  );
  await action({
    type: "resource.updateByIp",
    rows: original.map((r, i) => ({
      ip: r.ip,
      type: "按IP更新-" + i,
      note: "Excel更新",
    })),
  });
  saved = state.resources.filter((r) => ids.includes(r.id));
  assert(
    saved.every((r) => r.type.startsWith("按IP更新") && r.note === "Excel更新"),
  );
  assert.deepEqual(
    saved.map((r) => r.ip),
    original.map((r) => r.ip),
  );
  assert.equal(
    state.audits.filter(
      (a) => a.action === "批量修改服务器" && ids.includes(a.entityId),
    ).length,
    4,
  );
  await action({ type: "request.cancel", id: requestId, note: "本地验证完成" });
  await action({ type: "resource.delete", ids });
  const anon = await browser.newContext();
  const denied = await anon.request.post(base + "/api/action", {
    headers: { Origin: base },
    data: {
      type: "resource.bulkUpdate",
      ids,
      changes: { note: "forged" },
      revision: state.revision,
    },
  });
  assert.equal(denied.status(), 401);
  console.log(
    "PASS: real local API bulk persistence, immutable IP, reservation guard rollback, IP-based updates, per-resource audit and anonymous denial",
  );
} finally {
  await browser.close();
}
