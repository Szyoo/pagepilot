/// <reference types="chrome" />
// 传给 page.evaluate 的函数在扩展页面里执行，可以使用 chrome.* API

import { expect, test } from './fixtures';
import { slowRule } from './rules';

interface PageClicks {
  __clicks: { bump: number; go: number };
  __events: { type: string; id: string; isTrusted: boolean }[];
}

test('service worker 在运行中途被终止后，从游标处继续并成功', async ({ context, backend, ext }) => {
  await ext.signIn();
  backend.pushRule(slowRule(backend.origin(), 6000));
  await ext.waitForState((st) => st.rules.some((r) => r.id === 'e2e-slow'), '收到规则');
  await ext.rpc('rule.approve', { ruleId: 'e2e-slow' });
  await ext.saveVault({});

  const page = await context.newPage();
  await page.goto(`${backend.origin()}/pages/trusted.html`);
  const tabId = await ext.tabIdOf(page);

  const before = await ext.worker();
  await before.evaluate(() => {
    (globalThis as { __e2eInstance?: string }).__e2eInstance = 'before-stop';
  });

  const { runId } = await ext.rpc('run.start', { ruleId: 'e2e-slow', tabId });
  await ext.waitForRun(runId, (r) => r.status === 'running' && r.stepId === 's2', '进入长等待');

  // 运行状态已落盘：游标停在第 2 步，第 1 步已完成
  const persisted = await ext.page.evaluate(async (id) => {
    const { runs } = (await chrome.storage.session.get('runs')) as {
      runs?: Record<string, { cursor: { i: number }[]; stepReports: { stepId: string }[] }>;
    };
    return runs?.[id];
  }, runId);
  expect(persisted?.cursor).toEqual([{ i: 1 }]);
  expect(persisted?.stepReports.map((r) => r.stepId)).toEqual(['s1']);

  await ext.stopWorker();

  // 任意 RPC 唤醒后台；新实例从 storage.session 恢复运行
  const run = await ext.waitForRun(
    runId,
    (r) => r.status === 'succeeded',
    '恢复后运行成功',
    30_000,
  );
  expect(run.errorCode).toBeUndefined();

  const after = await ext.worker();
  const instance = await after.evaluate(
    () => (globalThis as { __e2eInstance?: string }).__e2eInstance ?? 'fresh',
  );
  expect(instance, '后台确实被重新启动过').toBe('fresh');

  // 第 1 步没有被重复执行
  const clicks = await page.evaluate(() => (window as unknown as PageClicks).__clicks);
  expect(clicks).toEqual({ bump: 1, go: 1 });
  // 没有调试权限时使用合成输入，页面看到的是非 isTrusted 事件
  const events = await page.evaluate(() => (window as unknown as PageClicks).__events);
  expect(events.filter((e) => e.type === 'click').every((e) => !e.isTrusted)).toBe(true);

  const report = await backend.received.waitFor('runReport', (m) => m.runId === runId, 30_000);
  expect(report.status).toBe('succeeded');
  const steps = (report.steps as { stepId: string }[]).map((s) => s.stepId);
  expect(steps).toEqual(['s1', 's2', 's3', 's4']);
});
