import { chromium } from "playwright";
import assert from "node:assert/strict";

const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL ?? "chromium", args: ["--no-sandbox"] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto((process.env.BASE_URL ?? "http://127.0.0.1:5173") + "/demo", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "团队与接口人", exact: true }).click();
  const row = page.getByRole("row").filter({ hasText: "contact@example.test" });
  await row.getByRole("button", { name: "更正资料", exact: true }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("姓名 *", { exact: true }).fill("更正测试接口人");
  await dialog.getByLabel("工号 *", { exact: true }).fill("QA999");
  await dialog.getByLabel("所属组 *").selectOption("g2");
  await dialog.getByRole("button", { name: "保存更正", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.match(await row.innerText(), /更正测试接口人/);
  assert.match(await row.innerText(), /QA999/);
  assert.match(await row.innerText(), /多模态算法组/);
  assert.match(await row.innerText(), /已认证/);
  await row.getByRole("button", { name: "撤销权限", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "确认撤销", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  assert.match(await row.innerText(), /已拒绝/);
  // Editing a rejected account must not restore permission implicitly.
  await page.setViewportSize({ width: 390, height: 844 });
  await row.getByRole("button", { name: "更正资料", exact: true }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("姓名 *", { exact: true }).fill("重新授权测试接口人");
  await dialog.getByRole("button", { name: "保存更正", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.match(await row.innerText(), /已拒绝/);
  await row.getByRole("button", { name: "重新授权", exact: true }).click();
  dialog = page.getByRole("dialog");
  assert.match(await dialog.innerText(), /重新授权测试接口人 · QA999 · 多模态算法组/);
  await dialog.getByRole("button", { name: "确认重新授权", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.match(await row.innerText(), /已认证/);
  assert.match(await row.innerText(), /重新授权测试接口人/);
  assert.match(await row.innerText(), /已认证/);
  await page.getByLabel("演示角色", { exact: true }).selectOption("visitor");
  assert.equal(await page.getByRole("button", { name: "更正资料", exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "重新授权", exact: true }).count(), 0);
  assert.deepEqual(errors, []);
  console.log("PASS: desktop/mobile contact correction, revoke, correction without approval, explicit restore and visitor visibility");
} finally { await browser.close(); }
