import { chromium } from "playwright";
import assert from "node:assert/strict";
const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL ?? "msedge" });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.goto((process.env.BASE_URL ?? "http://127.0.0.1:5173") + "/demo", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "申请与审批", exact: true }).click();
  const pending = page.getByRole("row").filter({ has: page.getByText("待审批", { exact: true }) });
  const count = await pending.count();
  assert(count > 0);
  const row = pending.first();
  for (const [width, priority, label] of [[1440, "high", "高优"], [390, "urgent", "紧急"], [1440, "normal", "普通"]]) {
    await page.setViewportSize({ width, height: 1000 });
    await row.getByRole("button", { name: "调整优先级", exact: true }).click();
    const d = page.getByRole("dialog", { name: "调整申请优先级", exact: true });
    assert.match(await d.innerText(), /申请仍待审批/);
    assert(await d.getByRole("button", { name: "保存优先级", exact: true }).isDisabled());
    await d.getByLabel("调整后的优先级").selectOption(priority);
    await d.getByLabel("调整优先级原因").fill("管理员协调待审批任务");
    assert(await d.getByRole("button", { name: "保存优先级", exact: true }).isDisabled());
    await d.getByRole("checkbox", { name: /确认调整申请优先级/ }).check();
    await d.getByRole("button", { name: "保存优先级", exact: true }).click();
    await d.waitFor({ state: "hidden" });
    assert.equal(await pending.count(), count);
    await row.getByText(label, { exact: true }).waitFor();
  }
  await page.getByLabel("演示角色").selectOption("visitor");
  assert.equal(await page.getByRole("button", { name: "调整优先级", exact: true }).count(), 0);
  assert.deepEqual(errors, []);
  console.log("PASS pending priority: desktop/mobile normal/high/urgent, confirmation, pending status retained, visitor restriction");
} finally { await browser.close(); }
