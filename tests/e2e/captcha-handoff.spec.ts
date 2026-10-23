import type { Page } from '@playwright/test';
import { type ExtensionHelper, expect, test } from './fixtures';
import { captchaRule } from './rules';

async function startOnCaptchaPage(page: Page, ext: ExtensionHelper, url: string) {
  await page.goto(url);
  const tabId = await ext.tabIdOf(page);
  const { runId } = await ext.rpc('run.start', { ruleId: 'e2e-captcha', tabId });
  const run = await ext.waitForRun(runId, (r) => r.status === 'handoff', '检测到验证组件后交还');
  expect(run.needsConfirm).toBe(true);
  expect(run.stepId).toBe('s1');
  // 交还期间不应继续操作页面
  expect(await page.evaluate(() => (window as unknown as { __goClicks: number }).__goClicks)).toBe(
    0,
  );
  return runId;
}

test.describe('验证码交还', () => {
  test.beforeEach(async ({ backend, ext }) => {
    await ext.signIn();
    backend.pushRule(captchaRule(backend.origin()));
    await ext.waitForState((st) => st.rules.some((r) => r.id === 'e2e-captcha'), '收到规则');
    await ext.rpc('rule.approve', { ruleId: 'e2e-captcha' });
    await ext.saveVault({});
  });

  test('验证组件消失后自动继续', async ({ context, backend, ext }) => {
    const page = await context.newPage();
    const runId = await startOnCaptchaPage(page, ext, `${backend.origin()}/pages/captcha.html`);

    await page.locator('#solve').click(); // 模拟用户完成验证
    const run = await ext.waitForRun(runId, (r) => r.status === 'succeeded', '继续并成功');
    expect(run.errorCode).toBeUndefined();
    await expect(page.locator('#result')).toHaveText('已提交');

    const report = await backend.received.waitFor('runReport', (m) => m.runId === runId);
    expect(report.status).toBe('succeeded');
  });

  test('用户点「继续」（run.confirm）后继续', async ({ context, backend, ext }) => {
    const page = await context.newPage();
    const runId = await startOnCaptchaPage(page, ext, `${backend.origin()}/pages/captcha.html`);

    await ext.rpc('run.confirm', { runId });
    const run = await ext.waitForRun(runId, (r) => r.status === 'succeeded', '继续并成功');
    expect(run.errorCode).toBeUndefined();
    await expect(page.locator('#result')).toHaveText('已提交');
    const report = await backend.received.waitFor('runReport', (m) => m.runId === runId);
    expect(report.status).toBe('succeeded');
  });
});
