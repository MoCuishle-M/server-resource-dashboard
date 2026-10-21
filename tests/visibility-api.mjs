import { chromium } from "playwright";
import assert from "node:assert/strict";
const base = "http://127.0.0.1:5173"; // Local D1 and simulated identity only.
const browser = await chromium.launch({ headless: true, channel: "chromium", args: ["--no-sandbox"] });
try {
  const context = await browser.newContext();
  const visitor = await browser.newContext();
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
  const suffix = Date.now(), name = `QA隐藏-${suffix}`, ip = `2001:db8::${suffix.toString(16).match(/.{1,4}/g).join(":")}`;
  await action({ type: "resource.save", resource: { name, ip, type: "QA不可用8卡", accessMode: "bare", sharingMode: "exclusive", location: "本地测试", note: "", status: "unavailable", hidden: false } });
  const resource = state.resources.find(r => r.name === name);
  try {
    let publicState = await (await visitor.request.get(base + "/api/state")).json();
    assert.equal(publicState.resources.find(r => r.id === resource.id).status, "unavailable");
    const deniedRequest = await context.request.post(base + "/api/action", { headers: { Origin: base }, data: { type: "request.create", groupId: "g1", resourceIds: [resource.id], startAt: new Date(Date.now() + 86400000).toISOString(), endAt: new Date(Date.now() + 90000000).toISOString(), purpose: "拒绝不可用资源申请", priority: "normal", revision: state.revision } });
    assert.equal(deniedRequest.status(), 409);
    const staleRevision = state.revision;
    await action({ type: "resource.bulkUpdate", ids: [resource.id], changes: { hidden: true } });
    const persisted = await (await context.request.get(base + "/api/state")).json();
    assert.equal(persisted.resources.find(r => r.id === resource.id).hidden, true);
    publicState = await (await visitor.request.get(base + "/api/state")).json();
    for (const value of [resource.id, name, ip]) assert(!JSON.stringify(publicState).includes(value));
    const forged = await visitor.request.post(base + "/api/action", { headers: { Origin: base }, data: { type: "resource.bulkUpdate", ids: [resource.id], changes: { hidden: false }, revision: state.revision } });
    assert.equal(forged.status(), 401);
    const stale = await context.request.post(base + "/api/action", { headers: { Origin: base }, data: { type: "resource.bulkUpdate", ids: [resource.id], changes: { hidden: false }, revision: staleRevision } });
    assert.equal(stale.status(), 409);
    assert.equal((await (await context.request.get(base + "/api/state")).json()).revision, state.revision);
    await action({ type: "resource.bulkUpdate", ids: [resource.id], changes: { hidden: false, status: "available" } });
    publicState = await (await visitor.request.get(base + "/api/state")).json();
    assert.equal(publicState.resources.find(r => r.id === resource.id).status, "available");
    assert.equal(publicState.resources.find(r => r.id === resource.id).hidden, false);
  } finally {
    await action({ type: "resource.bulkUpdate", ids: [resource.id], changes: { hidden: true } });
    await action({ type: "resource.delete", ids: [resource.id] });
  }
  console.log("PASS: unavailable application denial, D1 hidden persistence, anonymous raw API inventory/audit redaction, forbidden/stale update rollback and restored public visibility; local resource cleaned up");
} finally { await browser.close(); }
