import { chromium } from "playwright";
import assert from "node:assert/strict";
const base = "http://127.0.0.1:5173";
const browser = await chromium.launch({ headless: true, channel: "chromium", args: ["--no-sandbox"] });
try {
  const context = await browser.newContext();
  const publicContext = await browser.newContext();
  const page = await context.newPage();
  await page.goto(base + "/signin-with-chatgpt?return_to=/");
  await page.waitForLoadState("networkidle");
  let state = await (await context.request.get(base + "/api/state")).json();
  assert.equal(state.actor.role, "admin");
  const original = { ...state.settings };
  async function action(action) {
    const r = await context.request.post(base + "/api/action", { headers: { Origin: base }, data: { ...action, revision: state.revision } });
    const data = await r.json();
    assert.equal(r.status(), 200, JSON.stringify(data));
    state = data;
  }
  const suffix = Date.now();
  const email = `qa-admin-${suffix}@example.test`;
  try {
    await action({ type: "site.settings", announcement: `本地API公告${suffix}\n维护安排`, authorSignature: "本地API作者" });
    const persisted = await (await context.request.get(base + "/api/state")).json();
    assert.equal(persisted.settings.announcement, state.settings.announcement);
    await action({ type: "admin.invite", email, displayName: "本地测试邀请" });
    const id = state.invitations.find(i => i.email === email).id;
    let visitor = await (await publicContext.request.get(base + "/api/state")).json();
    assert.equal(visitor.settings.authorSignature, "本地API作者");
    assert.deepEqual(visitor.invitations, []);
    assert.deepEqual(visitor.accounts, []);
    assert(!JSON.stringify(visitor).includes(email));
    const denied = await publicContext.request.post(base + "/api/action", { headers: { Origin: base }, data: { type: "admin.invite", email: "forged@example.test", role: "admin", revision: state.revision } });
    assert.equal(denied.status(), 401);
    await action({ type: "admin.cancelInvitation", id });
    assert.equal(state.invitations.find(i => i.id === id).status, "cancelled");
  } finally { await action({ type: "site.settings", ...original }); }
  console.log("PASS: local authenticated settings persistence, public text visibility, private admin invitation, cancelled invitation and anonymous privilege denial; original public text restored");
} finally { await browser.close(); }
