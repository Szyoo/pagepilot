import type { Page } from '@playwright/test';
import type { FakeBackend } from './fake-backend';
import { type ExtensionHelper, expect, fakeValue, TRUSTED_EXTENSION_DIR, test } from './fixtures';
import { inputRule } from './rules';

// 这组场景加载声明了调试权限的测试构建（见 wxt.config.ts 的 PAGEPILOT_E2E=trusted）
test.use({ extensionDir: TRUSTED_EXTENSION_DIR });

interface PageEvent {
  type: string;
  id: string;
  isTrusted: boolean;
  key?: string;
}

const eventsOf = (page: Page) =>
  page.evaluate(() => (window as unknown as { __events: PageEvent[] }).__events);
const clicksOf = (page: Page) =>
  page.evaluate(() => (window as unknown as { __clicks: { bump: number; go: number } }).__clicks);

async function runOnPage(
  ext: ExtensionHelper,
  backend: FakeBackend,
  page: Page,
  mode: 'trusted' | 'synthetic',
  text: string,
) {
  const rule = inputRule(backend.origin(), mode, text);
  const ruleId = String(rule.id);
  await ext.signIn();
  backend.pushRule(rule);
  await ext.waitForState((st) => st.rules.some((r) => r.id === ruleId), '收到规则');
  await ext.rpc('rule.approve', { ruleId });
  await ext.saveVault({});

  await page.goto(`${backend.origin()}/pages/trusted.html`);
  const tabId = await ext.tabIdOf(page);
  const { runId } = await ext.rpc('run.start', { ruleId, tabId });
  const run = await ext.waitForRun(
    runId,
    (r) => r.status !== 'running' && r.status !== 'handoff',
    '运行结束',
  );
  const report = await backend.received.waitFor('runReport', (m) => m.runId === runId);
  return { run, report };
}

test('inputMode 为 trusted 时页面收到 isTrusted 的点击与键盘事件，fill 写入输入框', async ({
  context,
  backend,
  ext,
}) => {
  const text = fakeValue('text');
  const page = await context.newPage();
  const { run, report } = await runOnPage(ext, backend, page, 'trusted', text);

  expect(run.errorCode, JSON.stringify(run)).toBeUndefined();
  expect(run.status).toBe('succeeded');
  expect(report.inputMode).toBe('trusted');

  await expect(page.locator('#field')).toHaveValue(text);
  expect(await clicksOf(page)).toEqual({ bump: 1, go: 1 });

  const events = await eventsOf(page);
  const kinds = (type: string, id: string) => events.filter((e) => e.type === type && e.id === id);
  expect(kinds('click', 'bump')).toHaveLength(1);
  expect(kinds('click', 'go')).toHaveLength(1);
  expect(kinds('input', 'field').length, 'fill 产生 input 事件').toBeGreaterThan(0);
  expect(
    kinds('keydown', 'field').some((e) => e.key === 'Enter'),
    '回车送达输入框',
  ).toBe(true);
  expect(
    events.filter((e) => !e.isTrusted),
    '所有事件都是 isTrusted',
  ).toEqual([]);
});

test('对照组：同一页面 inputMode 为 synthetic 时点击事件不是 isTrusted', async ({
  context,
  backend,
  ext,
}) => {
  const text = fakeValue('text');
  const page = await context.newPage();
  const { run, report } = await runOnPage(ext, backend, page, 'synthetic', text);

  expect(run.status).toBe('succeeded');
  expect(report.inputMode).toBe('synthetic');
  await expect(page.locator('#field')).toHaveValue(text);

  const clicks = (await eventsOf(page)).filter((e) => e.type === 'click');
  expect(clicks.map((e) => e.id)).toEqual(['bump', 'go']);
  expect(clicks.every((e) => !e.isTrusted)).toBe(true);
});
