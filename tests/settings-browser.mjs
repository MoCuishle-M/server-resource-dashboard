import { chromium } from "playwright";
import assert from "node:assert/strict";
const base = process.env.BASE_URL ?? "http://127.0.0.1:5173";
const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy;
const browser = await chromium.launch({ headless: true, channel: "chromium", args: ["--no-sandbox"],
  ...(proxy && !/^http:\/\/(127\.0\.0\.1|localhost)/.test(base) ? { proxy: { server: proxy } } : {}),
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.goto(base + "/demo", { waitUntil: "networkidle" });
  const size = page.getByLabel("网页字号", { exact: true });
  assert.equal(await size.inputValue(), "130");
  await size.selectOption("100");
  const standard = await page.evaluate(() => parseFloat(getComputedStyle(document.body).fontSize));
  await size.selectOption("150");
  const largest = await page.evaluate(() => parseFloat(getComputedStyle(document.body).fontSize));
  assert(Math.abs(largest / standard - 1.5) < .01);
  await page.reload({ waitUntil: "networkidle" });
  assert.equal(await size.inputValue(), "150");
  await size.selectOption("130");
  await page.getByRole("button", { name: "网站设置", exact: true }).click();
  const announcement = "计划维护通知\n本周末进行资源调整 <b>纯文本</b>";
  const signature = "作者：测试管理员\n资源管理团队";
  await page.getByLabel("公告内容", { exact: true }).fill(announcement);
  await page.getByLabel("作者签名", { exact: true }).fill(signature);
  await page.getByRole("button", { name: "保存公告与签名", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "公告与作者签名已保存" }).waitFor();
  const banner = page.getByRole("region", { name: "公告栏", exact: true });
  const author = page.getByRole("region", { name: "作者签名栏", exact: true });
  assert.equal(await banner.locator("p").innerText(), announcement);
  assert.equal(await banner.locator("b").count(), 0);
  assert.equal(await author.locator("p").innerText(), signature);
  await page.getByLabel("演示角色").selectOption("visitor");
  await page.getByRole("button", { name: "资源总览", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "网站设置", exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "编辑公告与签名", exact: true }).count(), 0);
  assert.equal(await banner.locator("p").innerText(), announcement);
  await page.getByLabel("演示角色").selectOption("admin");
  await page.getByRole("button", { name: "网站设置", exact: true }).click();
  await page.getByLabel("管理员登录邮箱", { exact: true }).fill("next-admin@example.test");
  await page.getByLabel("管理员姓名", { exact: true }).fill("测试新管理员");
  await page.getByRole("button", { name: "新增管理员", exact: true }).click();
  let row = page.getByRole("row").filter({ hasText: "next-admin@example.test" });
  await row.getByText("待对方登录", { exact: true }).waitFor();
  await row.getByRole("button", { name: "取消邀请", exact: true }).click();
  assert.equal(await row.count(), 0);
  await page.getByLabel("管理员登录邮箱", { exact: true }).fill("contact@example.test");
  await page.getByLabel("管理员姓名", { exact: true }).fill("演示新增管理员");
  await page.getByRole("button", { name: "新增管理员", exact: true }).click();
  row = page.getByRole("row").filter({ hasText: "contact@example.test" });
  await row.getByText("已生效", { exact: true }).waitFor();
  await row.getByRole("button", { name: "撤销管理员", exact: true }).click();
  await row.getByRole("button", { name: "确认撤销", exact: true }).click();
  assert.equal(await row.count(), 0);
  const self = page.getByRole("row").filter({ hasText: "admin@example.test" });
  assert.equal(await self.getByRole("button").count(), 0);
  const views = ["资源总览", "服务器资源", "使用排期", "申请与审批", "团队与接口人", "变更历史", "网站设置"];
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    for (const value of ["100", "115", "130", "150"]) {
      await size.selectOption(value);
      for (const view of views) {
        await page.getByRole("button", { name: view, exact: true }).click();
        const width = await page.evaluate(() => document.documentElement.scrollWidth);
        if (width > viewport.width) {
          const offenders = await page.evaluate(() => [...document.querySelectorAll("main *")].filter(e => e.getBoundingClientRect().right > innerWidth + 1 && !e.closest(".table-scroll")).slice(0, 10).map(e => ({ tag: e.tagName, class: e.className, width: e.getBoundingClientRect().width })));
          assert.fail(`${viewport.width}/${value}/${view}: width=${width}, ${JSON.stringify(offenders)}`);
        }
      }
    }
  }
  await page.screenshot({ path: "outputs/settings-mobile-large.png", fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await size.selectOption("130");
  await page.screenshot({ path: "outputs/settings-desktop.png", fullPage: true });
  assert.deepEqual(errors, []);
  console.log("PASS: four persistent font sizes, public editable announcement/signature with safe plain text, admin invite/cancel/promotion/revoke and all seven views at every size on desktop/mobile");
} finally { await browser.close(); }
