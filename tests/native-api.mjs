import { chromium } from "playwright";
import assert from "node:assert/strict";
const browser = await chromium.launch({
  headless: true,
  channel: "chromium",
  args: ["--no-sandbox"],
});
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  const base = "http://127.0.0.1:5173";
  const publicContext = await browser.newContext();
  const before = await (
    await publicContext.request.get(base + "/api/state")
  ).json();
  assert.equal(before.actor.role, "visitor");
  assert.equal(before.accounts.length, 0);
  await page.goto(base + "/signin-with-chatgpt?return_to=/");
  await page.waitForLoadState("networkidle");
  let state = await (await context.request.get(base + "/api/state")).json();
  assert.equal(state.actor.role, "admin");
  async function action(a, expected = 200) {
    const response = await context.request.post(base + "/api/action", {
      headers: { Origin: base },
      data: { ...a, revision: state.revision },
    });
    const result = await response.json();
    assert.equal(response.status(), expected, JSON.stringify(result));
    if (response.ok()) state = result;
    return result;
  }
  const suffix = Date.now().toString().slice(-6);
  const ip = `198.51.100.${Math.floor(Math.random() * 150) + 20}`;
  await action({
    type: "resource.save",
    resource: {
      name: "本地联调-" + suffix,
      type: "QA联调",
      ip,
      accessMode: "bare",
      status: "available",
      location: "测试",
      note: "仅本地测试，不部署至生产",
    },
  });
  const id = state.resources.find((r) => r.name === "本地联调-" + suffix).id;
  const start = new Date(Date.now() + 86400000).toISOString(),
    end = new Date(Date.now() + 86400000 + 3 * 3600000).toISOString();
  await action({
    type: "request.create",
    groupId: "g1",
    resourceIds: [id],
    startAt: start,
    endAt: end,
    purpose: "API持久化联调",
    priority: "normal",
  });
  const requestId = state.requests.at(-1).id;
  assert(!state.bookings.some((b) => b.requestId === requestId));
  await action({
    type: "request.review",
    id: requestId,
    approve: true,
    note: "联调批准",
  });
  assert(
    state.bookings.some(
      (b) => b.requestId === requestId && b.status === "scheduled",
    ),
  );
  await action({ type: "resource.delete", ids: [id] }, 409);
  await action({ type: "request.cancel", id: requestId, note: "联调完成" });
  await action({ type: "resource.delete", ids: [id] });
  const persisted = await (
    await context.request.get(base + "/api/state")
  ).json();
  assert.equal(persisted.revision, state.revision);
  assert(persisted.resources.find((r) => r.id === id).deleted);
  assert(persisted.audits.some((a) => a.action === "批准申请"));
  assert(
    persisted.bookings.find((b) => b.requestId === requestId).status ===
      "cancelled",
  );
  const unauthorized = await publicContext.request.post(base + "/api/action", {
    headers: { Origin: base },
    data: { type: "resource.delete", ids: [id], revision: state.revision },
  });
  assert.equal(unauthorized.status(), 401);
  const noOrigin = await context.request.post(base + "/api/action", {
    data: { type: "resource.delete", ids: [id], revision: state.revision },
  });
  assert.equal(noOrigin.status(), 403);
  const crossOrigin = await context.request.post(base + "/api/action", {
    headers: { Origin: "https://evil.invalid" },
    data: { type: "resource.delete", ids: [id], revision: state.revision },
  });
  assert.equal(crossOrigin.status(), 403);
  const stale = await context.request.post(base + "/api/action", {
    headers: { Origin: base },
    data: { type: "group.save", id: "g1", name: "bad", revision: 0 },
  });
  assert.equal(stale.status(), 409);
  const malformed = await context.request.post(base + "/api/action", {
    headers: { Origin: base },
    data: null,
  });
  assert([400, 415].includes(malformed.status()));
  console.log(
    "PASS: native local login -> admin enrollment -> persistent resource -> request -> approval -> protected delete -> cancellation -> history persistence; anonymous writes, cross-origin writes and stale revisions blocked",
  );
} finally {
  await browser.close();
}
