import { chromium } from 'playwright';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const base = process.env.BASE_URL ?? 'http://127.0.0.1:5173';
const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy;
const browser = await chromium.launch({ headless: true, channel: 'chromium', args: ['--no-sandbox'],
  ...(proxy && !/^http:\/\/(127\.0\.0\.1|localhost)/.test(base) ? { proxy: { server: proxy } } : {}) });
async function visibleFeedback(page, selector = '.modal-feedback') {
  await page.waitForFunction(selector => {
    const el = document.querySelector(selector);
    if (!el) return false;
    const r = el.getBoundingClientRect(), d = el.closest('dialog')?.getBoundingClientRect();
    return r.top >= Math.max(0, d?.top ?? 0) && r.bottom <= Math.min(innerHeight, d?.bottom ?? innerHeight)
      && r.left >= 0 && r.right <= innerWidth;
  }, selector);
}
try {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 700 }]) {
    const page = await browser.newPage({ viewport });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(base + '/demo', { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForFunction(() => document.querySelector('[aria-label="演示角色"]')?.value === 'admin', {}, { timeout: 90000 });
    await page.getByLabel('网页字号', { exact: true }).selectOption('150');
    await page.getByRole('button', { name: '服务器资源', exact: true }).click();
    await page.getByLabel('选择 Atlas-910B-01', { exact: true }).check();
    await page.getByLabel('选择 Atlas-950-01', { exact: true }).check();
    await page.getByRole('button', { name: '批量修改', exact: true }).click();
    let d = page.getByRole('dialog');
    await d.getByLabel('修改资源状态', { exact: true }).check();
    await d.getByLabel('批量资源状态', { exact: true }).selectOption('maintenance');
    await d.getByRole('button', { name: '确认批量修改', exact: true }).click();
    await visibleFeedback(page);
    const alert = d.getByRole('alert');
    assert.match(await alert.innerText(), /还有有效预约.*先取消或释放预约再设为维护中/);
    assert.equal(await alert.evaluate(el => el === document.activeElement), true);
    assert.equal(await page.locator('.toast').count(), 0);
    await page.waitForTimeout(4800);
    await d.evaluate(el => { el.scrollTop = el.scrollHeight; });
    await visibleFeedback(page); // The error also stays visible while scrolling the form.
    await page.screenshot({ path: `outputs/operation-feedback-${viewport.width}.png` });
    assert.equal(await d.getByLabel('批量资源状态', { exact: true }).inputValue(), 'maintenance');
    await d.getByLabel('关闭提示', { exact: true }).click();
    assert.equal(await d.getByRole('alert').count(), 0);
    await d.getByRole('button', { name: '确认批量修改', exact: true }).click();
    await visibleFeedback(page);
    await d.getByLabel('关闭', { exact: true }).click();
    assert.equal(await page.locator('.operation-feedback.error').count(), 0);
    // Rejected bulk edits are atomic, including the other unoccupied server.
    await page.getByLabel('编辑 Atlas-950-01', { exact: true }).click();
    d = page.getByRole('dialog');
    assert.equal(await d.getByLabel('资源状态', { exact: true }).inputValue(), 'available');
    assert.equal(await d.getByRole('alert').count(), 0);
    await d.getByRole('button', { name: '保存服务器', exact: true }).click();
    await d.waitFor({ state: 'hidden' });
    await page.locator('.toast.success').waitFor(); // Success survives the dialog closing.
    await page.getByLabel('编辑 Atlas-910B-01', { exact: true }).click();
    d = page.getByRole('dialog');
    await d.getByLabel('资源状态', { exact: true }).selectOption('maintenance');
    await d.getByRole('button', { name: '保存服务器', exact: true }).click();
    await visibleFeedback(page);
    assert.match(await d.getByRole('alert').innerText(), /还有有效预约/);
    await page.keyboard.press('Escape');
    await d.waitFor({ state: 'hidden' });
    assert.equal(await page.locator('.operation-feedback.error').count(), 0);
    assert.deepEqual(errors, []);
    await page.close();
  }
  // Exercise the shared API failure path across independent dialogs and outside a dialog.
  await build({ entryPoints: ['lib/demo.ts'], bundle: true, platform: 'node', format: 'esm', outfile: '.sites-runtime/tests/operation-feedback-demo.mjs' });
  const { demoState } = await import(pathToFileURL(process.cwd() + '/.sites-runtime/tests/operation-feedback-demo.mjs'));
  const state = { ...demoState(), demo: false };
  const page = await browser.newPage({ viewport: { width: 390, height: 700 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.route('**/api/state', route => route.fulfill({ json: state }));
  const actions = [];
  await page.route('**/api/action', route => {
    const { type } = route.request().postDataJSON(); actions.push(type);
    return route.fulfill({ status: 409, json: { error: `请求被拒绝：${type}，请检查权限和当前数据后重试。` } });
  });
  await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 90000 });
  async function rejected(type, button) {
    await button.click();
    await visibleFeedback(page);
    const d = page.getByRole('dialog');
    assert.match(await d.getByRole('alert').innerText(), new RegExp(type));
    assert.equal(actions.at(-1), type);
    await d.getByLabel('关闭', { exact: true }).click();
    assert.equal(await page.locator('.operation-feedback.error').count(), 0);
  }
  await page.getByRole('button', { name: '服务器资源', exact: true }).click();
  await page.getByLabel('编辑 Atlas-950-01', { exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '删除服务器', exact: true }).click();
  await rejected('resource.delete', page.getByRole('dialog').getByRole('button', { name: '确认删除', exact: true }));
  await page.getByRole('button', { name: '批量导入', exact: true }).click();
  await page.getByLabel('粘贴导入表格').fill('名称\t类型\tIP\t使用方式\nQA错误测试\t950DT*8卡\t192.0.2.250\t裸机');
  await rejected('resource.import', page.getByRole('dialog').getByRole('button', { name: '确认导入', exact: true }));
  await page.getByRole('button', { name: '申请与审批', exact: true }).click();
  await page.getByRole('button', { name: '审批', exact: true }).first().click();
  await rejected('request.review', page.getByRole('dialog').getByRole('button', { name: '确认批准', exact: true }));
  await page.getByRole('button', { name: '释放', exact: true }).first().click();
  await rejected('request.cancel', page.getByRole('dialog').getByRole('button', { name: '确认处理', exact: true }));
  await page.getByRole('button', { name: '取消部分时段', exact: true }).first().click();
  await page.getByLabel('取消原因 *', { exact: true }).fill('QA服务拒绝');
  await rejected('request.cancelPartial', page.getByRole('dialog').getByRole('button', { name: '确认取消所选时段', exact: true }));
  await page.getByRole('button', { name: '网站设置', exact: true }).click();
  await page.getByLabel('管理员登录邮箱', { exact: true }).fill('qa@example.test');
  await page.getByRole('button', { name: '新增管理员', exact: true }).click();
  await visibleFeedback(page, '.toast.error');
  assert.match(await page.getByRole('alert').innerText(), /admin.invite/);
  await page.waitForTimeout(4800);
  assert.equal(await page.locator('.toast.error').count(), 1);
  await page.getByLabel('关闭提示', { exact: true }).click();
  assert.deepEqual(errors, []);
  console.log('PASS: actual maintenance failures on bulk/single edits visible and sticky inside dialogs at desktop/mobile 150% font; persistent errors, retry/dismiss/close cleanup, atomic rejection and success feedback; delete/import/review/cancel/partial-cancel/global permission errors via mocked API.');
} finally { await browser.close(); }
