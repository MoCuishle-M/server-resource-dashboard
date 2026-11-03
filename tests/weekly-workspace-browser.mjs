import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import ExcelJS from "exceljs";
const base = process.env.BASE_URL ?? "http://127.0.0.1:5173";
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(base)) throw new Error("Use local demo data only");
mkdirSync("outputs/guided-workflow", { recursive: true });
const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL ?? "chrome" });
const page = await browser.newPage({ viewport: { width: 1560, height: 1050 } }), errors = [];
page.on("pageerror", e => errors.push(e.message)); page.on("dialog", d => d.accept());
try {
  await page.goto(base + "/demo", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "每周需求与排期", exact: true }).click();
  await page.getByRole("button", { name: "创建 A5 双流程周计划", exact: true }).click();
  let dialog = page.getByRole("dialog"); await dialog.getByLabel("周起始日期（北京时间周一）").fill("2030-01-14");
  await dialog.getByRole("button", { name: "创建计划并制定规则", exact: true }).click(); await dialog.waitFor({ state: "hidden" });
  assert.equal(await page.getByRole("button", { name: "填写白天需求", exact: true }).count(), 0);
  assert.equal(await page.locator(".workflow-steps li").count(), 5);
  const rules = page.locator(".workflow-settings"), groups = rules.locator("fieldset input[type=checkbox]");
  for (let i = 2; i < await groups.count(); i++) await groups.nth(i).uncheck();
  await rules.getByRole("checkbox", { name: "本周周六白天开放多机（09:00–19:00）" }).check();
  const modelRules = [["deepseek", "0"], ["qwen", "1"], ["llama", "2"], ["kimi", "3"]];
  for (const [i, [label, priority]] of modelRules.entries()) {
    await rules.getByRole("button", { name: "添加模型标签", exact: true }).click();
    await rules.getByLabel(`模型标签名称 ${i + 1}`, { exact: true }).fill(label);
    await rules.getByLabel(`模型标签优先级 ${i + 1}`, { exact: true }).selectOption(priority);
  }
  await page.screenshot({ path: "outputs/guided-workflow/model-rules.png", fullPage: true });
  await rules.getByRole("button", { name: "完成规则，开放需求收集", exact: true }).click();
  await page.getByRole("button", { name: "填写白天需求", exact: true }).waitFor();
  await page.screenshot({ path: "outputs/guided-workflow/collect.png", fullPage: true });
  for (const [group, title] of [["g1", "一组白天开发"], ["g2", "二组白天开发"]]) {
    await page.getByRole("button", { name: "填写白天需求", exact: true }).click(); dialog = page.getByRole("dialog");
    await dialog.getByLabel("组别", { exact: true }).selectOption(group); await dialog.getByLabel("使用事项", { exact: true }).fill(title);
    if (group === "g1") {
      await dialog.getByRole("checkbox", { name: "deepseek", exact: true }).check();
      await dialog.getByRole("checkbox", { name: "qwen", exact: true }).check();
      await dialog.getByRole("checkbox", { name: "llama", exact: true }).check();
    }
    await dialog.getByRole("button", { name: "保存需求", exact: true }).click(); await dialog.waitFor({ state: "hidden" });
  }
  const dayDemand = page.locator(".workspace-demands tbody tr").filter({ hasText: "一组白天开发" });
  await dayDemand.getByRole("button", { name: "编辑", exact: true }).click(); dialog = page.getByRole("dialog");
  assert.equal(await dialog.getByRole("checkbox", { name: "deepseek", exact: true }).isChecked(), true);
  assert.equal(await dialog.getByRole("checkbox", { name: "qwen", exact: true }).isChecked(), true);
  assert.equal(await dialog.getByRole("checkbox", { name: "llama", exact: true }).isChecked(), true);
  assert.equal(await dialog.getByRole("checkbox", { name: "glm", exact: true }).count(), 0);
  await dialog.getByRole("checkbox", { name: "qwen", exact: true }).uncheck();
  await dialog.getByRole("button", { name: "保存需求", exact: true }).click(); await dialog.waitFor({ state: "hidden" });
  assert.match(await dayDemand.innerText(), /deepseek.*llama/); assert.match(await dayDemand.innerText(), /P0/); assert.doesNotMatch(await dayDemand.innerText(), /qwen/);
  await page.getByRole("button", { name: "结束收集，进入协商", exact: true }).click();
  for (const title of ["一组白天开发", "二组白天开发"]) await page.getByLabel(title + "协商台数", { exact: true }).fill("1");
  await page.getByRole("button", { name: "保存协商数量", exact: true }).click();
  await page.getByRole("button", { name: "生成推荐草案并进入分配", exact: true }).click();
  await page.getByRole("heading", { name: "A5 服务器分配表", exact: true }).waitFor();
  assert.equal(await page.locator("dialog.modal[open]").count(), 0, "sheet must be a full page");
  assert.equal(await page.locator(".sheet-choice-option").count(), 0, "group lists stay hidden until a cell is clicked");
  assert.equal(await page.locator(".allocation-grid tbody tr").count(), 2);
  async function groupsFor(ip, remove, add) {
    await page.getByRole("button", { name: ip + "使用组", exact: true }).click();
    const picker = page.getByRole("dialog", { name: ip + "使用组选项", exact: true });
    await picker.getByRole("checkbox", { name: remove, exact: true }).uncheck();
    await picker.getByRole("checkbox", { name: add, exact: true }).check();
    await picker.getByRole("button", { name: "完成", exact: true }).click();
  }
  await groupsFor("192.0.2.24", "大模型预训练组", "多模态算法组");
  await groupsFor("192.0.2.25", "多模态算法组", "大模型预训练组");
  await page.getByLabel("192.0.2.24 多模态算法组用途", { exact: true }).fill("在线表格直接修改用途");
  await page.getByLabel("192.0.2.24特殊用途", { exact: true }).fill("23:00～次日09:00\n加拿大同事使用空闲卡\n不动现有进程与容器");
  assert.ok(await page.getByLabel("192.0.2.24特殊用途", { exact: true }).evaluate(el => el.scrollHeight <= el.clientHeight + 1), "notes must display without an internal scrollbar");
  await page.getByRole("button", { name: "保存分配", exact: true }).click();
  await page.getByText("表格已同步", { exact: true }).waitFor();
  await page.screenshot({ path: "outputs/guided-workflow/day-sheet.png", fullPage: true });
  await page.getByRole("button", { name: "返回流程 · 确认发布", exact: true }).click();
  await page.getByRole("button", { name: "分配完成，进入确认", exact: true }).click();
  for (let i = 0; i < 2; i++) {
    await page.getByRole("button", { name: "代确认 / 记录反馈", exact: true }).nth(i).click(); dialog = page.getByRole("dialog");
    await dialog.getByLabel("代确认原因（必填）").fill("周会确认"); await dialog.getByRole("button", { name: "保存确认结果", exact: true }).click(); await dialog.waitFor({ state: "hidden" });
  }
  await page.getByRole("button", { name: "发布白天周分配", exact: true }).click(); dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "确认发布", exact: true }).click(); await dialog.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "多机时段分配", exact: true }).click();
  await page.getByRole("button", { name: "填写多机需求", exact: true }).click(); dialog = page.getByRole("dialog");
  await dialog.getByLabel("组别", { exact: true }).selectOption("g1"); await dialog.getByLabel("使用事项", { exact: true }).fill("Qwen 连续多机训练");
  await dialog.getByLabel("所需总台数（含常态机）").fill("3");
  await dialog.getByRole("checkbox", { name: "qwen", exact: true }).check();
  await dialog.getByRole("checkbox", { name: "kimi", exact: true }).check();
  await dialog.locator(".workspace-slot-picker input").nth(0).check(); await dialog.locator(".workspace-slot-picker input").nth(1).check();
  await dialog.getByRole("checkbox", { name: "必须同一批服务器连续使用（请选择相邻时段）" }).check();
  assert.match(await dialog.innerText(), /填报后申请3 \/ 容量2 · 超额1/);
  await dialog.getByRole("button", { name: "保存需求", exact: true }).click(); await dialog.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "结束收集，进入协商", exact: true }).click();
  await page.getByLabel("Qwen 连续多机训练协商台数", { exact: true }).fill("2");
  await page.getByRole("button", { name: "保存协商数量", exact: true }).click();
  await page.getByRole("button", { name: "生成推荐草案并进入分配", exact: true }).click();
  await page.getByRole("heading", { name: "A5 服务器分配表", exact: true }).waitFor();
  assert.equal(await page.getByLabel("分配流程", { exact: true }).inputValue(), "multi");
  await page.getByRole("checkbox", { name: "锁定该任务安排", exact: true }).first().check();
  await page.getByRole("button", { name: "保存分配", exact: true }).click(); await page.getByText("表格已同步", { exact: true }).waitFor();
  await page.getByRole("button", { name: "返回流程 · 确认发布", exact: true }).click();
  await page.getByRole("button", { name: "分配完成，进入确认", exact: true }).click();
  await page.getByLabel("演示角色").selectOption("contact");
  await page.getByRole("button", { name: "确认本组安排", exact: true }).click(); dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "保存确认结果", exact: true }).click(); await dialog.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "服务器分配", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "192.0.2.24多机任务", exact: true }).isDisabled(), true);
  await page.getByRole("button", { name: "返回流程 · 确认发布", exact: true }).click();
  await page.getByLabel("演示角色").selectOption("admin");
  await page.getByRole("button", { name: "发布多机时段分配", exact: true }).click(); dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "确认发布", exact: true }).click(); await dialog.waitFor({ state: "hidden" });
  const downloadPromise = page.waitForEvent("download"); await page.getByRole("button", { name: "导出 Excel", exact: true }).click();
  const download = await downloadPromise; await download.saveAs("outputs/guided-workflow/export.xlsx");
  const book = new ExcelJS.Workbook(); await book.xlsx.readFile("outputs/guided-workflow/export.xlsx");
  assert.equal(book.worksheets.length, 6); assert.equal(book.getWorksheet("多机需求").rowCount, 3); assert.equal(book.getWorksheet("多机分配").rowCount, 5);
  assert.equal(book.getWorksheet("时段容量").getCell("G2").value, 1); assert.equal(book.getWorksheet("时段容量").getCell("H2").value, 2);
  assert.match(book.getWorksheet("白天分配").getCell("I2").text, /在线表格直接修改用途/);
  assert.match(book.getWorksheet("白天需求").getCell("J2").text, /deepseek.*llama/);
  assert.match(book.getWorksheet("多机需求").getCell("K2").text, /qwen.*kimi/);
  assert.match(book.getWorksheet("白天需求").getCell("L2").text, /P0/);
  assert.match(book.getWorksheet("多机需求").getCell("O2").text, /P1/);
  assert.match(book.getWorksheet("发布与使用说明").getColumn(1).values.join(" "), /模型标签：llama/);
  await page.screenshot({ path: "outputs/guided-workflow/published.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: "outputs/guided-workflow/mobile.png", fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "mobile page must not overflow");
  assert.deepEqual(errors, []);
  console.log("PASS: guided rules-first workflow, separate allocation navigation, cell pickers, inline purposes/full notes, atomic saves, independent publications, contact permissions, continuous tasks and export");
} catch (error) { await page.screenshot({ path: "outputs/guided-workflow/failure.png", fullPage: true }); throw error; }
finally { await browser.close(); }
