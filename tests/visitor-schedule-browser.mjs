import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium, expect } from "playwright/test";

const base = process.env.BASE_URL ?? "http://127.0.0.1:5173";
const bundled = await build({
  stdin: {
    contents: `export { demoState, demoAdmin } from "./lib/demo";
export { serializePublic } from "./lib/domain";
export { liveView } from "./lib/npu-live";
export { analyzeUsage, usageRange } from "./lib/npu-usage";`,
    resolveDir: process.cwd(),
  },
  bundle: true, platform: "node", format: "esm", write: false,
});
const { demoState, demoAdmin, serializePublic, liveView, analyzeUsage, usageRange } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
);
const visitor = { userId: "", displayName: "访客", email: "", role: "visitor", groupId: "", employeeId: "" };
const fixture = demoState();
let actor = visitor;
const key = "visitor-schedule-group-v1";
const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL ?? "chrome" });
try {
  const context = await browser.newContext();
  // Every state read uses sample data; no production actions are sent.
  await context.route("**/api/state", route => route.fulfill({ json: serializePublic(fixture, actor, fixture.now, true) }));
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const group = page.getByLabel("排期组筛选", { exact: true });
  await page.goto(base);
  await expect(page.getByRole("heading", { name: /^使用排期/ })).toBeVisible();
  await expect(group).toHaveValue("");
  await expect(page.getByRole("region", { name: "当前用机" })).toContainText("后可查看所选使用组的机器状态");
  await group.selectOption("g1");
  const visibleRows = await page.locator(".schedule-table tbody tr").count();
  assert(visibleRows > 0, "The selected sample team has scheduled resources");
  assert.equal(await page.evaluate(key => localStorage.getItem(key), key), "g1");
  await page.getByRole("button", { name: "资源总览", exact: true }).click();
  await page.getByRole("button", { name: "使用排期", exact: true }).click();
  await expect(group).toHaveValue("g1");
  await page.reload();
  await expect(group).toHaveValue("g1");
  assert.equal(await page.locator(".schedule-table tbody tr").count(), visibleRows);

  const secondVisit = await context.newPage();
  await secondVisit.goto(base);
  await expect(secondVisit.getByLabel("排期组筛选")).toHaveValue("g1");
  await secondVisit.close();

  await group.selectOption("");
  await page.reload();
  await expect(group).toHaveValue("");
  await group.selectOption("g2");
  await page.getByRole("button", { name: "清除筛选", exact: true }).click();
  await page.reload();
  await expect(group).toHaveValue("");
  assert.equal(await page.evaluate(key => localStorage.getItem(key), key), null);

  await page.evaluate(key => localStorage.setItem(key, "removed-team"), key);
  await page.reload();
  await expect(group).toHaveValue("");
  assert(await page.locator(".schedule-table tbody tr").count() > 0);

  await group.selectOption("g1");
  actor = demoAdmin;
  await page.reload();
  await expect(page.getByRole("heading", { name: /^资源总览/ })).toBeVisible();
  await page.getByRole("button", { name: "使用排期", exact: true }).click();
  await expect(group).toHaveValue("");
  await group.selectOption("g2");
  assert.equal(await page.evaluate(key => localStorage.getItem(key), key), "g1");

  actor = visitor;
  await context.addInitScript(() => {
    Storage.prototype.getItem = () => { throw new Error("Storage disabled"); };
    Storage.prototype.setItem = () => { throw new Error("Storage disabled"); };
    Storage.prototype.removeItem = () => { throw new Error("Storage disabled"); };
  });
  await page.reload();
  await expect(group).toHaveValue("");
  await group.selectOption("g2");
  await expect(group).toHaveValue("g2");
  await page.getByRole("button", { name: "清除筛选", exact: true }).click();
  await expect(group).toHaveValue("");
  assert.deepEqual(errors, []);
  console.log("Visitor landing, team persistence, reset, stale teams, admin isolation and disabled storage passed.");

  const state = demoState();
  const day = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai" }).format(new Date());
  const at = hhmm => new Date(`${day}T${hhmm}:00+08:00`).toISOString();
  const now = Date.parse(at("10:45"));
  const groupId = state.groups[0].id;
  const resource = { ...state.resources[0], type: "Atlas", name: "柜09-CPU1", zone: "blue", rack: "计算柜09" };
  const handoff = { ...state.requests[0], id: "multi-handoff", groupId, resourceIds: [resource.id],
    weeklySection: "multi", priority: "normal", startAt: at("11:00"), endAt: at("11:50") };
  const ordinary = { ...state.bookings[0], id: "ordinary", requestId: "ordinary-request",
    resourceId: resource.id, groupId, priority: "normal", status: "scheduled", startAt: at("10:00"), endAt: at("11:50") };
  state.resources = [resource];
  state.requests = [handoff];
  state.bookings = [ordinary, { ...ordinary, id: "multinode", requestId: handoff.id, startAt: handoff.startAt }];
  const latest = [{ resourceId: resource.id, expected: 8, snapshot: { at: now - 30_000,
    cards: Array.from({ length: 4 }, (_, i) => ({ key: `${i}-0`, state: "idle", util: 0, hbm: 0 })) } }];
  const liveContext = await browser.newContext();
  let liveActor = demoAdmin;
  let delayGroup = "";
  let completeDelayedResponse;
  await liveContext.route("**/api/state", route => route.fulfill({ json: serializePublic(state, liveActor, at("10:45"), true) }));
  await liveContext.route("**/api/npu-usage?*", route => route.fulfill({ json: analyzeUsage(state, [], latest, usageRange(day, day, now)) }));
  await liveContext.route("**/api/npu-live?*", async route => {
    const requestedGroup = new URL(route.request().url()).searchParams.get("group");
    if (requestedGroup === delayGroup) await new Promise(resolve => { completeDelayedResponse = resolve; });
    await route.fulfill({ json: liveView(state, liveActor, requestedGroup, now, 1, [], latest) });
  });
  const livePage = await liveContext.newPage();
  const liveErrors = [];
  livePage.on("pageerror", error => liveErrors.push(error.message));
  livePage.setDefaultTimeout(6000);
  await livePage.clock.setFixedTime(now);
  await livePage.goto(base);
  const cabinet = livePage.getByRole("button", { name: /柜 09.*整机空闲 0.*待确认 1/ });
  await cabinet.click();
  await expect(livePage.getByText("空闲 4 / 8 · 样本不全")).toBeVisible();
  await livePage.getByRole("button", { name: "使用排期", exact: true }).click();
  await livePage.getByLabel("排期组筛选", { exact: true }).selectOption(groupId);
  const currentUse = livePage.getByRole("region", { name: "当前用机" });
  await expect(currentUse.getByText("4 / 8", { exact: true })).toBeVisible();
  await expect(currentUse.getByText("状态待确认", { exact: true })).toBeVisible();
  await expect(currentUse.getByText(/11:00/)).toBeVisible();
  await expect(livePage.locator(".timeline-ordinary.is-available")).toHaveAttribute("aria-label", /10:00 — .*11:00$/);
  await expect(livePage.getByRole("button", { name: /普通时段不可用.*11:00.*11:50.*多机任务占用/ })).toBeVisible();
  liveActor = { ...visitor, userId: "signed-in-member", role: "member", displayName: "普通用户" };
  await livePage.reload();
  await livePage.getByRole("button", { name: "使用排期", exact: true }).click();
  const memberGroup = livePage.getByLabel("排期组筛选", { exact: true });
  await memberGroup.selectOption(groupId);
  await expect(currentUse.getByText("4 / 8", { exact: true })).toBeVisible();
  await memberGroup.selectOption(state.groups[1].id);
  await expect(currentUse.getByText("本组当前没有生效的日常排期。")).toBeVisible();
  delayGroup = groupId;
  await memberGroup.selectOption(groupId);
  await expect.poll(() => typeof completeDelayedResponse).toBe("function");
  await expect(currentUse.getByText("4 / 8", { exact: true })).toBeVisible({ timeout: 1000 });
  await expect(currentUse.getByText("正在读取机器状态…")).toHaveCount(0);
  delayGroup = "";
  completeDelayedResponse?.();
  assert.deepEqual(liveErrors, []);
  await liveContext.close();
  console.log("Multi-node handoff, partial telemetry, signed-in access and cached group switching passed.");
} finally {
  await browser.close();
}
