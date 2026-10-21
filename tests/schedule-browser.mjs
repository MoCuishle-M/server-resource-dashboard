import { chromium } from "playwright";
import assert from "node:assert/strict";

const base = process.env.BASE_URL ?? "http://127.0.0.1:5173";
const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy;
const browser = await chromium.launch({ headless: true, channel: "chromium", args: ["--no-sandbox"],
  ...(proxy && !/^http:\/\/(127\.0\.0\.1|localhost)/.test(base) ? { proxy: { server: proxy } } : {}),
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.clock.setFixedTime(new Date("2026-10-21T02:00:00Z"));
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.goto(base + "/demo", { waitUntil: "networkidle" });
  async function approve(purpose, start, end, group) {
    await page.getByRole("button", { name: "申请资源", exact: true }).click();
    let d = page.getByRole("dialog");
    await d.getByText("Atlas-910B-01", { exact: true }).click();
    await d.getByLabel("使用者").selectOption(group);
    await d.getByLabel("开始时间 *", { exact: true }).fill(start);
    await d.getByLabel("结束时间 *", { exact: true }).fill(end);
    await d.getByLabel("任务用途").fill(purpose);
    await d.getByRole("button", { name: "提交申请", exact: true }).click();
    await d.waitFor({ state: "hidden" });
    const row = page.getByRole("row").filter({ hasText: purpose });
    await row.getByRole("button", { name: "审批", exact: true }).click();
    d = page.getByRole("dialog");
    await d.getByRole("button", { name: "确认批准", exact: true }).click();
    await d.waitFor({ state: "hidden" });
  }
  const longPurpose = "QA连续跨夜 · " + "多组共享服务器使用说明".repeat(6);
  await approve(longPurpose, "2026-10-23T21:30", "2026-10-24T06:45", "g1");
  await approve("QA跨周共享", "2026-10-24T00:15", "2026-10-26T03:00", "g2");
  await approve("VLLM组常态占用", "2026-10-22T00:00", "2026-11-01T00:00", "g1");
  await page.getByRole("button", { name: "使用排期", exact: true }).click();
  const scheduleSearch = page.getByLabel("搜索排期资源");
  const scheduleRows = page.locator(".schedule-table tbody tr");
  for (const separator of [" ", ",", "\n", ", \n"]) {
    await scheduleSearch.fill(`192.0.2.11${separator}192.0.2.21${separator}192.0.2.11`);
    assert.equal(await scheduleRows.count(), 2);
  }
  await page.getByRole("button", { name: "排期类型筛选", exact: true }).click();
  let typePanel = page.getByRole("dialog", { name: "排期类型筛选", exact: true });
  await typePanel.getByRole("button", { name: "清空", exact: true }).click();
  await typePanel.getByRole("checkbox", { name: "Ascend 910B · 8卡", exact: true }).check();
  await typePanel.getByRole("button", { name: "确定", exact: true }).click();
  assert.equal(await scheduleRows.count(), 1);
  assert.match(await scheduleRows.innerText(), /192\.0\.2\.11/);
  await page.getByRole("button", { name: "排期类型筛选", exact: true }).click();
  await typePanel.getByRole("button", { name: "清空", exact: true }).click();
  assert.equal(await scheduleRows.count(), 1); // Draft choices do not affect the timeline.
  await typePanel.getByRole("button", { name: "取消", exact: true }).click();
  assert.equal(await scheduleRows.count(), 1);
  await page.getByRole("button", { name: "排期类型筛选", exact: true }).click();
  await typePanel.getByRole("button", { name: "清空", exact: true }).click();
  await typePanel.getByRole("button", { name: "确定", exact: true }).click();
  assert.equal(await scheduleRows.count(), 0);
  await page.getByRole("button", { name: "排期类型筛选", exact: true }).click();
  await typePanel.getByLabel("全选类型", { exact: true }).check();
  await typePanel.getByRole("button", { name: "确定", exact: true }).click();
  assert.equal(await scheduleRows.count(), 2);
  await page.getByLabel("排期组筛选").selectOption("g1");
  assert.equal(await scheduleRows.count(), 1);
  await page.getByLabel("排期组筛选").selectOption("");
  await scheduleSearch.fill("192.0.2.1");
  assert.equal(await scheduleRows.count(), 0); // Exact IP must not match .11.
  await scheduleSearch.fill("北京 · A02机柜");
  assert.equal(await scheduleRows.count(), 8);
  await scheduleSearch.fill("");
  const label = page.locator(".schedule-range-label");
  assert.equal(await page.getByRole("button", { name: "一周", exact: true }).getAttribute("aria-pressed"), "true");
  assert.equal(await label.getAttribute("data-start"), "2026-10-18T16:00:00.000Z");
  assert.equal(await label.getAttribute("data-end"), "2026-10-25T16:00:00.000Z");
  assert.equal(await page.locator(".timeline-tick").count(), 8);
  const overnight = page.locator(".timeline-booking").filter({ hasText: "QA连续跨夜" });
  const shared = page.locator(".timeline-booking").filter({ hasText: "QA跨周共享" });
  assert.equal(await overnight.count(), 1);
  assert.equal(await shared.count(), 1);
  const persistent = page.locator(".timeline-booking").filter({ hasText: "VLLM组常态占用" });
  async function assertPurposeReadable(bar, fullText = false) {
    const box = await bar.evaluate(e => {
      const purpose = e.querySelector(".timeline-purpose");
      const b = e.getBoundingClientRect(), p = purpose.getBoundingClientRect();
      return { barTop: b.top, barBottom: b.bottom, top: p.top, bottom: p.bottom, height: p.height,
        lineHeight: parseFloat(getComputedStyle(purpose).lineHeight), client: purpose.clientHeight, scroll: purpose.scrollHeight };
    });
    assert(box.height >= box.lineHeight - 1, `purpose compressed to ${box.height}px`);
    assert(box.top >= box.barTop && box.bottom <= box.barBottom, "purpose extends outside the bar");
    if (fullText) assert(box.scroll <= box.client + 1, "wide bar truncates the purpose");
  }
  for (const size of ["100", "115", "130", "150"]) {
    await page.getByLabel("网页字号").selectOption(size);
    await assertPurposeReadable(persistent, true);
    await assertPurposeReadable(overnight);
    const boxes = await Promise.all([overnight, shared, persistent].map(bar => bar.boundingBox()));
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++)
      assert(boxes[i].y + boxes[i].height <= boxes[j].y || boxes[j].y + boxes[j].height <= boxes[i].y, "shared lane text overlaps");
    const caption = page.locator(".timeline-caption span").filter({ hasText: longPurpose });
    assert(await caption.evaluate(e => getComputedStyle(e).whiteSpace === "normal" && e.scrollWidth <= e.clientWidth + 1 && e.getBoundingClientRect().height > parseFloat(getComputedStyle(e).lineHeight)), "long caption is clipped instead of wrapping");
  }
  await page.screenshot({ path: "outputs/schedule-readable-text-desktop.png", fullPage: true });
  await page.getByLabel("网页字号").selectOption("130");
  const position = async locator => locator.evaluate(e => ({ left: parseFloat(e.style.left), width: parseFloat(e.style.width), top: e.style.top }));
  let a = await position(overnight), b = await position(shared);
  assert(Math.abs(a.width - 9.25 / 168 * 100) < .001);
  assert(Math.abs(b.left + b.width - 100) < .001);
  assert.notEqual(a.top, b.top);
  await page.getByRole("button", { name: "下一周", exact: true }).click();
  assert.equal(await overnight.count(), 0);
  assert.equal(await shared.count(), 1);
  b = await position(shared);
  assert.equal(b.left, 0);
  assert(Math.abs(b.width - 3 / 168 * 100) < .001);
  await page.getByRole("button", { name: "本周", exact: true }).click();
  await page.getByRole("button", { name: "单日", exact: true }).click();
  await page.getByLabel("排期日期", { exact: true }).fill("2026-10-24");
  assert.equal(await label.getAttribute("data-start"), "2026-10-23T16:00:00.000Z");
  assert.equal(await label.getAttribute("data-end"), "2026-10-24T16:00:00.000Z");
  a = await position(overnight);
  assert.equal(a.left, 0);
  assert(Math.abs(a.width - 6.75 / 24 * 100) < .001);
  await page.getByRole("button", { name: "自定义范围", exact: true }).click();
  await page.getByLabel("排期开始时间", { exact: true }).fill("2026-10-23T23:45");
  await page.getByLabel("排期结束时间", { exact: true }).fill("2026-10-24T00:45");
  await page.getByRole("button", { name: "查看范围", exact: true }).click();
  assert.equal(await label.getAttribute("data-start"), "2026-10-23T15:45:00.000Z");
  a = await position(overnight); b = await position(shared);
  assert.equal(a.width, 100);
  assert.equal(b.left, 50);
  assert.equal(b.width, 50);
  await page.getByLabel("排期组筛选").selectOption("g2");
  assert.equal(await page.locator(".schedule-table tbody tr").count(), 1);
  assert.equal(await overnight.count(), 0);
  assert.equal(await shared.count(), 1);
  await page.getByLabel("排期结束时间", { exact: true }).fill("2026-10-23T20:00");
  await page.getByRole("button", { name: "查看范围", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "结束时间必须晚于开始时间" }).waitFor();
  assert.equal(await label.getAttribute("data-end"), "2026-10-23T16:45:00.000Z");
  await page.getByLabel("排期组筛选").selectOption("");
  await page.getByLabel("搜索排期资源").fill("Atlas-910B-01");
  await page.getByRole("row").filter({ hasText: "Atlas-910B-01" }).getByRole("button", { name: "申请", exact: true }).click();
  const d = page.getByRole("dialog");
  assert.equal(await d.getByLabel("开始时间 *", { exact: true }).inputValue(), "2026-10-23T23:45");
  assert.equal(await d.getByLabel("结束时间 *", { exact: true }).inputValue(), "2026-10-24T00:45");
  await d.getByLabel("时间窗口日期").fill("2026-10-25");
  await d.getByRole("button", { name: "21:00–09:00 +1", exact: true }).click();
  assert.equal(await d.getByLabel("开始时间 *", { exact: true }).inputValue(), "2026-10-25T21:00");
  assert.equal(await d.getByLabel("结束时间 *", { exact: true }).inputValue(), "2026-10-26T09:00");
  await d.getByRole("button", { name: "关闭", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
  assert(await page.locator(".schedule-scroll").evaluate(e => e.scrollWidth > e.clientWidth));
  await page.screenshot({ path: "outputs/schedule-mobile.png", fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "一周", exact: true }).click();
  await page.getByLabel("搜索排期资源").fill("");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel("网页字号").selectOption("150");
  await page.getByRole("button", { name: "排期类型筛选", exact: true }).click();
  typePanel = page.getByRole("dialog", { name: "排期类型筛选", exact: true });
  const typeBounds = await typePanel.boundingBox();
  assert(typeBounds.x >= 0 && typeBounds.x + typeBounds.width <= 390);
  await typePanel.getByRole("button", { name: "取消", exact: true }).click();
  await assertPurposeReadable(persistent, true);
  await assertPurposeReadable(overnight);
  await page.screenshot({ path: "outputs/schedule-readable-text-mobile.png", fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: "outputs/schedule-week.png", fullPage: true });
  assert.deepEqual(errors, []);
  console.log("PASS: timeline type multiselect and draft/empty/all states, batch IP separators/exact matching, combined group filtering, location search, week/day/range, readable purpose text at four font sizes and mobile popup/layout");
} finally { await browser.close(); }
