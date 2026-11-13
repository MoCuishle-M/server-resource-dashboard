import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium, expect } from "playwright/test";

const base = process.env.BASE_URL ?? "http://127.0.0.1:5173";
const bundled = await build({
  stdin: {
    contents: 'export { demoState, demoAdmin } from "./lib/demo"; export { serializePublic } from "./lib/domain";',
    resolveDir: process.cwd(),
  },
  bundle: true, platform: "node", format: "esm", write: false,
});
const { demoState, demoAdmin, serializePublic } = await import(
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
} finally {
  await browser.close();
}
