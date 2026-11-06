import { chromium } from "playwright";
import assert from "node:assert/strict";
const base = process.env.BASE_URL ?? "http://127.0.0.1:5173";
const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy;
const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL ?? "chromium", args: ["--no-sandbox"],
  ...(proxy && !/^http:\/\/(127\.0\.0\.1|localhost)/.test(base) ? { proxy: { server: proxy } } : {}),
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.goto(base + "/demo", { waitUntil: "networkidle" });
  await page.clock.setFixedTime(new Date("2026-10-21T02:00:00Z"));
  await page.getByRole("button", { name: "申请与审批", exact: true }).click();
  const resource = "Atlas-910B-02"; // Existing exclusive server, no demo bookings on the next day.
  async function request(purpose, start, end, group) {
    await page.getByRole("button", { name: "申请资源", exact: true }).click();
    const d = page.getByRole("dialog");
    await d.getByText(resource, { exact: true }).click();
    await d.getByLabel("使用者").selectOption(group);
    await d.getByLabel("开始时间 *", { exact: true }).fill(start);
    await d.getByLabel("结束时间 *", { exact: true }).fill(end);
    await d.getByLabel("任务用途").fill(purpose);
    await d.getByRole("button", { name: "提交申请", exact: true }).click();
    await d.waitFor({ state: "hidden" });
    return page.getByRole("row").filter({ hasText: purpose });
  }
  async function approve(row) {
    await row.getByRole("button", { name: "审批", exact: true }).click();
    const d = page.getByRole("dialog");
    await d.getByRole("button", { name: "确认批准", exact: true }).click();
    await d.waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "全部申请", exact: true }).click();
  }
  const row = await request("QA原独占9–19", "2026-10-22T09:00", "2026-10-22T19:00", "g1");
  await approve(row);
  await row.getByRole("button", { name: "取消部分时段", exact: true }).click();
  let d = page.getByRole("dialog");
  await d.getByLabel("取消开始时间 *", { exact: true }).fill("2026-10-22T12:00");
  await d.getByLabel("取消结束时间 *", { exact: true }).fill("2026-10-22T14:00");
  await d.getByLabel("取消原因 *", { exact: true }).fill("QA临时任务需要独占12–14点");
  const preview = d.getByRole("region", { name: "时段调整预览" });
  assert.match(await preview.innerText(), /取消：10\/22 12:00 → 10\/22 14:00/);
  assert.match(await preview.innerText(), /保留：10\/22 09:00 → 10\/22 12:00；10\/22 14:00 → 10\/22 19:00/);
  await page.screenshot({ path: "outputs/partial-cancel-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
  assert(await d.evaluate(e => e.scrollWidth <= e.clientWidth + 1));
  await page.screenshot({ path: "outputs/partial-cancel-mobile.png", fullPage: true });
  await d.getByRole("button", { name: "确认取消所选时段", exact: true }).click();
  await d.waitFor({ state: "hidden" });
  await page.setViewportSize({ width: 1440, height: 1050 });
  assert.match(await row.innerText(), /有效排期：10\/22 09:00 → 10\/22 12:00；10\/22 14:00 → 10\/22 19:00/);
  await row.getByRole("button", { name: "详情", exact: true }).click();
  d = page.getByRole("dialog");
  const actual = d.getByRole("region", { name: "实际有效排期" });
  assert.equal(await actual.locator(".booking-list > div").count(), 2);
  assert.match(await d.innerText(), /独占/);
  await d.getByLabel("关闭", { exact: true }).click();
  const gap = await request("QA空档独占任务", "2026-10-22T12:00", "2026-10-22T14:00", "g2");
  await approve(gap);
  const conflict = await request("QA仍然冲突", "2026-10-22T11:00", "2026-10-22T13:00", "g3");
  await conflict.getByRole("button", { name: "审批", exact: true }).click();
  d = page.getByRole("dialog");
  assert.match(await d.innerText(), /2 条已批准预约冲突/);
  await d.getByLabel("关闭", { exact: true }).click();
  await page.getByRole("button", { name: "全部申请", exact: true }).click();
  await page.getByLabel("演示角色").selectOption("contact");
  assert.equal(await row.getByRole("button", { name: "取消部分时段", exact: true }).count(), 1);
  assert.equal(await gap.getByRole("button", { name: "取消部分时段", exact: true }).count(), 0);
  await page.getByLabel("演示角色").selectOption("visitor");
  assert.equal(await page.getByRole("button", { name: "取消部分时段", exact: true }).count(), 0);
  await page.getByRole("button", { name: "使用排期", exact: true }).click();
  await page.getByLabel("排期日期").fill("2026-10-22");
  await page.getByLabel("搜索排期资源").fill(resource);
  const original = page.locator('.schedule-usage-name[title*="QA原独占9–19"]');
  assert.equal(await original.count(), 1);
  assert.equal((await original.getAttribute("title")).match(/QA原独占9–19/g).length, 2);
  assert.equal(await page.locator('.schedule-usage-name[title*="QA空档独占任务"]').count(), 1);
  await page.getByLabel("演示角色").selectOption("admin");
  await page.getByRole("button", { name: "变更历史", exact: true }).click();
  assert.match(await page.locator("main").innerText(), /取消部分时段/);
  assert.match(await page.locator("main").innerText(), /QA临时任务需要独占12–14点/);
  assert.deepEqual(errors, []);
  console.log("PASS: partial cancellation preview, exclusive 9–12/14–19 retained, 12–14 rebooking, outside conflicts, actual timeline/details/history, ownership controls and mobile dialog");
} finally { await browser.close(); }
