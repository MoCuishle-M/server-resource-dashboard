import { chromium } from "playwright";
import assert from "node:assert/strict";
const base = process.env.BASE_URL ?? "http://127.0.0.1:5173";
const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy;
const browser = await chromium.launch({
  headless: true,
  channel: "chromium",
  args: ["--no-sandbox"],
  ...(proxy && !/^http:\/\/(127\.0\.0\.1|localhost)/.test(base)
    ? { proxy: { server: proxy } }
    : {}),
});
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base + "/demo", { waitUntil: "networkidle" });
  let row = page
    .getByRole("row")
    .filter({ has: page.getByRole("button", { name: /Atlas-910B-01/ }) });
  assert.equal(
    await row.locator(".group-label").innerText(),
    "大模型预训练组、多模态算法组",
  );
  assert.equal(await row.getByText("共享", { exact: true }).count(), 1);
  await row.getByRole("button", { name: "详情", exact: true }).click();
  let d = page.getByRole("dialog");
  assert.equal(await d.locator(".booking-list>div").count(), 2);
  await d.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "服务器资源", exact: true }).click();
  await page
    .getByRole("button", { name: "编辑 Atlas-910B-01", exact: true })
    .click();
  d = page.getByRole("dialog");
  await d.getByLabel("占用模式").selectOption("exclusive");
  await d.getByRole("button", { name: "保存服务器" }).click();
  await page
    .getByRole("status")
    .filter({ hasText: "重叠的共享预约" })
    .waitFor();
  await d.getByRole("button", { name: "取消", exact: true }).click();
  await page.getByRole("button", { name: "添加服务器", exact: true }).click();
  d = page.getByRole("dialog");
  await d.getByLabel("服务器名称").fill("QA-Shared-8card");
  await d.getByLabel("服务器类型").fill("Ascend 910B · 8卡");
  await d.getByLabel("IP 地址").fill("198.51.100.88");
  await d.getByLabel("占用模式").selectOption("shared");
  await d.getByRole("button", { name: "保存服务器" }).click();
  await d.waitFor({ state: "hidden" });
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  for (const [index, group] of ["g1", "g2"].entries()) {
    await page.getByRole("button", { name: "申请资源", exact: true }).click();
    d = page.getByRole("dialog");
    await d.getByText("QA-Shared-8card", { exact: true }).click();
    await d.getByLabel("使用者").selectOption(group);
    await d.getByLabel("时间窗口日期").fill(tomorrow);
    await d.getByRole("button", { name: "09:00–12:00", exact: true }).click();
    await d.getByLabel("任务用途").fill("QA共享并行任务-" + index);
    await d.getByRole("button", { name: "提交申请" }).click();
    await d.waitFor({ state: "hidden" });
    row = page.getByRole("row").filter({ hasText: "QA共享并行任务-" + index });
    await row.getByRole("button", { name: "审批", exact: true }).click();
    d = page.getByRole("dialog");
    assert.equal(await d.locator(".conflict-panel").count(), 0);
    await d.getByRole("button", { name: "确认批准", exact: true }).click();
    await d.waitFor({ state: "hidden" });
  }
  await page.getByRole("button", { name: "使用排期", exact: true }).click();
  await page.getByLabel("排期日期").fill(tomorrow);
  row = page.getByRole("row").filter({ hasText: "QA-Shared-8card" });
  assert.equal(await row.locator(".booking-chip").count(), 2);
  // Cancel only the first current user's request. The other team must remain on the same machine.
  await page.getByRole("button", { name: "申请与审批", exact: true }).click();
  await page.getByRole("button", { name: "已批准", exact: true }).click();
  row = page
    .getByRole("row")
    .filter({ hasText: "Qwen3 预训练 · 长上下文实验" });
  await row.getByRole("button", { name: "释放", exact: true }).click();
  d = page.getByRole("dialog");
  await d.getByLabel("取消 / 释放说明").fill("仅释放本组共享占用");
  await d.getByRole("button", { name: "确认处理" }).click();
  await d.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "服务器资源", exact: true }).click();
  row = page
    .getByRole("row")
    .filter({ has: page.getByRole("button", { name: /Atlas-910B-01/ }) });
  assert.equal(await row.locator(".group-label").innerText(), "多模态算法组");
  assert.equal(await row.getByText("使用中", { exact: true }).count(), 1);
  await page.getByRole("button", { name: "变更历史", exact: true }).click();
  await page.getByLabel("搜索历史").fill("仅释放本组共享占用");
  assert((await page.locator(".audit-item").count()) > 0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "资源总览", exact: true }).click();
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth),
    390,
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS: shared current teams, protected mode change, shared resource editor, two overlapping group approvals, schedule, release isolation, history and mobile layout",
  );
} finally {
  await browser.close();
}
