import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";

const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL ?? "chrome" });
const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
const errors = [];
page.on("pageerror", e => errors.push(e.message));
const date = new Date(Date.now() + 3 * 86400000 + 8 * 3600000).toISOString().slice(0, 10);
const base = process.env.BASE_URL ?? "http://127.0.0.1:5173";
mkdirSync("outputs/priority", { recursive: true });
try {
  await page.goto(`${base}/demo`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => document.querySelector('[aria-label="演示角色"]')?.value === "admin");
  async function submit(purpose, priority, group, start = "00:00", end = "23:00", expected) {
    await page.getByRole("button", { name: "申请资源", exact: true }).click();
    const d = page.getByRole("dialog");
    await d.getByText("Atlas-910B-01", { exact: true }).click();
    await d.getByLabel("使用者", { exact: true }).selectOption(group);
    await d.getByLabel("开始时间 *", { exact: true }).fill(`${date}T${start}`);
    await d.getByLabel("结束时间 *", { exact: true }).fill(`${date}T${end}`);
    await d.getByLabel("任务优先级", { exact: true }).selectOption(priority);
    await d.getByLabel("任务用途 *", { exact: true }).fill(purpose);
    if (expected) assert.match(await d.getByRole("region", { name: "优先级与排期预览" }).innerText(), expected);
    if (purpose === "QA红框任务二") await page.screenshot({ path: "outputs/priority/application.png", fullPage: true });
    await d.getByRole("button", { name: "提交申请", exact: true }).click();
    await d.waitFor({ state: "hidden" });
    await page.getByRole("row").filter({ hasText: purpose }).getByRole("button", { name: "审批", exact: true }).click();
    const review = page.getByRole("dialog");
    const preempt = review.getByRole("checkbox", { name: /确认抢占/ });
    if (await preempt.count()) {
      assert(await review.getByRole("button", { name: "确认批准", exact: true }).isDisabled());
      await preempt.check();
      await review.getByLabel("处理原因 *", { exact: true }).fill("QA验证共享优先级抢占");
      await review.getByRole("button", { name: "确认抢占并批准", exact: true }).click();
    } else await review.getByRole("button", { name: "确认批准", exact: true }).click();
    await review.waitFor({ state: "hidden" });
  }
  await submit("QA蓝框普通任务", "normal", "g1");
  await submit("QA红框任务一", "high", "g2", "10:00", "12:00", /可抢占低优/);
  await submit("QA红框任务二", "high", "g3", "10:00", "12:00", /同级共享/);
  await submit("QA低优候补排期", "normal", "g4", "10:00", "12:00", /暂不可用/);
  await page.getByRole("button", { name: "使用排期", exact: true }).click();
  await page.getByRole("button", { name: "单日", exact: true }).click();
  await page.getByLabel("排期日期").fill(date);
  await page.getByLabel("搜索排期资源").fill("192.0.2.11");
  const low = page.locator('.schedule-usage-name[title*="QA蓝框普通任务"]');
  const high = page.locator(".timeline-booking").filter({ hasText: "QA红框任务一" });
  const peer = page.locator(".timeline-booking").filter({ hasText: "QA红框任务二" });
  assert.match(await low.getAttribute("title"), /部分时段被抢占/);
  assert.equal(await page.locator(".timeline-booking.priority-normal").count(), 0);
  assert.equal(await page.locator(".timeline-blocked-overlay").count(), 0);
  const lowBox = await low.boundingBox(), highBox = await high.boundingBox(), peerBox = await peer.boundingBox();
  const firstHigh = highBox.y < peerBox.y ? high : peer;
  assert(lowBox.x + lowBox.width < Math.min(highBox.x, peerBox.x), "ordinary usage stays in the left column");
  assert(Math.abs(highBox.y - peerBox.y) >= highBox.height, "overlapping same-priority bars have separate lines");
  assert(await firstHigh.evaluate(el => {
    const box = el.getBoundingClientRect();
    return el.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
  }), "the high-priority bar is on top and receives clicks in the overlap");
  assert.match(await high.getAttribute("title"), /同级共享 · 可用/);
  assert.match(await page.locator('.schedule-usage-name[title*="QA低优候补排期"]').getAttribute("title"), /已排期 · 暂不可用/);
  await page.screenshot({ path: "outputs/priority/timeline.png", fullPage: true });
  async function filterGroup(value) {
    const group = page.getByLabel("排期组筛选");
    if (!await group.isVisible()) await page.getByRole("button", { name: /^更多筛选/ }).click();
    await group.selectOption(value);
    await page.keyboard.press("Escape");
  }
  await filterGroup("g1");
  assert.match(await low.getAttribute("title"), /部分时段被抢占/);
  assert.equal(await high.count(), 0);
  await page.locator(".schedule-resource-info").click();
  assert.match(await page.getByRole("dialog").innerText(), /部分时段被抢占|暂不可用/);
  await page.getByRole("dialog").getByRole("button", { name: "关闭", exact: true }).first().click();
  await filterGroup("");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "outputs/priority/mobile.png", fullPage: true });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.getByRole("button", { name: "申请资源", exact: true }).click();
  const mobile = page.getByRole("dialog");
  await mobile.getByText("Atlas-910B-01", { exact: true }).click();
  await mobile.getByLabel("开始时间 *", { exact: true }).fill(`${date}T10:00`);
  await mobile.getByLabel("结束时间 *", { exact: true }).fill(`${date}T12:00`);
  await mobile.getByRole("region", { name: "优先级与排期预览" }).scrollIntoViewIfNeeded();
  assert.match(await mobile.getByRole("region", { name: "优先级与排期预览" }).innerText(), /暂不可用/);
  await page.screenshot({ path: "outputs/priority/mobile-application.png", fullPage: true });
  assert(await mobile.evaluate(el => el.scrollWidth <= el.clientWidth + 1));
  assert.deepEqual(errors, []);
  console.log("PASS priority application preview, approval, shared peers, retained low booking, group filter and mobile timeline");
} finally { await browser.close(); }
