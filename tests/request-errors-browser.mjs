import { chromium } from 'playwright';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const base = process.env.BASE_URL ?? 'http://127.0.0.1:5173';
const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy;
const browser = await chromium.launch({ headless: true, channel: 'chromium', args: ['--no-sandbox'],
  ...(proxy && !/^http:\/\/(127\.0\.0\.1|localhost)/.test(base) ? { proxy: { server: proxy } } : {}) });
const localDate = days => new Date(Date.now() + (days * 24 + 8) * 3600000).toISOString().slice(0, 10);
async function inView(page, selector) {
  await page.waitForFunction(selector => {
    const el = document.querySelector(selector), dialog = el?.closest('dialog');
    if (!el || !dialog) return false;
    const r = el.getBoundingClientRect(), d = dialog.getBoundingClientRect();
    return r.top >= Math.max(0, d.top) && r.bottom <= Math.min(innerHeight, d.bottom)
      && r.left >= 0 && r.right <= innerWidth;
  }, selector);
}
async function fillRequest(page) {
  await page.getByRole('button', { name: '申请资源', exact: true }).click();
  const d = page.getByRole('dialog');
  await d.locator('.resource-picker').getByRole('checkbox', { name: /Atlas-950-01/ }).check();
  await d.getByLabel('任务用途').fill('QA申请错误可见性');
  await d.getByLabel('开始时间 *', { exact: true }).fill(`${localDate(1)}T09:00`);
  await d.getByLabel('结束时间 *', { exact: true }).fill(`${localDate(1)}T19:00`);
  return d;
}
try {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 700 }]) {
    const page = await browser.newPage({ viewport });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(base + '/demo', { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForFunction(() => document.querySelector('[aria-label="演示角色"]')?.value === 'admin', {}, { timeout: 90000 });
    // Exercise a larger font along with the existing long, scrollable resource picker.
    await page.getByLabel('网页字号', { exact: true }).selectOption('150');
    const d = await fillRequest(page);
    const start = d.getByLabel('开始时间 *', { exact: true }), end = d.getByLabel('结束时间 *', { exact: true });
    const submit = d.getByRole('button', { name: '提交申请', exact: true });
    await end.fill(`${localDate(1)}T08:00`);
    await submit.click();
    await inView(page, '#request-end-error');
    assert.match(await d.locator('#request-end-error').innerText(), /结束时间必须晚于开始时间/);
    assert.equal(await end.getAttribute('aria-invalid'), 'true');
    assert.equal(await end.evaluate(el => el === document.activeElement), true);
    assert.equal(await start.inputValue(), `${localDate(1)}T09:00`);
    await page.waitForTimeout(4800); // The error must outlive the old toast timeout.
    assert.equal(await d.locator('#request-end-error').count(), 1);
    await page.screenshot({ path: `outputs/request-errors-${viewport.width}.png` });
    await end.fill(`${localDate(1)}T19:00`);
    assert.equal(await d.getByRole('alert').count(), 0);
    await start.fill(`${localDate(-1)}T09:00`);
    await submit.click();
    await inView(page, '#request-start-error');
    assert.match(await d.locator('#request-start-error').innerText(), /开始时间不能早于当前时间/);
    assert.equal(await start.evaluate(el => el === document.activeElement), true);
    assert.equal(await d.getByLabel('任务用途').inputValue(), 'QA申请错误可见性');
    assert.match(await d.getByRole('region', { name: '已选服务器', exact: true }).innerText(), /Atlas-950-01/);
    await start.fill(`${localDate(1)}T09:00`);
    await submit.click();
    await d.waitFor({ state: 'hidden' });
    assert.match(await page.getByRole('row').filter({ hasText: 'QA申请错误可见性' }).innerText(), /待审批/);
    assert.deepEqual(errors, []);
    await page.close();
  }
  // Mock only the API: verify that service and network failures use the real request UI.
  await build({ entryPoints: ['lib/demo.ts'], bundle: true, platform: 'node', format: 'esm', outfile: '.sites-runtime/tests/request-errors-demo.mjs' });
  const { demoState } = await import(pathToFileURL(process.cwd() + '/.sites-runtime/tests/request-errors-demo.mjs'));
  const state = { ...demoState(), demo: false };
  const page = await browser.newPage({ viewport: { width: 390, height: 700 } });
  await page.route('**/api/state', route => route.fulfill({ json: state }));
  let attempts = 0;
  await page.route('**/api/action', route => ++attempts === 1
    ? route.fulfill({ status: 409, json: { error: '资源已变更，请刷新后重新申请' } }) : route.abort('failed'));
  await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 90000 });
  const d = await fillRequest(page);
  await d.getByRole('button', { name: '提交申请', exact: true }).click();
  await inView(page, '.request-submit-error');
  assert.match(await d.getByRole('alert').innerText(), /资源已变更/);
  assert.equal(await d.getByRole('alert').evaluate(el => el === document.activeElement), true);
  await d.getByLabel('任务用途').fill('QA网络失败后保留申请');
  await d.getByRole('button', { name: '提交申请', exact: true }).click();
  await inView(page, '.request-submit-error');
  assert.match(await d.getByRole('alert').innerText(), /申请未提交/);
  assert.equal(await d.getByLabel('任务用途').inputValue(), 'QA网络失败后保留申请');
  assert.equal(attempts, 2);
  console.log('PASS: desktop/mobile enlarged-font time errors stay in dialog viewport, focus invalid field, persist and clear on edit, preserve form and allow retry; service/network errors appear and focus inside dialog (mock API).');
} finally { await browser.close(); }
