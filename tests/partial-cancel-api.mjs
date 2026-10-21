import { chromium } from "playwright";
import assert from "node:assert/strict";
// Uses only the local development D1 database and its simulated identity.
const base = "http://127.0.0.1:5173";
const browser = await chromium.launch({ headless: true, channel: "chromium", args: ["--no-sandbox"] });
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(base + "/signin-with-chatgpt?return_to=/");
  await page.waitForLoadState("networkidle");
  let state = await (await context.request.get(base + "/api/state")).json();
  assert.equal(state.actor.role, "admin");
  async function action(value) {
    const r = await context.request.post(base + "/api/action", { headers: { Origin: base }, data: { ...value, revision: state.revision } });
    const data = await r.json();
    assert.equal(r.status(), 200, JSON.stringify(data));
    state = data;
  }
  const suffix = Date.now();
  await action({ type: "resource.save", resource: { name: `QA部分取消-${suffix}`, ip: `2001:db8::${suffix.toString(16).match(/.{1,4}/g).join(":")}`, type: "QA · 8卡", accessMode: "bare", sharingMode: "exclusive", location: "本地测试", note: "", status: "available" } });
  const resource = state.resources.find(r => r.name === `QA部分取消-${suffix}`);
  const start = Date.now() + 86400000;
  const at = hours => new Date(start + hours * 3600000).toISOString();
  let requestId;
  try {
    await action({ type: "request.create", groupId: "g1", resourceIds: [resource.id], startAt: at(0), endAt: at(10), purpose: "QA持久化部分取消", priority: "normal" });
    requestId = state.requests.at(-1).id;
    await action({ type: "request.review", id: requestId, approve: true });
    const oldRevision = state.revision;
    const partial = { type: "request.cancelPartial", id: requestId, resourceIds: [resource.id], startAt: at(3), endAt: at(5), note: "本地API临时独占" };
    await action(partial);
    const persisted = await (await context.request.get(base + "/api/state")).json();
    assert.deepEqual(persisted.bookings.filter(b => b.requestId === requestId && b.status === "scheduled").sort((a, b) => a.startAt.localeCompare(b.startAt)).map(b => [b.startAt, b.endAt]), [[at(0), at(3)], [at(5), at(10)]]);
    assert(persisted.audits.some(a => a.action === "取消部分时段" && a.summary.includes("本地API临时独占")));
    const stale = await context.request.post(base + "/api/action", { headers: { Origin: base }, data: { ...partial, revision: oldRevision } });
    assert.equal(stale.status(), 409);
    const anonymous = await browser.newContext();
    const denied = await anonymous.request.post(base + "/api/action", { headers: { Origin: base }, data: { ...partial, revision: state.revision } });
    assert.equal(denied.status(), 401);
    await anonymous.close();
    assert.equal((await (await context.request.get(base + "/api/state")).json()).revision, state.revision);
  } finally {
    if (requestId) await action({ type: "request.cancel", id: requestId, note: "本地API测试清理" });
    await action({ type: "resource.delete", ids: [resource.id] });
  }
  console.log("PASS: authenticated partial cancellation persists through API/D1, stale update rollback and anonymous write denial; local resource cleaned up");
} finally { await browser.close(); }
