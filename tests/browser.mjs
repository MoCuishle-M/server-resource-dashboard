import { chromium } from "playwright";
import assert from "node:assert/strict";
const browser = await chromium.launch({
  headless: true,
  channel: "chromium",
  args: ["--no-sandbox"],
});
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto((process.env.BASE_URL ?? "http://127.0.0.1:5173") + "/demo", {
    waitUntil: "networkidle",
  });
  await page.getByRole("button", { name: "服务器资源", exact: true }).click();
  await page.getByRole("button", { name: "添加服务器", exact: true }).click();
  let d = page.getByRole("dialog");
  await d.getByLabel("服务器名称").fill("QA-Browser-01");
  await d.getByLabel("服务器类型").fill("QA Type");
  await d.getByLabel("IP 地址").fill("192.0.2.199");
  await d.getByRole("button", { name: "保存服务器" }).click();
  await d.waitFor({ state: "hidden" });
  assert.equal(
    await page
      .locator(".resource-name")
      .filter({ hasText: "QA-Browser-01" })
      .count(),
    1,
  );
  await page.getByRole("button", { name: "批量导入", exact: true }).click();
  d = page.getByRole("dialog");
  await d
    .getByLabel("粘贴导入表格")
    .fill(
      "名称\t类型\tIP\t使用方式\nQA-Bulk-A\tQA Type\t192.0.2.200\t裸机\nQA-Bulk-B\tQA Type\t192.0.2.201\t灵枢平台",
    );
  await d.getByRole("button", { name: "确认导入" }).click();
  await d.waitFor({ state: "hidden" });
  assert.equal(
    await page
      .locator(".resource-name")
      .filter({ hasText: "QA-Bulk-" })
      .count(),
    2,
  );
  await page.getByLabel("搜索资源").fill("QA-Bulk");
  await page.getByLabel("全选当前结果").check();
  await page.getByRole("button", { name: "批量删除", exact: true }).click();
  d = page.getByRole("dialog");
  await d.getByRole("button", { name: "确认删除" }).click();
  await d.waitFor({ state: "hidden" });
  assert.equal(
    await page
      .locator(".resource-name")
      .filter({ hasText: "QA-Bulk-" })
      .count(),
    0,
  );
  await page.getByLabel("搜索资源").fill("");
  await page.getByRole("button", { name: "团队与接口人", exact: true }).click();
  await page
    .getByRole("button", { name: "编辑大模型预训练组", exact: true })
    .click();
  d = page.getByRole("dialog");
  await d.getByLabel("接口人姓名").fill("QA接口人");
  await d.getByLabel("接口人工号").fill("QA888");
  await d.getByRole("button", { name: "保存信息" }).click();
  await d.waitFor({ state: "hidden" });
  assert.equal(await page.getByText("QA接口人", { exact: true }).count(), 1);
  await page.getByRole("button", { name: "使用排期", exact: true }).click();
  assert.equal(await page.locator(".schedule-table tbody tr").count(), 17);
  await page.getByRole("button", { name: "申请与审批", exact: true }).click();
  await page.getByRole("button", { name: "新建申请" }).click();
  d = page.getByRole("dialog");
  await d.getByText("QA-Browser-01", { exact: true }).click();
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  await d.getByLabel("时间窗口日期").fill(tomorrow);
  await d.getByRole("button", { name: "21:00–09:00 +1", exact: true }).click();
  await d.getByLabel("任务用途").fill("QA跨夜浏览器流程");
  await d.getByRole("button", { name: "提交申请" }).click();
  await d.waitFor({ state: "hidden" });
  let row = page.getByRole("row").filter({ hasText: "QA跨夜浏览器流程" });
  await row.getByRole("button", { name: "审批", exact: true }).click();
  d = page.getByRole("dialog");
  await d.getByRole("button", { name: "确认批准", exact: true }).click();
  await d.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "已批准", exact: true }).click();
  row = page.getByRole("row").filter({ hasText: "QA跨夜浏览器流程" });
  assert.equal(await row.count(), 1);
  await row.getByRole("button", { name: "取消", exact: true }).click();
  d = page.getByRole("dialog");
  await d.getByLabel("取消 / 释放说明").fill("QA验证完成");
  await d.getByRole("button", { name: "确认处理" }).click();
  await d.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "已取消", exact: true }).click();
  assert.equal(
    await page.getByRole("row").filter({ hasText: "QA跨夜浏览器流程" }).count(),
    1,
  );
  await page.getByRole("button", { name: "变更历史", exact: true }).click();
  await page.getByLabel("搜索历史").fill("QA");
  assert((await page.locator(".audit-item").count()) >= 4);
  await page.getByLabel("演示角色").selectOption("visitor");
  await page.getByRole("button", { name: "服务器资源", exact: true }).click();
  assert.equal(
    await page.getByRole("button", { name: "添加服务器", exact: true }).count(),
    0,
  );
  await page.getByRole("button", { name: "申请资源", exact: true }).click();
  await page.getByRole("heading", { name: "登录后申请资源" }).waitFor();
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  for (const name of [
    "资源总览",
    "服务器资源",
    "使用排期",
    "申请与审批",
    "团队与接口人",
    "变更历史",
  ]) {
    await page.getByRole("button", { name, exact: true }).click();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth),
      390,
      `mobile overflow: ${name}`,
    );
  }
  assert.deepEqual(errors, []);
  console.log(
    "PASS: UI CRUD, table import, bulk delete, group editing, cross-night application, approval, cancellation, history, visitor access, all six mobile layouts; no runtime errors",
  );
} finally {
  await browser.close();
}
