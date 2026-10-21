import { chromium } from "playwright";
import ExcelJS from "exceljs";
import assert from "node:assert/strict";
const base = process.env.BASE_URL ?? "http://127.0.0.1:5173";
const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy;
const browser = await chromium.launch({
  headless: true,
  channel: "chromium",
  args: ["--no-sandbox"],
  ...(proxy && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(base)
    ? { proxy: { server: proxy } }
    : {}),
});
async function workbookFile(rows, name = "资源清单", extraSheet = false) {
  const w = new ExcelJS.Workbook();
  if (extraSheet) w.addWorksheet("说明").addRow(["请选择资源清单工作表"]);
  w.addWorksheet(name).addRows(rows);
  return Buffer.from(await w.xlsx.writeBuffer());
}
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base + "/demo", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "服务器资源", exact: true }).click();
  await page.getByRole("button", { name: "批量导入", exact: true }).click();
  let d = page.getByRole("dialog");
  const downloadPromise = page.waitForEvent("download");
  await d.getByRole("button", { name: "下载 Excel 模板", exact: true }).click();
  const download = await downloadPromise;
  assert(download.suggestedFilename().endsWith(".xlsx"));
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const template = new ExcelJS.Workbook();
  await template.xlsx.load(Buffer.concat(chunks));
  assert.equal(template.worksheets[0].getCell("C1").text, "IP");
  const data = await workbookFile(
    [
      ["名称", "类型", "IP", "使用方式", "占用模式", "位置", "备注", "状态"],
      [
        "Excel-A",
        "950DT  * 8卡",
        "198.51.100.151",
        "裸机",
        "共享",
        "苏州A",
        "导入备注A",
        "可申请",
      ],
      [
        "Excel-B",
        "950DT  * 8卡",
        "198.51.100.152",
        "灵枢平台",
        "共享",
        "苏州B",
        "导入备注B",
        "可申请",
      ],
    ],
    "资源清单",
    true,
  );
  await d
    .getByLabel("上传资源表格")
    .setInputFiles({
      name: "服务器资源.xlsx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buffer: data,
    });
  await d.getByLabel("选择工作表").waitFor();
  await d.getByLabel("选择工作表").selectOption({ label: "资源清单" });
  await d.getByText("导入备注A", { exact: true }).waitFor();
  await d.getByRole("button", { name: "确认导入", exact: true }).click();
  await d.waitFor({ state: "hidden" });
  // The native option value must preserve consecutive whitespace from Excel.
  const typeFilter = page.getByLabel("类型筛选", { exact: true });
  const importedType = "950DT  * 8卡";
  assert.equal(
    await typeFilter.locator("option").evaluateAll((options, type) =>
      options.find((option) => option.textContent === type)?.value,
      importedType,
    ),
    importedType,
  );
  await typeFilter.selectOption(importedType);
  assert.equal(await page.locator(".resource-table tbody tr").count(), 2);
  await typeFilter.selectOption("");
  await page.getByLabel("搜索资源").fill("Excel-");
  await page.getByLabel("全选当前结果").check();
  await page.getByRole("button", { name: "批量修改", exact: true }).click();
  d = page.getByRole("dialog");
  assert.equal(await d.locator('input[name="ip"]').count(), 0);
  await d.getByLabel("修改名称模板", { exact: true }).check();
  await d.getByLabel("批量名称模板", { exact: true }).fill("批量-{index}-{ip}");
  await d.getByLabel("修改类型", { exact: true }).check();
  await d.getByLabel("批量类型", { exact: true }).fill("批量新类型");
  await d.getByLabel("修改位置", { exact: true }).check();
  await d.getByLabel("批量位置", { exact: true }).fill("苏州统一位置");
  await d.getByLabel("修改备注", { exact: true }).check();
  await d.getByLabel("批量备注", { exact: true }).fill("");
  await d.getByText("批量-1-198.51.100.151", { exact: true }).waitFor();
  await d.getByRole("button", { name: "确认批量修改", exact: true }).click();
  await d.waitFor({ state: "hidden" });
  await page.getByLabel("搜索资源").fill("批量新类型");
  let rows = page.locator(".resource-table tbody tr");
  assert.equal(await rows.count(), 2);
  assert((await rows.nth(0).innerText()).includes("198.51.100.151"));
  assert((await rows.nth(1).innerText()).includes("198.51.100.152"));
  assert.equal(
    await page.getByText("苏州统一位置", { exact: true }).count(),
    2,
  );
  // Update with a different workbook using IP identifiers and only filled columns.
  await page.getByRole("button", { name: "批量导入", exact: true }).click();
  d = page.getByRole("dialog");
  await d.getByLabel("导入方式", { exact: true }).selectOption("update");
  const update = await workbookFile([
    ["IP", "类型", "备注", "位置"],
    ["198.51.100.151", "Excel更新类型A", "新备注A", ""],
    ["198.51.100.152", "Excel更新类型B", "新备注B", ""],
  ]);
  await d
    .getByLabel("上传资源表格")
    .setInputFiles({
      name: "按IP更新.xlsx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buffer: update,
    });
  await d.getByText("新备注A", { exact: true }).waitFor();
  await d.getByRole("button", { name: "确认导入", exact: true }).click();
  await d.waitFor({ state: "hidden" });
  await page.getByLabel("搜索资源").fill("Excel更新类型");
  rows = page.locator(".resource-table tbody tr");
  assert.equal(await rows.count(), 2);
  assert.equal(
    await page.getByText("苏州统一位置", { exact: true }).count(),
    2,
  );
  await rows.first().getByRole("button", { name: "详情", exact: true }).click();
  d = page.getByRole("dialog");
  await d.getByText("新备注A", { exact: true }).waitFor();
  await d.getByRole("button", { name: "关闭", exact: true }).click();
  // An invalid workbook must clear an old preview and prevent submission.
  await page.getByRole("button", { name: "批量导入", exact: true }).click();
  d = page.getByRole("dialog");
  await d
    .getByLabel("上传资源表格")
    .setInputFiles({
      name: "损坏文件.xlsx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buffer: Buffer.from("invalid"),
    });
  await d.getByText(/无法读取 Excel/).waitFor();
  assert(
    await d.getByRole("button", { name: "确认导入", exact: true }).isDisabled(),
  );
  await d.getByRole("button", { name: "取消", exact: true }).click();
  await page.getByRole("button", { name: "变更历史", exact: true }).click();
  await page.getByLabel("搜索历史").fill("198.51.100.151");
  assert((await page.locator(".audit-item").count()) >= 2);
  await page.getByRole("button", { name: "服务器资源", exact: true }).click();
  await page.getByLabel("搜索资源").fill("Excel更新类型");
  await page.getByLabel("全选当前结果").check();
  await page.getByRole("button", { name: "批量修改", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth),
    390,
  );
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "取消", exact: true })
    .click();
  assert.deepEqual(errors, []);
  console.log(
    "PASS: real XLSX template/download, worksheet selection, Excel import and preview, opt-in bulk editing with immutable IP, name templates, clearing notes, IP-based workbook update, invalid file handling, history and mobile modal",
  );
} finally {
  await browser.close();
}
