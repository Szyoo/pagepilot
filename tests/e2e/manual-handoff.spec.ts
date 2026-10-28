import type { RawRule } from './fake-backend';
import { css, expect, test } from './fixtures';

/** 页面上一直有验证组件；规则自己写了交还步骤，前面的步骤不应被自动检测提前打断 */
function manualRule(origin: string): RawRule {
  return {
    id: 'e2e-manual-handoff',
    name: '测试规则自带交还',
    version: 1,
    match: { urls: [`${origin}/pages/captcha.html`] },
    steps: [
      { id: 's1', type: 'click', target: css('#go') },
      {
        id: 's2',
        type: 'handoff',
        message: '请输入图形验证码，输完点「继续」',
        resumeWhen: 'userConfirm',
      },
      { id: 's3', type: 'click', target: css('#go') },
    ],
  };
}

test('规则写了交还步骤时不做验证码自动检测，只在指定的那一步暂停', async ({
  backend,
  context,
  ext,
}) => {
  await ext.signIn();
  backend.pushRule(manualRule(backend.origin()));
  await ext.waitForState((s) => s.rules.some((r) => r.id === 'e2e-manual-handoff'), '收到规则');
  await ext.rpc('rule.approve', { ruleId: 'e2e-manual-handoff' });
  await ext.saveVault({});

  const page = await context.newPage();
  await page.goto(`${backend.origin()}/pages/captcha.html`);
  const tabId = await ext.tabIdOf(page);
  const { runId } = await ext.rpc('run.start', { ruleId: 'e2e-manual-handoff', tabId });

  // 第一步照常执行：页面上虽然有验证组件，但没有被自动检测提前暂停
  const run = await ext.waitForRun(runId, (r) => r.status === 'handoff', '在指定步骤暂停');
  expect(run.stepId).toBe('s2');
  expect(run.message).toBe('请输入图形验证码，输完点「继续」');
  const clicks = () =>
    page.evaluate(() => (window as unknown as { __goClicks: number }).__goClicks);
  expect(await clicks()).toBe(1);

  await ext.rpc('run.confirm', { runId });
  await ext.waitForRun(runId, (r) => r.status === 'succeeded', '继续后完成');
  expect(await clicks()).toBe(2);
});
