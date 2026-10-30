import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";

const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL ?? "msedge" });
try {
  await mkdir("outputs", { recursive: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.clock.install({ time: new Date("2026-10-30T00:00:00Z") });
  await page.goto((process.env.BASE_URL ?? "http://127.0.0.1:5173") + "/demo", { waitUntil: "networkidle" });
  await page.getByLabel("演示角色").selectOption("contact");
  await page.getByRole("button", { name: "申请与审批", exact: true }).click();
  // Another group's pending requests cannot be cancelled by this contact.
  const other = page.getByRole("row").filter({ hasText: "分布式通信性能回归" }).filter({ hasText: "待审批" });
  assert.equal(await other.count(), 1);
  assert.equal(await other.getByRole("button", { name: "取消申请", exact: true }).count(), 0);
  await other.getByRole("button", { name: "详情", exact: true }).click();
  assert.equal(await page.getByRole("dialog").getByRole("button", { name: "取消申请", exact: true }).count(), 0);
  await page.getByRole("dialog").getByLabel("关闭", { exact: true }).click();

  for (const purpose of ["QA待审批取消", "QA过期待审批取消"]) {
    await page.getByRole("button", { name: "新建申请", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.locator(".resource-picker").getByRole("checkbox", { name: /Atlas-950-01/ }).check();
    await dialog.getByLabel("开始时间 *", { exact: true }).fill("2026-10-31T09:00");
    await dialog.getByLabel("结束时间 *", { exact: true }).fill("2026-10-31T19:00");
    await dialog.getByLabel("任务用途").fill(purpose);
    await dialog.getByRole("button", { name: "提交申请", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
  }
  const row = purpose => page.getByRole("row").filter({ hasText: purpose });
  await page.getByRole("button", { name: /^待审批 / }).click();
  await row("QA待审批取消").getByRole("button", { name: "取消申请", exact: true }).click();
  let dialog = page.getByRole("dialog");
  assert.match(await dialog.innerText(), /不再等待管理员审批/);
  await dialog.getByRole("button", { name: "返回", exact: true }).click();
  assert.match(await row("QA待审批取消").innerText(), /待审批/);
  await row("QA待审批取消").getByRole("button", { name: "取消申请", exact: true }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("取消说明（可选）").fill("计划变更");
  await dialog.getByRole("button", { name: "确认取消申请", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.equal(await row("QA待审批取消").count(), 0);
  await page.getByRole("button", { name: "已取消", exact: true }).click();
  assert.match(await row("QA待审批取消").innerText(), /已取消/);
  assert.equal(await row("QA待审批取消").getByRole("button", { name: "取消申请", exact: true }).count(), 0);
  await page.screenshot({ path: "outputs/pending-cancel-desktop.png", fullPage: true });

  // Expired pending requests remain cancellable, including from mobile details.
  await page.clock.fastForward(48 * 3600000);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: /^待审批 / }).click();
  assert.equal(await row("QA过期待审批取消").getByRole("button", { name: "取消申请", exact: true }).count(), 1);
  await row("QA过期待审批取消").getByRole("button", { name: "详情", exact: true }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "取消申请", exact: true }).click();
  dialog = page.getByRole("dialog");
  assert.equal(await dialog.count(), 1);
  const bounds = await dialog.boundingBox();
  assert(bounds.x >= 0 && bounds.x + bounds.width <= 390);
  await page.screenshot({ path: "outputs/pending-cancel-mobile.png", fullPage: true });
  await dialog.getByRole("button", { name: "确认取消申请", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.equal(await row("QA过期待审批取消").count(), 0);
  await page.getByRole("button", { name: "已取消", exact: true }).click();
  assert.match(await row("QA过期待审批取消").innerText(), /已取消/);
  await page.getByLabel("演示角色").selectOption("visitor");
  await page.getByRole("button", { name: "全部申请", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "取消申请", exact: true }).count(), 0);
  assert.deepEqual(errors, []);
  console.log("PASS: contact pending cancellation from desktop list/mobile details, expired interval, optional reason, dismiss, cancelled history, other-group and visitor restrictions");
} finally {
  await browser.close();
}
